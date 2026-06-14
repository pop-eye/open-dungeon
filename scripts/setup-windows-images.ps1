#Requires -Version 5.1
<#
.SYNOPSIS
    Sets up ultra-fast-image-gen with CUDA support for Open Dungeon image
    generation on Windows.

.DESCRIPTION
    Clones ultra-fast-image-gen, creates a Python venv, installs PyTorch with
    CUDA, installs dependencies, and generates the .env.local configuration.

    After running this script:
      npm run image:server    ← starts the image server (sdnq-hs backend, CUDA)
      npm run image:warm:mflux ← warms up the model on first use

.PARAMETER InstallDir
    Where to clone/find ultra-fast-image-gen. Default: $HOME\ultra-fast-image-gen

.PARAMETER HfToken
    Hugging Face token — required for the gated uncensored text encoder.
    Get one at https://huggingface.co/settings/tokens, then request access to:
      https://huggingface.co/ponpoke/flux2-klein-4b-uncensored-text-encoder
    Can also be set via the HF_TOKEN environment variable.

.PARAMETER CudaVersion
    PyTorch CUDA index suffix, e.g. "cu126" for CUDA 12.6 (default).
    Check https://pytorch.org for your driver's compatible version.

.EXAMPLE
    .\scripts\setup-windows-images.ps1 -HfToken hf_xxxx

.EXAMPLE
    .\scripts\setup-windows-images.ps1 -HfToken hf_xxxx -CudaVersion cu121

.NOTES
    Requirements:
      - Python 3.11 or 3.12 on PATH   (python --version)
      - Git on PATH                    (git --version)
      - NVIDIA GPU with CUDA 12+       (nvidia-smi)
      - ~12 GB free disk space
#>

[CmdletBinding()]
param(
    [string]$InstallDir = "$HOME\ultra-fast-image-gen",
    [string]$HfToken = $env:HF_TOKEN,
    [string]$CudaVersion = "cu126"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "    WARN: $msg" -ForegroundColor Yellow }

function Require-Command([string]$cmd, [string]$hint) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Host "ERROR: '$cmd' not found on PATH. $hint" -ForegroundColor Red
        exit 1
    }
}

# ── Pre-flight ────────────────────────────────────────────────────────────────

Write-Step "Checking prerequisites"
Require-Command "python" "Install Python 3.11+ from https://www.python.org/downloads/"
Require-Command "git"    "Install Git from https://git-scm.com/"

$pyVer = python --version 2>&1
Write-Ok $pyVer

$gpuOk = $false
try {
    $gpuInfo = nvidia-smi --query-gpu=name --format=csv,noheader 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "GPU: $gpuInfo"
        $gpuOk = $true
    }
} catch {}
if (-not $gpuOk) {
    Write-Warn "nvidia-smi not found. Image generation requires an NVIDIA GPU with CUDA 12+."
}

if (-not $HfToken) {
    Write-Host ""
    Write-Host "  WARNING: No Hugging Face token provided." -ForegroundColor Yellow
    Write-Host "  The uncensored FLUX text encoder requires a gated HF repo."
    Write-Host "  1. Get a token: https://huggingface.co/settings/tokens"
    Write-Host "  2. Request access: https://huggingface.co/ponpoke/flux2-klein-4b-uncensored-text-encoder"
    Write-Host "  3. Re-run: .\scripts\setup-windows-images.ps1 -HfToken hf_xxxx"
    Write-Host ""
    Write-Host "  Continuing without a token — models will download on first use" `
        "(HF_TOKEN required for the uncensored encoder)." -ForegroundColor Yellow
    Write-Host ""
}

# ── Clone ultra-fast-image-gen ────────────────────────────────────────────────

Write-Step "Setting up ultra-fast-image-gen at $InstallDir"

if (-not (Test-Path "$InstallDir\.git")) {
    git clone --depth 1 https://github.com/newideas99/ultra-fast-image-gen.git $InstallDir
    Write-Ok "Repository cloned"
} else {
    Write-Ok "Already present, pulling latest"
    git -C $InstallDir pull --ff-only
}

# ── Python venv ───────────────────────────────────────────────────────────────

$venvDir = "$InstallDir\.venv"
$pip     = "$venvDir\Scripts\pip.exe"
$python  = "$venvDir\Scripts\python.exe"

Write-Step "Creating Python venv"
if (-not (Test-Path "$venvDir\Scripts\python.exe")) {
    python -m venv $venvDir
    Write-Ok "Venv created"
} else {
    Write-Ok "Venv already exists"
}

# ── PyTorch with CUDA ─────────────────────────────────────────────────────────

Write-Step "Installing PyTorch with CUDA $CudaVersion"
Write-Host "    (This can take several minutes on first run...)"
& $pip install torch torchvision torchaudio `
    --index-url "https://download.pytorch.org/whl/$CudaVersion" `
    --quiet
Write-Ok "PyTorch installed"

# ── ultra-fast-image-gen dependencies ────────────────────────────────────────

Write-Step "Installing ultra-fast-image-gen dependencies"
& $pip install -r "$InstallDir\requirements.txt" --quiet
Write-Ok "Dependencies installed"

# ── HF token ─────────────────────────────────────────────────────────────────

if ($HfToken) {
    Write-Step "Configuring Hugging Face token"
    $envFilePath = "$InstallDir\.env"
    if (Test-Path $envFilePath) {
        $existing = Get-Content $envFilePath
        if ($existing -notmatch "HF_TOKEN=") {
            Add-Content $envFilePath "`nHF_TOKEN=$HfToken"
            Write-Ok "HF_TOKEN added to $envFilePath"
        } else {
            Write-Ok "HF_TOKEN already set in $envFilePath"
        }
    } else {
        Set-Content $envFilePath "HF_TOKEN=$HfToken"
        Write-Ok "Created $envFilePath with HF_TOKEN"
    }
}

# ── .env.local for Open Dungeon ───────────────────────────────────────────────

Write-Step "Writing Open Dungeon .env.local"

$installDirForwardSlash = $InstallDir -replace '\\', '/'
$pythonForwardSlash = $python -replace '\\', '/'

$snippet = @"

# --- Windows image generation (ultra-fast-image-gen + CUDA) ---
# Added by setup-windows-images.ps1 on $(Get-Date -Format 'yyyy-MM-dd')
ULTRA_FAST_IMAGE_GEN_DIR=$installDirForwardSlash
ULTRA_FAST_IMAGE_GEN_PYTHON=$pythonForwardSlash
# sdnq-hs backend uses CUDA automatically on Windows (no extra config needed)
"@

$envLocalPath = Join-Path (Split-Path $PSScriptRoot -Parent) ".env.local"
if (Test-Path $envLocalPath) {
    Add-Content $envLocalPath $snippet
    Write-Ok "Appended to existing .env.local"
} else {
    Set-Content $envLocalPath $snippet.TrimStart()
    Write-Ok "Created .env.local"
}

# ── Summary ───────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "=====================================================================" -ForegroundColor Green
Write-Host " Setup complete!" -ForegroundColor Green
Write-Host "=====================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host ""
Write-Host "  1. Start Open Dungeon (Terminal 1):"
Write-Host "       npm run dev" -ForegroundColor White
Write-Host ""
Write-Host "  2. Start the image server (Terminal 2):"
Write-Host "       npm run image:server" -ForegroundColor White
Write-Host "     The sdnq-hs backend will use CUDA automatically."
Write-Host ""
Write-Host "  3. On first image request, the FLUX.2-klein model and uncensored"
Write-Host "     text encoder will download from Hugging Face (~7-10 GB)."
if (-not $HfToken) {
    Write-Host "     NOTE: Set HF_TOKEN in .env.local for the uncensored text encoder." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  4. Optional — warm up the model (loads into VRAM, faster first gen):"
Write-Host "       npm run image:warm:mflux" -ForegroundColor White
Write-Host ""
Write-Host "  Open Dungeon: http://localhost:3000"
Write-Host "  In-app: set the Image Backend to 'sdnq-hs' in a chat's Settings panel."
Write-Host ""
