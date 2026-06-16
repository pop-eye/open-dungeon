#!/usr/bin/env python3
"""Resident PyTorch SDNQ-HS uncensored FLUX.2-klein worker.

Launched by optimized_image_server.py using the ultra-fast-image-gen venv Python.
Keeps the FluxPipeline and the uncensored GGUF text encoder in VRAM/RAM across
requests so we avoid the 10-30s PyTorch model-load penalty on every generation.

IPC: JSON-line messages on stdin/stdout, same protocol as mflux_resident_worker.py.
  Request:  {"id": "<uuid>", "action": "generate"|"load", ...params}
  Response: {"id": "<uuid>", "ok": true, ...result}
           {"id": "<uuid>", "ok": false, "error": "...", "traceback": "..."}
"""

from __future__ import annotations

import gc
import json
import os
from pathlib import Path
import sys
import time
import traceback
from typing import Any


# ── env defaults ──────────────────────────────────────────────────────────────

def _configure_env() -> None:
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


_configure_env()

# ── globals ───────────────────────────────────────────────────────────────────

_IS_WINDOWS = sys.platform == "win32"

ULTRA_REPO = Path(
    os.environ.get("ULTRA_FAST_IMAGE_GEN_DIR", str(Path.home() / "ultra-fast-image-gen"))
).expanduser()

# The ultra-fast-image-gen repo root must be on sys.path so we can import its modules.
if str(ULTRA_REPO) not in sys.path:
    sys.path.insert(0, str(ULTRA_REPO))

DEVICE: str = os.environ.get("SDNQ_DEVICE", "cuda" if _IS_WINDOWS else "mps")
GENERATIONS: int = 0
LOAD_SECONDS: float | None = None

# Loaded pipeline object (kept alive between requests)
_PIPELINE: Any = None
_PIPELINE_KEY: tuple[str, str] | None = None  # (model_id, gguf_filename)


# ── memory helpers ────────────────────────────────────────────────────────────

def _memory_stats() -> dict[str, float]:
    stats: dict[str, float] = {}
    try:
        import torch
        if torch.cuda.is_available():
            stats["cudaAllocGb"] = round(torch.cuda.memory_allocated() / 1e9, 2)
            stats["cudaReservedGb"] = round(torch.cuda.memory_reserved() / 1e9, 2)
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            # MPS doesn't expose detailed stats via public API
            stats["device"] = "mps"
    except Exception:
        pass
    return stats


def _clear_cache() -> None:
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    gc.collect()


# ── pipeline loading ──────────────────────────────────────────────────────────

def _hf_token() -> str | None:
    """Read HF_TOKEN from env or ultra-fast-image-gen/.env."""
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if token:
        return token
    env_path = ULTRA_REPO / ".env"
    if env_path.exists():
        try:
            for line in env_path.read_text().splitlines():
                key, sep, value = line.strip().partition("=")
                if sep and key in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN") and value:
                    return value
        except OSError:
            pass
    return None


def _gguf_filename(gguf_variant: str) -> str:
    if gguf_variant == "9b":
        return "flux2-klein-9b-uncensored-q4_k_m.gguf"
    return "flux2-klein-4b-uncensored-q4_k_m.gguf"


def _gguf_repo(gguf_variant: str) -> str:
    if gguf_variant == "9b":
        return "ponpoke/flux2-klein-9b-uncensored-text-encoder"
    return "ponpoke/flux2-klein-4b-uncensored-text-encoder"


def _load_pipeline(*, model_id: str = "black-forest-labs/FLUX.2-klein-4B",
                   gguf_variant: str = "4b") -> None:
    global _PIPELINE, _PIPELINE_KEY, LOAD_SECONDS

    pipeline_key = (model_id, gguf_variant)
    if _PIPELINE is not None and _PIPELINE_KEY == pipeline_key:
        return

    if _PIPELINE is not None:
        _PIPELINE = None
        _PIPELINE_KEY = None
        _clear_cache()

    token = _hf_token()
    gguf_file = _gguf_filename(gguf_variant)
    gguf_repo = _gguf_repo(gguf_variant)

    print(f"[sdnq-resident] loading pipeline {model_id} on {DEVICE}", file=sys.stderr, flush=True)
    print(f"[sdnq-resident] GGUF encoder: {gguf_repo}/{gguf_file}", file=sys.stderr, flush=True)
    print(f"[sdnq-resident] HF token present: {bool(token)}", file=sys.stderr, flush=True)
    print(f"[sdnq-resident] If models are not cached, expect a 7-10 GB download — this can take 10-30 min", file=sys.stderr, flush=True)
    start = time.time()

    try:
        # Try importing ultra-fast-image-gen's sdnq backend directly.
        # This mirrors how the mflux resident imports from the mflux checkout.
        from sdnq_pipeline import build_pipeline  # type: ignore[import]
        pipeline = build_pipeline(
            model_id=model_id,
            device=DEVICE,
            gguf_file=gguf_file,
            gguf_repo=gguf_repo,
            hf_token=token,
        )
    except ImportError:
        # Fallback: use diffusers FluxPipeline with SDNQ/GGUF text encoder via
        # the ultra-fast-image-gen optimized loader, if available.
        try:
            from optimized_pipeline import build_sdnq_pipeline  # type: ignore[import]
            pipeline = build_sdnq_pipeline(
                model_id=model_id,
                device=DEVICE,
                gguf_file=gguf_file,
                gguf_repo=gguf_repo,
                hf_token=token,
            )
        except ImportError:
            # Last resort: standard diffusers FluxPipeline with bfloat16.
            # This still keeps the model in VRAM between requests and avoids reload.
            import torch
            from diffusers import FluxPipeline  # type: ignore[import]
            dtype = torch.bfloat16
            pipeline = FluxPipeline.from_pretrained(
                model_id,
                torch_dtype=dtype,
                token=token,
            )
            pipeline = pipeline.to(DEVICE)

    LOAD_SECONDS = time.time() - start
    _PIPELINE = pipeline
    _PIPELINE_KEY = pipeline_key
    _clear_cache()
    print(
        f"[sdnq-resident] pipeline ready in {LOAD_SECONDS:.2f}s, memory={_memory_stats()}",
        file=sys.stderr,
        flush=True,
    )


# ── generation ────────────────────────────────────────────────────────────────

def _generate(payload: dict[str, Any]) -> dict[str, Any]:
    global GENERATIONS

    model_id = str(payload.get("model_id") or "black-forest-labs/FLUX.2-klein-4B")
    gguf_variant = str(payload.get("gguf_variant") or "4b")
    prompt = str(payload["prompt"])
    width = int(payload.get("width") or 1024)
    height = int(payload.get("height") or 1024)
    steps = int(payload.get("steps") or 4)
    seed = int(payload.get("seed") or 1234)
    guidance = float(payload.get("guidance") or 0.0)
    output_path = Path(payload["output_path"])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image_paths = [Path(p) for p in (payload.get("image_paths") or [])][:2]

    _load_pipeline(model_id=model_id, gguf_variant=gguf_variant)
    assert _PIPELINE is not None

    start = time.time()

    import torch
    generator = torch.Generator(device=DEVICE).manual_seed(seed)

    gen_kwargs: dict[str, Any] = dict(
        prompt=prompt,
        width=width,
        height=height,
        num_inference_steps=steps,
        generator=generator,
        output_type="pil",
    )
    # guidance_scale=0 means distilled/CFG-free; pass only when non-zero
    if guidance > 0:
        gen_kwargs["guidance_scale"] = guidance

    # img2img path: pass reference images if the pipeline supports it
    if image_paths and hasattr(_PIPELINE, "image"):
        import PIL.Image
        ref_images = [PIL.Image.open(str(p)).convert("RGB") for p in image_paths if p.exists()]
        if ref_images:
            gen_kwargs["image"] = ref_images[0] if len(ref_images) == 1 else ref_images
            gen_kwargs["strength"] = 0.75

    result = _PIPELINE(**gen_kwargs)
    pil_image = result.images[0]
    pil_image.save(str(output_path))

    elapsed = time.time() - start
    GENERATIONS += 1

    _clear_cache()

    return {
        "output_path": str(output_path),
        "elapsedSeconds": round(elapsed, 2),
        "loadSeconds": round(LOAD_SECONDS or 0, 2),
        "generations": GENERATIONS,
        "generationKind": "img2img" if image_paths else "txt2img",
        "referenceCount": len(image_paths),
        "modelId": model_id,
        "ggufVariant": gguf_variant,
        "device": DEVICE,
        **_memory_stats(),
    }


# ── action dispatcher ─────────────────────────────────────────────────────────

def _handle(payload: dict[str, Any]) -> dict[str, Any]:
    action = payload.get("action")
    if action == "load":
        model_id = str(payload.get("model_id") or "black-forest-labs/FLUX.2-klein-4B")
        gguf_variant = str(payload.get("gguf_variant") or "4b")
        _load_pipeline(model_id=model_id, gguf_variant=gguf_variant)
        return {
            "loaded": True,
            "loadSeconds": round(LOAD_SECONDS or 0, 2),
            "generations": GENERATIONS,
            "modelId": model_id,
            "ggufVariant": gguf_variant,
            "device": DEVICE,
            **_memory_stats(),
        }
    if action == "generate":
        return _generate(payload)
    raise ValueError(f"unknown action: {action!r}")


# ── main loop ─────────────────────────────────────────────────────────────────

def main() -> int:
    print("[sdnq-resident] ready", file=sys.stderr, flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        request_id: str | None = None
        try:
            payload = json.loads(line)
            request_id = payload.get("id")
            result = _handle(payload)
            response: dict[str, Any] = {"id": request_id, "ok": True, **result}
        except Exception as exc:
            response = {
                "id": request_id,
                "ok": False,
                "error": str(exc),
                "traceback": traceback.format_exc()[-4000:],
            }

        print(json.dumps(response), flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
