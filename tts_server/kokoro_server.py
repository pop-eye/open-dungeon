#!/usr/bin/env python3
"""Resident Kokoro neural TTS server for Open Dungeon narration.

Loads the Kokoro-82M pipeline once and keeps it in VRAM/RAM, then synthesizes
speech on demand. Mirrors the optimized image server's conventions: a stdlib
HTTP server, verbose startup, a /health probe, and a resident model so each
request avoids the load penalty.

Endpoints:
  GET  /health      -> {"ok": true, "loaded": bool, "voices": [...]}
  GET  /voices      -> {"voices": [...]}
  POST /synthesize  -> audio/wav
        body: {"text": "...", "voice": "af_heart", "speed": 1.0}

Kokoro is Apache-2.0 and downloads weights from HuggingFace (hexgrad/Kokoro-82M)
on first use (~350 MB).
"""

from __future__ import annotations

import io
import json
import os
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("TTS_PORT", "7870"))
LANG_CODE = os.environ.get("KOKORO_LANG", "a")  # 'a' = American English
DEFAULT_VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
SAMPLE_RATE = 24_000

# A curated set of the best-sounding Kokoro voices for narration.
VOICES = [
    "af_heart",
    "af_bella",
    "af_nicole",
    "af_sarah",
    "am_michael",
    "am_adam",
    "am_fenrir",
    "bf_emma",
    "bf_isabella",
    "bm_george",
    "bm_fable",
]

_PIPELINE = None
_PIPELINE_LOCK = threading.Lock()
_LOAD_SECONDS: float | None = None
_DEVICE = "cpu"


def _resolve_device() -> str:
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def _load_pipeline():
    global _PIPELINE, _LOAD_SECONDS, _DEVICE
    if _PIPELINE is not None:
        return _PIPELINE

    with _PIPELINE_LOCK:
        if _PIPELINE is not None:
            return _PIPELINE

        _DEVICE = _resolve_device()
        print(f"[kokoro] loading Kokoro-82M pipeline on {_DEVICE} (lang={LANG_CODE})", flush=True)
        print("[kokoro] first run downloads weights from HuggingFace (~350 MB)", flush=True)
        start = time.time()

        from kokoro import KPipeline  # type: ignore[import]

        try:
            pipeline = KPipeline(lang_code=LANG_CODE, device=_DEVICE)
        except TypeError:
            # Older kokoro builds don't accept a device argument.
            pipeline = KPipeline(lang_code=LANG_CODE)

        _PIPELINE = pipeline
        _LOAD_SECONDS = time.time() - start
        print(f"[kokoro] pipeline ready in {_LOAD_SECONDS:.2f}s", flush=True)
        return _PIPELINE


def _synthesize_wav(text: str, voice: str, speed: float) -> bytes:
    import numpy as np

    pipeline = _load_pipeline()
    chunks: list = []
    for result in pipeline(text, voice=voice, speed=speed):
        # KPipeline yields (graphemes, phonemes, audio); audio is the 3rd item.
        audio = result[2] if isinstance(result, (tuple, list)) else result
        if hasattr(audio, "detach"):
            audio = audio.detach().cpu().numpy()
        chunks.append(np.asarray(audio, dtype=np.float32).reshape(-1))

    if not chunks:
        samples = np.zeros(0, dtype=np.float32)
    else:
        samples = np.concatenate(chunks)

    # float32 [-1, 1] -> int16 PCM WAV
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm.tobytes())
    return buffer.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print(f"[kokoro] {self.address_string()} - {fmt % args}", flush=True)

    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.rstrip("/") in ("/health", ""):
            self._json({"ok": True, "loaded": _PIPELINE is not None, "voices": VOICES, "device": _DEVICE})
        elif self.path.rstrip("/") == "/voices":
            self._json({"voices": VOICES, "default": DEFAULT_VOICE})
        else:
            self._json({"error": "not found"}, status=404)

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/synthesize":
            self._json({"error": "not found"}, status=404)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, TypeError):
            self._json({"error": "invalid JSON body"}, status=400)
            return

        text = str(payload.get("text") or "").strip()
        if not text:
            self._json({"error": "missing text"}, status=400)
            return

        voice = str(payload.get("voice") or DEFAULT_VOICE)
        if voice not in VOICES:
            voice = DEFAULT_VOICE
        try:
            speed = float(payload.get("speed") or 1.0)
        except (ValueError, TypeError):
            speed = 1.0
        speed = max(0.5, min(speed, 2.0))

        try:
            wav_bytes = _synthesize_wav(text, voice, speed)
        except Exception as error:
            import traceback

            print(f"[kokoro] synthesis failed: {error}", flush=True)
            print(traceback.format_exc(), flush=True)
            self._json({"error": f"synthesis failed: {error}"}, status=500)
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav_bytes)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(wav_bytes)


def main() -> int:
    print(f"Kokoro TTS server on http://{HOST}:{PORT}", flush=True)
    print(f"  voices : {', '.join(VOICES)}", flush=True)
    print(f"  default: {DEFAULT_VOICE}", flush=True)
    print(f"  device : {_resolve_device()}", flush=True)
    print("  NOTE: the model loads on the first /synthesize request (or set TTS_WARM=1)", flush=True)

    if os.environ.get("TTS_WARM") not in (None, "", "0", "false"):
        try:
            _load_pipeline()
        except Exception as error:
            print(f"[kokoro] warm load failed: {error}", flush=True)

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
