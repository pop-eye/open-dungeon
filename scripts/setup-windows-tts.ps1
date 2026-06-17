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

# $ErrorActionPreference = "Stop" does NOT catch non-zero exits from external
# programs like pip, so a failed/partial install used to sail through as
# "Done". Every external step below is gated on $LASTEXITCODE instead.
function Invoke-Checked {
    param([string]$Label, [scriptblock]$Action)
    Write-Host $Label
    & $Action
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "ERROR: step failed (exit $LASTEXITCODE): $Label"
        Write-Host "Fix the error above and re-run this script. Nothing was left in a usable-looking but broken state on purpose."
        exit 1
    }
}

Write-Host "Open Dungeon - Kokoro TTS setup"
Write-Host "  target dir: $TtsDir"

$venv = Join-Path $TtsDir ".venv"
$python = Join-Path $venv "Scripts\python.exe"

if (-not (Test-Path $python)) {
    Write-Host "Creating Python 3.12 venv at $venv ..."
    if (-not (Test-Path $TtsDir)) {
        New-Item -ItemType Directory -Path $TtsDir | Out-Null
    }
    Invoke-Checked "Running: py -3.12 -m venv ..." {
        py -3.12 -m venv $venv
    }
}

if (-not (Test-Path $python)) {
    Write-Host "ERROR: venv python not found at $python"
    Write-Host "Install Python 3.12 from python.org, then re-run."
    exit 1
}

Invoke-Checked "Upgrading pip ..." {
    & $python -m pip install --upgrade pip
}

Invoke-Checked "Installing PyTorch (CUDA 12.4) ..." {
    & $python -m pip install torch --index-url https://download.pytorch.org/whl/cu124
}

Invoke-Checked "Installing Kokoro and audio deps ..." {
    & $python -m pip install kokoro soundfile numpy
}

# Hard gate: confirm every critical module actually imports in this venv.
# A partial pip install (network drop, resolver fallback) must not look like
# success and then blow up later at synthesis time with ModuleNotFoundError.
Write-Host ""
Write-Host "Verifying imports and CUDA in the venv ..."
& $python -c "import torch, kokoro, numpy, soundfile; print('CUDA:', torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'NONE')"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: one or more required modules failed to import (torch / kokoro / numpy / soundfile)."
    Write-Host "The install did not complete cleanly. Re-run this script after fixing the error above."
    exit 1
}

if ($Warm) {
    $env:TTS_WARM = "1"
    Invoke-Checked "Warming the model (downloads ~350 MB on first run) ..." {
        & $python -c "import sys; sys.argv=['x']; from kokoro import KPipeline; KPipeline(lang_code='a'); print('Kokoro ready')"
    }
}

Write-Host ""
Write-Host "Done. Start the TTS server with:"
Write-Host "  npm run tts:server"
Write-Host ""
Write-Host "If the venv is not at the default path, add to .env.local:"
Write-Host "  KOKORO_TTS_DIR=$TtsDir"
Write-Host ""
Write-Host "Then in the app: enable Narrate aloud and pick the Kokoro (neural) backend."
