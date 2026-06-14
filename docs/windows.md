# Running Open Dungeon on Windows

## Requirements

- Windows 10 22H2 / Windows 11 (64-bit)
- Node.js 20+ — [nodejs.org](https://nodejs.org)
- [Ollama for Windows](https://ollama.com/download/windows) — local text generation
- Python 3.11 or 3.12 — [python.org](https://www.python.org/downloads/) (for the image server)
- Git for Windows — [git-scm.com](https://git-scm.com)
- **NVIDIA GPU with CUDA 12+** — required for image generation
- **12 GB+ free disk** — model weights

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
Before running `npm install`, install the C++ build tools:

```powershell
# Run as Administrator
npm install --global windows-build-tools
```

Or install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
with the **"Desktop development with C++"** workload.

---

## Image generation (ComfyUI + CUDA)

On Windows, image generation runs through [ComfyUI](https://github.com/comfyanonymous/ComfyUI)
with the [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) custom nodes.
This loads the **same FLUX.2-klein weights and uncensored GGUF text encoder** as the
Mac path, so image quality and narrative fidelity are preserved.

The `npm run image:server` command auto-selects the ComfyUI backend on Windows
(and MFLUX/MLX on macOS). No config change needed.

### Automated setup

Run the setup script once — it installs ComfyUI, GGUF nodes, and downloads
the public model files (CLIP-L + VAE). Model files that require a Hugging Face
token are flagged for manual placement.

```powershell
# From the open-dungeon directory:
.\scripts\setup-windows-images.ps1 -HfToken hf_your_token_here
```

See `scripts/setup-windows-images.ps1` for full options.

### Manual setup

If you prefer manual control:

**1. Install ComfyUI**

```powershell
git clone https://github.com/comfyanonymous/ComfyUI.git $HOME\ComfyUI
cd $HOME\ComfyUI
python -m venv .venv
.\.venv\Scripts\pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu126
.\.venv\Scripts\pip install -r requirements.txt
```

**2. Install ComfyUI-GGUF**

```powershell
git clone https://github.com/city96/ComfyUI-GGUF.git $HOME\ComfyUI\custom_nodes\ComfyUI-GGUF
.\.venv\Scripts\pip install -r $HOME\ComfyUI\custom_nodes\ComfyUI-GGUF\requirements.txt
```

**3. Place model files**

| File | Directory | Source |
|---|---|---|
| `flux2-klein-4b-q4_k_m.gguf` | `ComfyUI\models\unet\` | ultra-fast-image-gen (gated HF repo) |
| `t5xxl_uncensored_q4_k_m.gguf` | `ComfyUI\models\text_encoders\` | ultra-fast-image-gen (gated HF repo) |
| `clip_l.safetensors` | `ComfyUI\models\text_encoders\` | [comfyanonymous/flux_text_encoders](https://huggingface.co/comfyanonymous/flux_text_encoders) |
| `ae.safetensors` | `ComfyUI\models\vae\` | [black-forest-labs/FLUX.1-schnell](https://huggingface.co/black-forest-labs/FLUX.1-schnell) |

For the gated models, check the `ultra-fast-image-gen` README for the current Hugging Face
repo name and request access with your HF token.

**4. Configure `.env.local`**

```env
COMFYUI_URL=http://127.0.0.1:8188
COMFYUI_PYTHON=C:\Users\YourName\ComfyUI\.venv\Scripts\python.exe
COMFYUI_UNET_MODEL=flux2-klein-4b-q4_k_m.gguf
COMFYUI_CLIP1_MODEL=t5xxl_uncensored_q4_k_m.gguf
COMFYUI_CLIP2_MODEL=clip_l.safetensors
COMFYUI_VAE_MODEL=ae.safetensors
```

### Starting everything

Open three terminals:

```powershell
# Terminal 1 — Ollama
ollama serve

# Terminal 2 — ComfyUI (keep running while playing)
cd $HOME\ComfyUI
.\.venv\Scripts\python main.py --listen 127.0.0.1 --port 8188

# Terminal 3 — Open Dungeon
cd open-dungeon
npm run dev
npm run image:server  # in a 4th terminal, or run concurrently
```

Then open http://localhost:3000.

**Warm up image generation** (loads the model into VRAM on first use, ~30–60 s):

```powershell
npm run image:warm:mflux
```

---

## Backend selection

The image server auto-selects by OS, but you can override it:

```env
# .env.local
IMAGE_BACKEND=comfyui   # always use ComfyUI (e.g. on a Windows dev box)
IMAGE_BACKEND=mflux     # always use MFLUX/MLX
```

---

## Environment variables

```env
# ComfyUI
COMFYUI_URL=http://127.0.0.1:8188
COMFYUI_PYTHON=                     # path to python in ComfyUI's venv
COMFYUI_UNET_MODEL=flux2-klein-4b-q4_k_m.gguf
COMFYUI_CLIP1_MODEL=t5xxl_uncensored_q4_k_m.gguf
COMFYUI_CLIP2_MODEL=clip_l.safetensors
COMFYUI_VAE_MODEL=ae.safetensors

# Image server (shared between backends)
FLUX_WORKER_URL=http://127.0.0.1:7869
IMAGE_SERVER_HOST=127.0.0.1
IMAGE_SERVER_PORT=7869
IMAGE_SERVER_TIMEOUT=240            # seconds per generation

# SQLite (defaults to data/local-roleplay.sqlite in the project)
SQLITE_DB_PATH=C:/Users/YourName/open-dungeon-data/local-roleplay.sqlite
```

---

## Feature parity: macOS vs Windows

| Feature | macOS (MFLUX/MLX) | Windows (ComfyUI/CUDA) |
|---|---|---|
| Text generation (Ollama) | ✅ | ✅ |
| Text generation (remote) | ✅ | ✅ |
| SQLite / story saving | ✅ | ✅ |
| Character portraits | ✅ | ✅ |
| Image generation | ✅ | ✅ |
| Same model weights | ✅ | ✅ FLUX.2-klein GGUF |
| Uncensored text encoder | ✅ | ✅ same GGUF file |
| Reference images | ✅ up to 2 | ✅ first ref (img2img) |
| Highway sampling speed | ✅ 4-step HS | ⚠️ standard 4-step euler |
| Resident model in VRAM | ✅ mflux worker | ✅ ComfyUI keeps model loaded |
| `.app` bundle | ✅ | ❌ clone-and-run only |

**Notes on differences:**
- **Reference images**: the Mac path uses MFLUX's native multi-image conditioning;
  the Windows path uses standard img2img with the first reference at 75% denoise.
  IP-Adapter FLUX support can be added as a future enhancement for closer parity.
- **Speed**: both paths run 4 denoising steps. Raw generation time will depend on your GPU.
  An RTX 3080/4070 is expected to be comparable to M2 Max for 1024px images.
- **Highway sampling**: the Mac-specific 2x stride speed hack doesn't transfer to ComfyUI.
  Quality is the same; speed may be somewhat slower per image.
