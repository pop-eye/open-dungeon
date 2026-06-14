# Running Open Dungeon on Windows

## Requirements

- Windows 10 22H2 / Windows 11 (64-bit)
- Node.js 20+ — [nodejs.org](https://nodejs.org)
- [Ollama for Windows](https://ollama.com/download/windows) — local text generation
- Python 3.11 or 3.12 — [python.org](https://www.python.org/downloads/)
- Git for Windows — [git-scm.com](https://git-scm.com)
- **NVIDIA GPU with CUDA 12+** — required for image generation
- Hugging Face account with access to two gated repos (see below)
- ~12 GB free disk space for model weights

## Quick start (text-only)

```powershell
git clone https://github.com/pop-eye/open-dungeon
cd open-dungeon
npm install
ollama pull gemma4:12b-it-qat
npm run dev
```

Open http://localhost:3000. Image generation setup follows below.

## `better-sqlite3` build prerequisites

`better-sqlite3` is a native Node addon that must compile locally.
Install the C++ build tools first:

```powershell
# Run as Administrator
npm install --global windows-build-tools
```

Or install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
with the **"Desktop development with C++"** workload.

---

## Image generation on Windows

Image generation on Windows uses the **same Python backend as macOS** —
[ultra-fast-image-gen](https://github.com/newideas99/ultra-fast-image-gen) —
with the `sdnq-hs` (PyTorch SDNQ) backend instead of the macOS-only
`mflux-hs` (MLX) backend. Same model weights, same uncensored text encoder,
PyTorch handles CUDA automatically.

### Gated model access

Two Hugging Face repositories require access approval before the models
will download:

1. **FLUX.2-klein-4B** — request access at:
   https://huggingface.co/black-forest-labs/FLUX.2-klein-4B

2. **Uncensored text encoder** (`flux2-klein-4b-uncensored-q4_k_m.gguf`) — request access at:
   https://huggingface.co/ponpoke/flux2-klein-4b-uncensored-text-encoder

Both are typically approved within minutes. Get a Hugging Face token at
https://huggingface.co/settings/tokens.

### Automated setup (recommended)

```powershell
# From the open-dungeon directory:
.\scripts\setup-windows-images.ps1 -HfToken hf_your_token_here
```

This script:
- Clones `ultra-fast-image-gen` to `~/ultra-fast-image-gen`
- Creates a Python venv and installs PyTorch with CUDA
- Installs all dependencies
- Writes `ULTRA_FAST_IMAGE_GEN_DIR` and `ULTRA_FAST_IMAGE_GEN_PYTHON` to `.env.local`
- Saves `HF_TOKEN` to the ultra-fast-image-gen `.env`

### Manual setup

```powershell
# 1. Clone ultra-fast-image-gen
git clone https://github.com/newideas99/ultra-fast-image-gen $HOME\ultra-fast-image-gen
cd $HOME\ultra-fast-image-gen

# 2. Create venv and install PyTorch CUDA
python -m venv .venv
.\.venv\Scripts\pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu126
.\.venv\Scripts\pip install -r requirements.txt

# 3. Set your HF token
echo HF_TOKEN=hf_your_token_here > .env

# 4. Add to open-dungeon/.env.local:
#   ULTRA_FAST_IMAGE_GEN_DIR=C:/Users/YourName/ultra-fast-image-gen
#   ULTRA_FAST_IMAGE_GEN_PYTHON=C:/Users/YourName/ultra-fast-image-gen/.venv/Scripts/python.exe
```

### Starting the image server

```powershell
# Terminal 1 — Ollama
ollama serve

# Terminal 2 — Open Dungeon
npm run dev

# Terminal 3 — Image generation server
npm run image:server
```

The server detects Windows and passes `--device cuda` to the SDNQ backend
automatically. On first image request, models download from Hugging Face (~7-10 GB).

**Warm up** (loads models into VRAM for faster first generation):
```powershell
npm run image:warm:mflux
```

### In-app setting

After starting, open the app and set the **Image Backend** to `sdnq-hs` in the
Settings panel of any chat. The `mflux-hs` option won't appear on Windows.

---

## Environment variables

```env
# ultra-fast-image-gen location (set by setup script)
ULTRA_FAST_IMAGE_GEN_DIR=C:/Users/YourName/ultra-fast-image-gen
ULTRA_FAST_IMAGE_GEN_PYTHON=C:/Users/YourName/ultra-fast-image-gen/.venv/Scripts/python.exe

# Override PyTorch device if needed (default: cuda on Windows)
# SDNQ_DEVICE=cuda

# SQLite path (defaults to data/local-roleplay.sqlite in the project dir)
# SQLITE_DB_PATH=C:/Users/YourName/open-dungeon-data/local-roleplay.sqlite
```

---

## Feature parity: macOS vs Windows

| Feature | macOS | Windows |
|---|---|---|
| Text generation (Ollama) | ✅ | ✅ |
| Text generation (remote) | ✅ | ✅ |
| SQLite / story saving | ✅ | ✅ |
| Character portraits | ✅ | ✅ |
| Image generation | ✅ mflux-hs (MLX) | ✅ sdnq-hs (CUDA) |
| Same model weights | ✅ | ✅ FLUX.2-klein-4B |
| Uncensored text encoder | ✅ | ✅ same GGUF file |
| Reference images (img2img) | ✅ up to 2 | ✅ up to 2 |
| Highway sampling (HS) | ✅ stride-2, 4-step | ✅ same algorithm |
| Resident model in VRAM | ✅ mflux worker | ⚠️ subprocess per request* |
| `.app` bundle | ✅ | ❌ clone-and-run only |

**\* Resident mode:** The macOS path keeps the model loaded between requests via a
long-lived worker process. On Windows, `generate.py` is invoked as a subprocess per
request. On NVIDIA, model load time is typically 10–30 s; subsequent requests within
the same CUDA session are faster. A resident worker for Windows can be added later.

---

## Alternative: ComfyUI backend

If you already have ComfyUI installed with FLUX.2-klein weights, you can use it
instead of the native Python path:

```env
# .env.local
IMAGE_BACKEND=comfyui
COMFYUI_URL=http://127.0.0.1:8188
COMFYUI_UNET_MODEL=flux2-klein-4b-Q4_K_M.gguf
COMFYUI_CLIP1_MODEL=flux2-klein-4b-uncensored-q4_k_m.gguf
COMFYUI_CLIP2_MODEL=clip_l.safetensors
COMFYUI_VAE_MODEL=ae.safetensors
```

Start ComfyUI first, then `npm run image:server`. The ComfyUI adapter
(`image_server/comfyui_image_server.py`) exposes the same HTTP contract.
