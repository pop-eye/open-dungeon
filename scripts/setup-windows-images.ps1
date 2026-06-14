#Requires -Version 5.1
<#
.SYNOPSIS
    Sets up ComfyUI + GGUF nodes for Open Dungeon image generation on Windows.

.DESCRIPTION
    Downloads and configures:
      - ComfyUI (portable or git clone)
      - ComfyUI-GGUF custom nodes (for loading GGUF-quantised models)
      - Model files: FLUX.2-klein GGUF unet, uncensored T5 GGUF, CLIP-L, VAE

    After running this script, start ComfyUI then start the image server:
      python ComfyUI\main.py --listen 127.0.0.1 --port 8188
      npm run image:server

.PARAMETER InstallDir
    Where to install ComfyUI. Default: $HOME\ComfyUI

.PARAMETER HfToken
    Hugging Face token for gated repos (required for the uncensored GGUF model).
    Get one from https://huggingface.co/settings/tokens
    Can also be set via the HF_TOKEN environment variable.

.PARAMETER SkipModelDownload
    Skip downloading model weights (if you already have them and want to symlink
    or copy manually). Script will print the expected paths.

.EXAMPLE
    # Full install with automatic model download
    .\scripts\setup-windows-images.ps1 -HfToken hf_xxxx

.EXAMPLE
    # Install ComfyUI only, download models later
    .\scripts\setup-windows-images.ps1 -SkipModelDownload

.NOTES
    Requirements:
      - Python 3.11 or 3.12 on PATH  (python --version)
      - Git on PATH                   (git --version)
      - NVIDIA GPU with CUDA 12+      (nvidia-smi)
      - 12 GB+ free disk space for model files
#>

[CmdletBinding()]
param(
    [string]$InstallDir = "$HOME\ComfyUI",
    [string]$HfToken = $env:HF_TOKEN,
    [switch]$SkipModelDownload
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # Speeds up Invoke-WebRequest

# ── Helpers ──────────────────────────────────────────────────────────────────

function Write-Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "    WARN: $msg" -ForegroundColor Yellow }
function Require-Command([string]$cmd, [string]$installHint) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Host "ERROR: '$cmd' not found on PATH." -ForegroundColor Red
        Write-Host "       $installHint"
        exit 1
    }
}

function Download-File([string]$url, [string]$dest, [string]$token = "") {
    $headers = @{}
    if ($token) { $headers["Authorization"] = "Bearer $token" }
    Write-Host "    Downloading $(Split-Path $dest -Leaf)..."
    Invoke-WebRequest -Uri $url -OutFile $dest -Headers $headers -UseBasicParsing
}

function HF-Download([string]$repo, [string]$filename, [string]$dest, [string]$token) {
    $url = "https://huggingface.co/$repo/resolve/main/$filename"
    Download-File $url $dest $token
}

# ── Pre-flight checks ─────────────────────────────────────────────────────────

Write-Step "Checking prerequisites"
Require-Command "python"  "Install Python 3.11+ from https://www.python.org/downloads/"
Require-Command "git"     "Install Git from https://git-scm.com/"

$pythonVersion = python --version 2>&1
Write-Ok $pythonVersion

$gpuCheck = nvidia-smi 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Warn "nvidia-smi not found or failed. Image generation requires an NVIDIA GPU with CUDA 12+."
    Write-Warn "Continuing anyway — you can install the GPU driver later."
} else {
    Write-Ok "NVIDIA GPU detected"
}

# ── ComfyUI install ───────────────────────────────────────────────────────────

Write-Step "Installing ComfyUI at $InstallDir"

if (-not (Test-Path "$InstallDir\.git")) {
    git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git $InstallDir
    Write-Ok "ComfyUI cloned"
} else {
    Write-Ok "ComfyUI already present, pulling latest"
    git -C $InstallDir pull --ff-only
}

# Create and activate a venv inside ComfyUI
$venvDir = "$InstallDir\.venv"
if (-not (Test-Path "$venvDir\Scripts\python.exe")) {
    Write-Step "Creating Python venv for ComfyUI"
    python -m venv $venvDir
    Write-Ok "Venv created at $venvDir"
}

$pip = "$venvDir\Scripts\pip.exe"
$pythonExe = "$venvDir\Scripts\python.exe"

Write-Step "Installing ComfyUI dependencies (PyTorch CUDA 12.6)"
# Install PyTorch with CUDA — adjust cu126 if your CUDA version differs
& $pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu126 --quiet
& $pip install -r "$InstallDir\requirements.txt" --quiet
Write-Ok "ComfyUI dependencies installed"

# ── ComfyUI-GGUF custom nodes ─────────────────────────────────────────────────

Write-Step "Installing ComfyUI-GGUF custom nodes"
$customNodesDir = "$InstallDir\custom_nodes"
$ggufDir = "$customNodesDir\ComfyUI-GGUF"

if (-not (Test-Path "$ggufDir\.git")) {
    git clone --depth 1 https://github.com/city96/ComfyUI-GGUF.git $ggufDir
    Write-Ok "ComfyUI-GGUF cloned"
} else {
    Write-Ok "ComfyUI-GGUF already present"
    git -C $ggufDir pull --ff-only
}

if (Test-Path "$ggufDir\requirements.txt") {
    & $pip install -r "$ggufDir\requirements.txt" --quiet
    Write-Ok "ComfyUI-GGUF requirements installed"
}

# ── Model directories ─────────────────────────────────────────────────────────

$unetDir   = "$InstallDir\models\unet"
$clipDir   = "$InstallDir\models\text_encoders"
$vaeDir    = "$InstallDir\models\vae"

foreach ($dir in @($unetDir, $clipDir, $vaeDir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

# ── Model downloads ───────────────────────────────────────────────────────────

if ($SkipModelDownload) {
    Write-Step "Skipping model downloads (--SkipModelDownload)"
    Write-Host ""
    Write-Host "Place the following files in these directories:" -ForegroundColor Yellow
    Write-Host "  FLUX.2-klein unet GGUF  →  $unetDir\flux2-klein-4b-q4_k_m.gguf"
    Write-Host "  Uncensored T5 GGUF      →  $clipDir\t5xxl_uncensored_q4_k_m.gguf"
    Write-Host "  CLIP-L                  →  $clipDir\clip_l.safetensors"
    Write-Host "  FLUX VAE                →  $vaeDir\ae.safetensors"
    Write-Host ""
} else {
    if (-not $HfToken) {
        Write-Host ""
        Write-Host "WARNING: No Hugging Face token provided." -ForegroundColor Yellow
        Write-Host "         The uncensored GGUF text encoder lives in a gated repo."
        Write-Host "         Get a token from https://huggingface.co/settings/tokens"
        Write-Host "         then re-run with: -HfToken hf_xxxx"
        Write-Host "         or set: `$env:HF_TOKEN = 'hf_xxxx'"
        Write-Host ""
        Write-Host "         Continuing with public models only..."
        Write-Host ""
    }

    Write-Step "Downloading model files"

    # FLUX VAE (public)
    $vaeDest = "$vaeDir\ae.safetensors"
    if (-not (Test-Path $vaeDest)) {
        HF-Download "black-forest-labs/FLUX.1-schnell" "ae.safetensors" $vaeDest ""
    } else { Write-Ok "VAE already present" }

    # CLIP-L (public)
    $clipLDest = "$clipDir\clip_l.safetensors"
    if (-not (Test-Path $clipLDest)) {
        HF-Download "comfyanonymous/flux_text_encoders" "clip_l.safetensors" $clipLDest ""
    } else { Write-Ok "CLIP-L already present" }

    # FLUX.2-klein 4B unet GGUF — gated repo, needs HF token
    $unetDest = "$unetDir\flux2-klein-4b-q4_k_m.gguf"
    if (-not (Test-Path $unetDest)) {
        if ($HfToken) {
            Write-Host "    Downloading FLUX.2-klein 4B unet (~3-4 GB)..."
            # NOTE: Update this repo/filename once the model's official HF location is confirmed.
            # The model is distributed via ultra-fast-image-gen; check that repo's README for
            # the current download source.
            Write-Warn "FLUX.2-klein unet: check ultra-fast-image-gen README for the HF repo name."
            Write-Warn "Then place the GGUF file at: $unetDest"
            Write-Warn "Or set COMFYUI_UNET_MODEL in .env.local to match your filename."
        } else {
            Write-Warn "Skipping FLUX.2-klein unet download (no HF token). Place it manually at:"
            Write-Warn "  $unetDest"
        }
    } else { Write-Ok "FLUX.2-klein unet already present" }

    # Uncensored T5 GGUF — gated repo, needs HF token + approval
    $t5Dest = "$clipDir\t5xxl_uncensored_q4_k_m.gguf"
    if (-not (Test-Path $t5Dest)) {
        if ($HfToken) {
            Write-Host "    Downloading uncensored T5 GGUF text encoder..."
            Write-Warn "Uncensored T5: check ultra-fast-image-gen README for the gated HF repo."
            Write-Warn "Then place the GGUF file at: $t5Dest"
            Write-Warn "Or set COMFYUI_CLIP1_MODEL in .env.local to match your filename."
        } else {
            Write-Warn "Skipping uncensored T5 download (no HF token). Place it manually at:"
            Write-Warn "  $t5Dest"
        }
    } else { Write-Ok "Uncensored T5 GGUF already present" }
}

# ── env.local snippet ─────────────────────────────────────────────────────────

Write-Step "Writing .env.local snippet"
$envSnippet = @"

# --- Open Dungeon Windows image generation (ComfyUI) ---
# Added by setup-windows-images.ps1 on $(Get-Date -Format 'yyyy-MM-dd')
COMFYUI_URL=http://127.0.0.1:8188
COMFYUI_PYTHON=$pythonExe
COMFYUI_UNET_MODEL=flux2-klein-4b-q4_k_m.gguf
COMFYUI_CLIP1_MODEL=t5xxl_uncensored_q4_k_m.gguf
COMFYUI_CLIP2_MODEL=clip_l.safetensors
COMFYUI_VAE_MODEL=ae.safetensors
"@

$envLocalPath = Join-Path (Split-Path $PSScriptRoot -Parent) ".env.local"
if (Test-Path $envLocalPath) {
    Add-Content -Path $envLocalPath -Value $envSnippet
    Write-Ok "Appended to existing .env.local"
} else {
    Set-Content -Path $envLocalPath -Value $envSnippet.TrimStart()
    Write-Ok "Created .env.local"
}

# ── Final instructions ────────────────────────────────────────────────────────

Write-Host ""
Write-Host "=====================================================================" -ForegroundColor Green
Write-Host " Setup complete!" -ForegroundColor Green
Write-Host "=====================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host ""
Write-Host "  1. Make sure all model files are in place (see warnings above if any)."
Write-Host ""
Write-Host "  2. Start ComfyUI (keep this terminal open):"
Write-Host "       $pythonExe $InstallDir\main.py --listen 127.0.0.1 --port 8188" -ForegroundColor White
Write-Host ""
Write-Host "  3. In a new terminal, start Open Dungeon:"
Write-Host "       npm run dev           (dev mode)"
Write-Host "       npm run image:server  (image generation server)" -ForegroundColor White
Write-Host ""
Write-Host "  4. Open http://localhost:3000 and start playing."
Write-Host ""
Write-Host "  For a warm-up generation (loads model into VRAM):"
Write-Host "       npm run image:warm:mflux  (also works on Windows now)"
Write-Host ""
