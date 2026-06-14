#!/usr/bin/env python3
"""ComfyUI-backed image server for Open Dungeon — Windows/CUDA path.

Exposes the same HTTP contract as optimized_image_server.py
(/generate, /warm, /health, /backends) but drives a local ComfyUI
instance instead of MFLUX/MLX.

Uses the same FLUX.2-klein weights and uncensored GGUF text encoder
as the Mac path, loaded through ComfyUI-GGUF — quality is preserved.

Prerequisites (see docs/windows.md for the full setup guide):
  1. ComfyUI installed and running (python main.py --listen 127.0.0.1 --port 8188)
  2. ComfyUI-GGUF custom nodes installed
  3. Model files placed in ComfyUI's model directories (or symlinked):
       models/unet/           ← FLUX.2-klein GGUF unet
       models/text_encoders/  ← uncensored T5 GGUF + CLIP-L
       models/vae/            ← FLUX VAE (ae.safetensors)

Environment variables (all optional, set in .env.local):
  COMFYUI_URL              ComfyUI base URL  (default: http://127.0.0.1:8188)
  COMFYUI_UNET_MODEL       GGUF unet filename (default: flux2-klein-4b-q4_k_m.gguf)
  COMFYUI_CLIP1_MODEL      Uncensored T5 GGUF (default: t5xxl_uncensored_q4_k_m.gguf)
  COMFYUI_CLIP2_MODEL      CLIP-L filename    (default: clip_l.safetensors)
  COMFYUI_VAE_MODEL        VAE filename       (default: ae.safetensors)
  IMAGE_SERVER_HOST        Bind host          (default: 127.0.0.1)
  IMAGE_SERVER_PORT        Bind port          (default: 7869)
  IMAGE_SERVER_TIMEOUT     Generation timeout (default: 240)
  IMAGE_SERVER_OUTPUT_DIR  Where to save PNGs (default: public/generated)
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import random
import re
import shutil
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any


APP_ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = Path(os.environ.get("IMAGE_SERVER_OUTPUT_DIR", str(APP_ROOT / "public/generated")))
HOST = os.environ.get("IMAGE_SERVER_HOST", "127.0.0.1")
PORT = int(os.environ.get("IMAGE_SERVER_PORT", "7869"))
DEFAULT_TIMEOUT = int(os.environ.get("IMAGE_SERVER_TIMEOUT", "240"))

COMFYUI_URL = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188").rstrip("/")

# Model filenames inside ComfyUI's model directories.
# Override these in .env.local if your files have different names.
UNET_MODEL = os.environ.get("COMFYUI_UNET_MODEL", "flux2-klein-4b-q4_k_m.gguf")
CLIP1_MODEL = os.environ.get("COMFYUI_CLIP1_MODEL", "t5xxl_uncensored_q4_k_m.gguf")
CLIP2_MODEL = os.environ.get("COMFYUI_CLIP2_MODEL", "clip_l.safetensors")
VAE_MODEL = os.environ.get("COMFYUI_VAE_MODEL", "ae.safetensors")

RUNTIME_LOCK = threading.Lock()
STATUS: dict[str, Any] = {
    "lastWarm": None,
    "lastGenerate": None,
}

BACKEND_ID = "comfyui-flux-gguf"
BACKEND_LABEL = "ComfyUI FLUX.2-klein GGUF (CUDA)"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Dimensions:
    width: int
    height: int
    aspect: str


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def read_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0"))
    if length <= 0:
        return {}
    return json.loads(handler.rfile.read(length).decode("utf-8"))


def clamp_int(value: Any, default: int, lower: int, upper: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(lower, min(upper, parsed))


def resolve_dimensions(payload: dict[str, Any]) -> Dimensions:
    aspect = payload.get("aspect")
    if aspect not in ("square", "portrait", "landscape"):
        aspect = "square"

    if payload.get("width") and payload.get("height"):
        return Dimensions(
            width=clamp_int(payload.get("width"), 1024, 256, 2048),
            height=clamp_int(payload.get("height"), 1024, 256, 2048),
            aspect=aspect,
        )

    mode = payload.get("mode")
    long_side = 2048 if mode == "slow" else 1024

    if aspect == "portrait":
        return Dimensions(width=round(long_side * 0.75), height=long_side, aspect=aspect)
    if aspect == "landscape":
        return Dimensions(width=long_side, height=round(long_side * 0.75), aspect=aspect)
    return Dimensions(width=long_side, height=long_side, aspect=aspect)


def slug(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "-", value.strip().lower()).strip("-")
    return cleaned[:42] or "image"


# ---------------------------------------------------------------------------
# ComfyUI REST client
# ---------------------------------------------------------------------------

def comfyui_get(path: str, timeout: int = 10) -> Any:
    url = f"{COMFYUI_URL}{path}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def comfyui_post_json(path: str, payload: dict[str, Any], timeout: int = 10) -> Any:
    url = f"{COMFYUI_URL}{path}"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def comfyui_upload_image(image_bytes: bytes, filename: str) -> str:
    """Upload an image to ComfyUI's input folder. Returns the ComfyUI filename."""
    boundary = uuid.uuid4().hex
    body_parts: list[bytes] = []
    body_parts.append(
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'
        f"Content-Type: image/png\r\n\r\n".encode()
    )
    body_parts.append(image_bytes)
    body_parts.append(f"\r\n--{boundary}--\r\n".encode())
    body = b"".join(body_parts)

    url = f"{COMFYUI_URL}/upload/image"
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    return result["name"]


def comfyui_fetch_image(filename: str, subfolder: str = "", image_type: str = "output") -> bytes:
    params = urllib.parse.urlencode({
        "filename": filename,
        "subfolder": subfolder,
        "type": image_type,
    })
    url = f"{COMFYUI_URL}/view?{params}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def comfyui_is_reachable() -> bool:
    try:
        comfyui_get("/system_stats", timeout=3)
        return True
    except Exception:
        return False


def comfyui_queue_prompt(workflow: dict[str, Any], client_id: str) -> str:
    """Queue a workflow and return the prompt_id."""
    result = comfyui_post_json("/prompt", {"prompt": workflow, "client_id": client_id})
    return result["prompt_id"]


def comfyui_wait_for_result(
    prompt_id: str, timeout: int
) -> tuple[str, str]:
    """Poll /history until the prompt completes. Returns (filename, subfolder)."""
    deadline = time.time() + timeout
    poll_interval = 1.0
    while time.time() < deadline:
        try:
            history = comfyui_get(f"/history/{prompt_id}", timeout=10)
        except Exception:
            time.sleep(poll_interval)
            continue

        if prompt_id not in history:
            time.sleep(poll_interval)
            continue

        entry = history[prompt_id]
        status = entry.get("status", {})

        if status.get("status_str") == "error":
            messages = status.get("messages", [])
            detail = "; ".join(str(m) for m in messages) if messages else "unknown error"
            raise RuntimeError(f"ComfyUI generation failed: {detail}")

        outputs = entry.get("outputs", {})
        for node_output in outputs.values():
            images = node_output.get("images", [])
            if images:
                img = images[0]
                return img["filename"], img.get("subfolder", "")

        time.sleep(poll_interval)

    raise TimeoutError(f"ComfyUI generation timed out after {timeout}s")


# ---------------------------------------------------------------------------
# Workflow builders
# ---------------------------------------------------------------------------

def _base_nodes(
    prompt_text: str,
    dimensions: Dimensions,
    steps: int,
    cfg: float,
    seed: int,
    filename_prefix: str,
) -> dict[str, Any]:
    """Core workflow nodes shared by txt2img and img2img."""
    return {
        "10": {
            "class_type": "UnetLoaderGGUF",
            "inputs": {"unet_name": UNET_MODEL},
        },
        "20": {
            "class_type": "DualCLIPLoaderGGUF",
            "inputs": {
                "clip_name1": CLIP1_MODEL,
                "clip_name2": CLIP2_MODEL,
                "type": "flux",
            },
        },
        "30": {
            "class_type": "CLIPTextEncode",
            "inputs": {"clip": ["20", 0], "text": prompt_text},
        },
        "31": {
            "class_type": "CLIPTextEncode",
            "inputs": {"clip": ["20", 0], "text": ""},
        },
        "60": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["10", 0],
                "positive": ["30", 0],
                "negative": ["31", 0],
                "latent_image": ["50", 0],  # node "50" provided by callers
                "seed": seed,
                "steps": steps,
                "cfg": cfg if cfg > 0 else 1.0,
                "sampler_name": "euler",
                "scheduler": "simple",
                "denoise": ["__DENOISE__"],  # replaced by callers
            },
        },
        "70": {
            "class_type": "VAELoader",
            "inputs": {"vae_name": VAE_MODEL},
        },
        "80": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["60", 0], "vae": ["70", 0]},
        },
        "90": {
            "class_type": "SaveImage",
            "inputs": {"images": ["80", 0], "filename_prefix": filename_prefix},
        },
    }


def build_txt2img_workflow(
    prompt_text: str,
    dimensions: Dimensions,
    steps: int,
    cfg: float,
    seed: int,
    filename_prefix: str,
) -> dict[str, Any]:
    nodes = _base_nodes(prompt_text, dimensions, steps, cfg, seed, filename_prefix)
    nodes["50"] = {
        "class_type": "EmptyLatentImage",
        "inputs": {
            "width": dimensions.width,
            "height": dimensions.height,
            "batch_size": 1,
        },
    }
    nodes["60"]["inputs"]["denoise"] = 1.0
    return nodes


def build_img2img_workflow(
    prompt_text: str,
    dimensions: Dimensions,
    steps: int,
    cfg: float,
    seed: int,
    filename_prefix: str,
    reference_comfyui_name: str,
    denoise: float = 0.75,
) -> dict[str, Any]:
    """Img2img workflow using a reference image uploaded to ComfyUI."""
    nodes = _base_nodes(prompt_text, dimensions, steps, cfg, seed, filename_prefix)
    # Load reference, resize to target dimensions, then encode to latent
    nodes["40"] = {
        "class_type": "LoadImage",
        "inputs": {"image": reference_comfyui_name, "upload": "image"},
    }
    nodes["41"] = {
        "class_type": "ImageScale",
        "inputs": {
            "image": ["40", 0],
            "upscale_method": "lanczos",
            "width": dimensions.width,
            "height": dimensions.height,
            "crop": "center",
        },
    }
    nodes["50"] = {
        "class_type": "VAEEncode",
        "inputs": {"pixels": ["41", 0], "vae": ["70", 0]},
    }
    nodes["60"]["inputs"]["denoise"] = denoise
    return nodes


# ---------------------------------------------------------------------------
# Reference image preparation
# ---------------------------------------------------------------------------

def prepare_reference(references: list[dict[str, Any]], image_id: str) -> str | None:
    """Upload the first usable reference image to ComfyUI. Returns ComfyUI filename or None."""
    for index, reference in enumerate(references[:2], start=1):
        data_url = str(reference.get("dataUrl") or "")
        url = str(reference.get("url") or "")

        image_bytes: bytes | None = None

        if data_url.startswith("data:image/"):
            header, _, encoded = data_url.partition(",")
            if encoded:
                try:
                    image_bytes = base64.b64decode(encoded)
                except Exception:
                    continue

        elif url.startswith("/uploads/"):
            local_path = APP_ROOT / "public" / url.lstrip("/")
            if local_path.exists():
                image_bytes = local_path.read_bytes()

        if image_bytes is not None:
            filename = f"od-ref-{image_id}-{index}.png"
            try:
                comfyui_name = comfyui_upload_image(image_bytes, filename)
                return comfyui_name
            except Exception as exc:
                print(f"[comfyui] Failed to upload reference image {index}: {exc}", flush=True)
                continue

    return None


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------

def run_generation(payload: dict[str, Any]) -> dict[str, Any]:
    backend = payload.get("backend") or BACKEND_ID
    if backend not in (BACKEND_ID, "mflux-hs", "sdnq-hs"):
        # Accept old backend IDs transparently — caller may not know about OS swap
        pass

    prompt_text = str(payload.get("prompt") or "").strip()
    if not prompt_text:
        raise ValueError("Missing prompt.")

    if not comfyui_is_reachable():
        raise RuntimeError(
            f"ComfyUI is not reachable at {COMFYUI_URL}. "
            "Start it first: python ComfyUI/main.py --listen 127.0.0.1 --port 8188"
        )

    dimensions = resolve_dimensions(payload)
    steps = clamp_int(payload.get("steps"), 4, 1, 8)
    cfg = float(payload.get("guidance", 0.0) or 0.0)
    seed = clamp_int(payload.get("seed"), random.randint(1, 2**31 - 1), 1, 2**32 - 1)
    timeout = clamp_int(payload.get("timeout"), DEFAULT_TIMEOUT, 30, 1200)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    image_id = f"{int(time.time())}-{seed}-comfyui-{slug(prompt_text)}"
    filename_prefix = f"open-dungeon/{image_id}"

    references = payload.get("references") or []
    reference_comfyui_name = prepare_reference(references, image_id) if references else None
    warnings: list[str] = []
    if references and not reference_comfyui_name:
        warnings.append("No usable reference images could be uploaded to ComfyUI.")

    if reference_comfyui_name:
        workflow = build_img2img_workflow(
            prompt_text=prompt_text,
            dimensions=dimensions,
            steps=steps,
            cfg=cfg,
            seed=seed,
            filename_prefix=filename_prefix,
            reference_comfyui_name=reference_comfyui_name,
        )
    else:
        workflow = build_txt2img_workflow(
            prompt_text=prompt_text,
            dimensions=dimensions,
            steps=steps,
            cfg=cfg,
            seed=seed,
            filename_prefix=filename_prefix,
        )

    client_id = str(uuid.uuid4())
    start = time.time()
    prompt_id = comfyui_queue_prompt(workflow, client_id)
    print(f"[comfyui] Queued prompt {prompt_id}", flush=True)

    comfy_filename, comfy_subfolder = comfyui_wait_for_result(prompt_id, timeout)
    elapsed = time.time() - start

    # Copy from ComfyUI's output directory to our public/generated
    image_bytes = comfyui_fetch_image(comfy_filename, comfy_subfolder)
    output_filename = f"{image_id}.png"
    output_path = OUT_DIR / output_filename
    output_path.write_bytes(image_bytes)

    return {
        "id": image_id,
        "url": f"/generated/{output_filename}",
        "prompt": prompt_text,
        "mode": "slow" if payload.get("mode") == "slow" else "fast",
        "backend": BACKEND_ID,
        "aspect": dimensions.aspect,
        "width": dimensions.width,
        "height": dimensions.height,
        "steps": steps,
        "guidance": cfg,
        "elapsedSeconds": round(elapsed, 2),
        "seed": seed,
        "resident": False,
        "residentMeta": {},
        "warnings": warnings,
        "logTail": "",
    }


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "OpenDungeonComfyUIImageServer/1.0"

    def do_GET(self) -> None:
        path = urllib.parse.urlparse(self.path).path

        if path == "/health":
            reachable = comfyui_is_reachable()
            json_response(
                self,
                200,
                {
                    "ok": reachable,
                    "loaded": reachable,  # ComfyUI loads models on first use
                    "backend": BACKEND_ID,
                    "comfyuiUrl": COMFYUI_URL,
                    "models": {
                        "unet": UNET_MODEL,
                        "clip1": CLIP1_MODEL,
                        "clip2": CLIP2_MODEL,
                        "vae": VAE_MODEL,
                    },
                    "warmed": STATUS["lastWarm"],
                },
            )
            return

        if path == "/backends":
            json_response(
                self,
                200,
                {
                    "backends": [
                        {
                            "id": BACKEND_ID,
                            "label": BACKEND_LABEL,
                            "model": UNET_MODEL,
                            "referenceLimit": 1,
                        }
                    ],
                    "aspects": ["square", "portrait", "landscape"],
                    "defaults": {"longSide": 1024, "steps": 4, "guidance": 0.0},
                    "sizes": [
                        {"mode": "fast", "longSide": 1024},
                        {"mode": "slow", "longSide": 2048},
                    ],
                    "warmNote": "ComfyUI loads models into VRAM on the first generation.",
                },
            )
            return

        json_response(self, 404, {"error": "Not found."})

    def do_POST(self) -> None:
        path = urllib.parse.urlparse(self.path).path
        if path not in ("/generate", "/warm"):
            json_response(self, 404, {"error": "Not found."})
            return

        try:
            payload = read_json(self)
            if path == "/warm":
                payload = {
                    "backend": BACKEND_ID,
                    "prompt": payload.get("prompt")
                    or "warmup image, simple portrait lighting, detailed face",
                    "width": int(payload.get("width") or 512),
                    "height": int(payload.get("height") or 512),
                    "steps": int(payload.get("steps") or 4),
                    "guidance": 0.0,
                    "seed": int(payload.get("seed") or 1234),
                    "timeout": int(payload.get("timeout") or DEFAULT_TIMEOUT),
                    "mode": "fast",
                    "aspect": payload.get("aspect") or "square",
                }
            with RUNTIME_LOCK:
                result = run_generation(payload)
            if path == "/warm":
                STATUS["lastWarm"] = {
                    "backend": result["backend"],
                    "elapsedSeconds": result["elapsedSeconds"],
                    "width": result["width"],
                    "height": result["height"],
                    "seed": result["seed"],
                }
                result["warmNote"] = "ComfyUI model is now warm in VRAM."
            else:
                STATUS["lastGenerate"] = {
                    "backend": result["backend"],
                    "elapsedSeconds": result["elapsedSeconds"],
                    "width": result["width"],
                    "height": result["height"],
                    "seed": result["seed"],
                }
            json_response(self, 200, result)
        except Exception as error:
            json_response(
                self,
                500,
                {
                    "error": "ComfyUI image generation failed.",
                    "detail": str(error)[-4000:],
                },
            )

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[comfyui-image-server] {self.address_string()} - {fmt % args}", flush=True)


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(
        f"ComfyUI image server on http://{HOST}:{PORT} "
        f"(comfyui={COMFYUI_URL}, unet={UNET_MODEL})",
        flush=True,
    )
    if not comfyui_is_reachable():
        print(
            f"[comfyui] WARNING: ComfyUI is not reachable at {COMFYUI_URL}. "
            "Start ComfyUI before generating images.",
            flush=True,
        )
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
