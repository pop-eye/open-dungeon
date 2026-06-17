# Setup script for Open Dungeon Kokoro neural TTS (Windows 11, NVIDIA CUDA).
#
# Creates a dedicated Python venv, installs PyTorch (CUDA), and Kokoro-82M.
# Run from the project root in PowerShell:
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-tts.ps1
#
# Pre-create the venv with Python 3.12 if your default python is older
# (Anaconda base is often too old):
#
#   py -3.12 -m venv $env:USERPROFILE\open-dungeon-tts\.venv

param(
    [string]$TtsDir = "$env:USERPROFILE\open-dungeon-tts",
    [switch]$Warm
)

$ErrorActionPreference = "Stop"

Write-Host "Open Dungeon - Kokoro TTS setup"
Write-Host "  target dir: $TtsDir"

$venv = Join-Path $TtsDir ".venv"
$python = Join-Path $venv "Scripts\python.exe"

if (-not (Test-Path $python)) {
    Write-Host "Creating Python 3.12 venv at $venv ..."
    if (-not (Test-Path $TtsDir)) {
        New-Item -ItemType Directory -Path $TtsDir | Out-Null
    }
    py -3.12 -m venv $venv
}

if (-not (Test-Path $python)) {
    Write-Host "ERROR: venv python not found at $python"
    Write-Host "Install Python 3.12 from python.org, then re-run."
    exit 1
}

Write-Host "Upgrading pip ..."
& $python -m pip install --upgrade pip

Write-Host "Installing PyTorch (CUDA 12.4) ..."
& $python -m pip install torch --index-url https://download.pytorch.org/whl/cu124

Write-Host "Installing Kokoro and audio deps ..."
& $python -m pip install kokoro soundfile numpy

Write-Host ""
Write-Host "Verifying CUDA is visible to PyTorch ..."
& $python -c "import torch; print('CUDA:', torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'NONE')"

if ($Warm) {
    Write-Host ""
    Write-Host "Warming the model (downloads ~350 MB on first run) ..."
    $env:TTS_WARM = "1"
    & $python -c "import sys; sys.argv=['x']; from kokoro import KPipeline; KPipeline(lang_code='a'); print('Kokoro ready')"
}

Write-Host ""
Write-Host "Done. Start the TTS server with:"
Write-Host "  npm run tts:server"
Write-Host ""
Write-Host "If the venv is not at the default path, add to .env.local:"
Write-Host "  KOKORO_TTS_DIR=$TtsDir"
Write-Host ""
Write-Host "Then in the app: enable Narrate aloud and pick the Kokoro (neural) backend."
