#!/usr/bin/env python3
"""Optional InsightFace face-swap post-processing for Open Dungeon.

After a scene image is generated, this swaps each character's canonical face
(from their saved design portrait) onto the matching face in the scene. FLUX
references keep the general look consistent; this locks the *face* hard, which
is what the eye tracks for "is this the same person".

Everything here degrades gracefully: if insightface / onnxruntime / the model
weights are missing, swapping is skipped and the original image is kept. The
caller decides whether to surface that as a warning.

Models (downloaded once to ~/.insightface or INSIGHTFACE_HOME):
  - buffalo_l    : face detection + recognition (FaceAnalysis)
  - inswapper_128: the swapper itself (place inswapper_128.onnx in the models dir)

Enable with FACE_SWAP_ENABLED=1. Tune the detector size with
FACE_SWAP_DET_SIZE (default 640).
"""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path
from typing import Any

_LOCK = threading.Lock()
_ANALYZER: Any = None
_SWAPPER: Any = None
_LOAD_ERROR: str | None = None
_LOADED = False


def is_enabled() -> bool:
    return os.environ.get("FACE_SWAP_ENABLED", "").lower() not in ("", "0", "false", "no")


def _log(msg: str) -> None:
    print(f"[face-swap] {msg}", file=sys.stderr, flush=True)


def _swapper_model_path() -> str | None:
    """Locate inswapper_128.onnx. Honor FACE_SWAP_MODEL, else common locations."""
    explicit = os.environ.get("FACE_SWAP_MODEL")
    if explicit and Path(explicit).exists():
        return explicit

    home = Path(os.environ.get("INSIGHTFACE_HOME", str(Path.home() / ".insightface")))
    candidates = [
        home / "models" / "inswapper_128.onnx",
        Path.home() / ".insightface" / "models" / "inswapper_128.onnx",
        Path(__file__).resolve().parent / "models" / "inswapper_128.onnx",
    ]
    for path in candidates:
        if path.exists():
            return str(path)
    return None


def _providers() -> list[str]:
    """Prefer CUDA, fall back to CPU. onnxruntime ignores unavailable ones."""
    try:
        import onnxruntime  # type: ignore[import]

        available = set(onnxruntime.get_available_providers())
    except Exception:
        available = set()

    ordered = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    chosen = [p for p in ordered if p in available]
    return chosen or ["CPUExecutionProvider"]


def _ensure_loaded() -> bool:
    """Lazy-load detector + swapper once. Returns True if usable."""
    global _ANALYZER, _SWAPPER, _LOAD_ERROR, _LOADED
    if _LOADED:
        return _SWAPPER is not None

    with _LOCK:
        if _LOADED:
            return _SWAPPER is not None
        _LOADED = True

        model_path = _swapper_model_path()
        if not model_path:
            _LOAD_ERROR = (
                "inswapper_128.onnx not found. Download it into "
                "~/.insightface/models/ or set FACE_SWAP_MODEL."
            )
            _log(_LOAD_ERROR)
            return False

        try:
            from insightface.app import FaceAnalysis  # type: ignore[import]
            from insightface.model_zoo import get_model  # type: ignore[import]

            providers = _providers()
            det_size = int(os.environ.get("FACE_SWAP_DET_SIZE", "640"))
            _log(f"loading buffalo_l + inswapper on {providers}")

            analyzer = FaceAnalysis(name="buffalo_l", providers=providers)
            analyzer.prepare(ctx_id=0, det_size=(det_size, det_size))

            swapper = get_model(model_path, providers=providers)

            _ANALYZER = analyzer
            _SWAPPER = swapper
            _log("ready")
            return True
        except Exception as exc:  # noqa: BLE001 - degrade gracefully
            _LOAD_ERROR = f"face-swap load failed: {exc}"
            _log(_LOAD_ERROR)
            _ANALYZER = None
            _SWAPPER = None
            return False


def _largest_face(faces: list[Any]) -> Any | None:
    if not faces:
        return None
    return max(
        faces,
        key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]),
    )


def _source_face(path: Path) -> Any | None:
    import cv2  # type: ignore[import]

    img = cv2.imread(str(path))
    if img is None:
        return None
    faces = _ANALYZER.get(img)
    return _largest_face(faces)


def swap_faces(target_path: Path, source_paths: list[Path]) -> dict[str, Any]:
    """Swap canonical faces from source_paths onto target_path, in place.

    With one source, its face is applied to every detected face in the scene
    (typical: a single character). With multiple sources, faces are matched
    left-to-right by horizontal position so two characters land correctly.

    Returns a small status dict; never raises (errors are reported, image kept).
    """
    if not is_enabled():
        return {"applied": False, "reason": "disabled"}
    if not source_paths:
        return {"applied": False, "reason": "no source faces"}
    if not _ensure_loaded():
        return {"applied": False, "reason": _LOAD_ERROR or "unavailable"}

    try:
        import cv2  # type: ignore[import]

        target_img = cv2.imread(str(target_path))
        if target_img is None:
            return {"applied": False, "reason": "could not read target image"}

        target_faces = _ANALYZER.get(target_img)
        if not target_faces:
            return {"applied": False, "reason": "no face detected in scene"}

        source_faces = [f for f in (_source_face(p) for p in source_paths) if f is not None]
        if not source_faces:
            return {"applied": False, "reason": "no face detected in character design(s)"}

        # Order both sets left-to-right so multi-character swaps line up.
        target_faces.sort(key=lambda f: f.bbox[0])
        swapped_count = 0

        if len(source_faces) == 1:
            src = source_faces[0]
            for dst in target_faces:
                target_img = _SWAPPER.get(target_img, dst, src, paste_back=True)
                swapped_count += 1
        else:
            source_faces.sort(key=lambda f: f.bbox[0])
            for dst, src in zip(target_faces, source_faces):
                target_img = _SWAPPER.get(target_img, dst, src, paste_back=True)
                swapped_count += 1

        if swapped_count:
            cv2.imwrite(str(target_path), target_img)

        return {"applied": swapped_count > 0, "facesSwapped": swapped_count}
    except Exception as exc:  # noqa: BLE001 - never break generation
        _log(f"swap failed, keeping original: {exc}")
        return {"applied": False, "reason": str(exc)}
