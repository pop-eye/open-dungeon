# Running Open Dungeon on Windows

## Requirements

- Windows 10 22H2 / Windows 11 (64-bit)
- Node.js 20+ — download from [nodejs.org](https://nodejs.org)
- [Ollama for Windows](https://ollama.com/download/windows) for local text generation
- Python 3.11 or 3.12 (for the image server) — download from [python.org](https://www.python.org/downloads/)
- Git for Windows — download from [git-scm.com](https://git-scm.com)
- **`better-sqlite3` native build prerequisites** (see below)
- **NVIDIA GPU with CUDA 12+** for image generation (see [Image generation](#image-generation))

## Quick start (text-only)

```powershell
git clone https://github.com/pop-eye/open-dungeon
cd open-dungeon
npm install
ollama pull gemma4:12b-it-qat
npm run dev
```

Open http://localhost:3000. The **Text Model** panel lets you pick Ollama or any OpenAI-compatible remote server.

## `better-sqlite3` build prerequisites

`better-sqlite3` is a native Node addon that must compile on your machine.
Before running `npm install`, ensure you have:

1. **Python** (3.x) — already required for the image server; the same install works.
2. **Visual Studio Build Tools** with the "Desktop development with C++" workload,
   OR the full Visual Studio Community edition.

The easiest way to install both at once:

```powershell
# Run as Administrator
npm install --global windows-build-tools
```

If you already have Visual Studio installed, ensure the **"C++ build tools"** workload
is enabled via the Visual Studio Installer.

## Image generation

> **Status (Stage 2, in progress):** The current image engine (MFLUX/MLX) targets
> Apple Silicon only and cannot run on Windows. A Windows-native ComfyUI-based backend
> that loads the same FLUX.2-klein weights and uncensored GGUF text encoder is being
> developed. Once complete, `npm run image:server` will auto-select the right engine
> for the current OS.

### What works now (Stage 1)

- The text RPG runs fully on Windows (Ollama + Next.js + SQLite).
- The image server script (`npm run image:server`) will launch but immediately fail
  because the MLX/MFLUX Python package is macOS-only. This is expected and does not
  affect text generation.
- The app degrades gracefully: the Generate Image button is present but returns an
  error that the worker isn't running.

### Coming in Stage 2

A `image_server/comfyui_image_server.py` adapter that:
- Exposes the identical `/generate`, `/warm`, `/health`, `/backends` HTTP contract.
- Drives a local [ComfyUI](https://github.com/comfyanonymous/ComfyUI) instance loaded
  with [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) nodes.
- Loads FLUX.2-klein-4B + the same uncensored GGUF text encoder used on macOS,
  preserving image quality and narrative fidelity.
- `npm run image:server` automatically selects this backend on Windows.

## Environment variables

Copy `.env.example` to `.env.local` and edit as needed.
Windows paths should use forward slashes or double backslashes:

```env
ULTRA_FAST_IMAGE_GEN_DIR=C:/Users/YourName/ultra-fast-image-gen
ULTRA_FAST_IMAGE_GEN_PYTHON=C:/Users/YourName/ultra-fast-image-gen/.venv/Scripts/python.exe
SQLITE_DB_PATH=C:/Users/YourName/open-dungeon-data/local-roleplay.sqlite
```

## Known differences from macOS

| Feature | macOS | Windows (Stage 1) |
|---|---|---|
| Text generation (Ollama) | ✅ | ✅ |
| Text generation (remote server) | ✅ | ✅ |
| SQLite / story saving | ✅ | ✅ |
| Character portraits | ✅ | ✅ |
| Image generation (FLUX.2-klein) | ✅ MFLUX/MLX | 🔜 ComfyUI/CUDA (Stage 2) |
| `.app` bundle | ✅ | ❌ (clone-and-run only for now) |
