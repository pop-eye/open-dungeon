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


def _load_pipeline(*, quant: str = "q4_k_m") -> None:
    """Load the uncensored FLUX.2-klein SDNQ pipeline once and keep it resident.

    Reuses ultra-fast-image-gen's own loader (loaders.py) — the exact code path
    the CLI uses — so the pipeline assembles identically (SDNQ transformer + VAE +
    uncensored GGUF Qwen3 text encoder) and stays in VRAM between requests.
    """
    global _PIPELINE, _PIPELINE_KEY, LOAD_SECONDS

    pipeline_key = (DEVICE, quant)
    if _PIPELINE is not None and _PIPELINE_KEY == pipeline_key:
        return

    if _PIPELINE is not None:
        _PIPELINE = None
        _PIPELINE_KEY = None
        _clear_cache()

    print(f"[sdnq-resident] loading pipeline on {DEVICE} (quant={quant})", file=sys.stderr, flush=True)
    print(f"[sdnq-resident] HF token present: {bool(_hf_token())}", file=sys.stderr, flush=True)
    print(f"[sdnq-resident] If models are not cached, expect a 7-10 GB download (10-30 min)", file=sys.stderr, flush=True)
    start = time.time()

    from loaders import load_flux2_klein_uncensored_pipeline  # type: ignore[import]
    pipeline = load_flux2_klein_uncensored_pipeline(DEVICE, quant=quant)

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

    prompt = str(payload["prompt"])
    width = int(payload.get("width") or 1024)
    height = int(payload.get("height") or 1024)
    steps = int(payload.get("steps") or 4)
    seed = int(payload.get("seed") or 1234)
    guidance = float(payload.get("guidance") or 0.0)
    quant = str(payload.get("gguf_quant") or "q4_k_m")
    output_path = Path(payload["output_path"])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image_paths = [Path(p) for p in (payload.get("image_paths") or []) if Path(p).exists()][:2]

    _load_pipeline(quant=quant)
    assert _PIPELINE is not None

    import torch
    from flux2_sdnq_hs import (  # type: ignore[import]
        Flux2SdnqHsConfig,
        install_flux2_sdnq_hs_optimizations,
        reset_flux2_sdnq_hs_state,
    )

    start = time.time()

    # Mirror generate.py's sdnq-hs config (CLI uses these exact values).
    cfg = Flux2SdnqHsConfig.for_steps(
        steps,
        qchunk=1024,
        hs_stride=2,
        hs_skip_transformer_forwards=0,
        hs_max_transformer_forward=max(0, steps - 1),
        hs_single_start_frac=0.0,
        hs_single_end_frac=1.0,
        verbose=False,
    )
    install_flux2_sdnq_hs_optimizations(_PIPELINE, cfg)
    reset_flux2_sdnq_hs_state(_PIPELINE)

    gen_device = "cpu" if DEVICE == "mps" else DEVICE
    generator = torch.Generator(device=gen_device).manual_seed(seed)

    input_images = []
    if image_paths:
        import PIL.Image
        input_images = [
            PIL.Image.open(str(p)).convert("RGB").resize((width, height))
            for p in image_paths
        ]

    with torch.inference_mode():
        if input_images:
            result = _PIPELINE(
                prompt=prompt,
                image=input_images[0] if len(input_images) == 1 else input_images,
                height=height,
                width=width,
                num_inference_steps=steps,
                guidance_scale=guidance,
                generator=generator,
            )
        else:
            result = _PIPELINE(
                prompt=prompt,
                height=height,
                width=width,
                num_inference_steps=steps,
                guidance_scale=guidance,
                generator=generator,
            )

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
        "generationKind": "img2img" if input_images else "txt2img",
        "referenceCount": len(input_images),
        "device": DEVICE,
        **_memory_stats(),
    }


# ── action dispatcher ─────────────────────────────────────────────────────────

def _handle(payload: dict[str, Any]) -> dict[str, Any]:
    action = payload.get("action")
    if action == "load":
        quant = str(payload.get("gguf_quant") or "q4_k_m")
        _load_pipeline(quant=quant)
        return {
            "loaded": True,
            "loadSeconds": round(LOAD_SECONDS or 0, 2),
            "generations": GENERATIONS,
            "device": DEVICE,
            **_memory_stats(),
        }
    if action == "generate":
        return _generate(payload)
    raise ValueError(f"unknown action: {action!r}")


# ── main loop ─────────────────────────────────────────────────────────────────

def main() -> int:
    # Reserve the real stdout exclusively for the JSON-line IPC protocol. The
    # diffusers/transformers loaders and HS optimizations print progress to
    # stdout; if any of that reached the parent it would be misread as a
    # protocol response, raising on the server side and triggering a wasteful
    # CLI fallback. Redirect everything else to stderr.
    proto_out = sys.stdout
    sys.stdout = sys.stderr

    def _respond(obj: dict[str, Any]) -> None:
        proto_out.write(json.dumps(obj) + "\n")
        proto_out.flush()

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

        _respond(response)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
