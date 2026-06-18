#Requires -Version 5.1
<#
.SYNOPSIS
    Installs optional InsightFace face-swap support for Open Dungeon character
    consistency, into the ultra-fast-image-gen venv used by the image server.

.DESCRIPTION
    Face-swap locks each character's face onto generated scenes using their
    canonical design portrait. This installs onnxruntime-gpu + insightface into
    the SAME venv that runs the image server, downloads the inswapper_128 model,
    and enables FACE_SWAP_ENABLED in .env.local.

    The buffalo_l detection/recognition models download automatically on first
    use; inswapper_128.onnx is fetched here because it is hosted separately.

.PARAMETER InstallDir
    ultra-fast-image-gen location (its venv receives the packages).
    Default: $HOME\ultra-fast-image-gen

.EXAMPLE
    .\scripts\setup-windows-faceswap.ps1

.NOTES
    Every step is gated on success so a partial install can't masquerade as a
    working one. Re-run after fixing any error.
#>

[CmdletBinding()]
param(
    [string]$InstallDir = "$HOME\ultra-fast-image-gen"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }

function Invoke-Checked([string]$Label, [scriptblock]$Action) {
    Write-Host $Label
    & $Action
    if ($LASTEXITCODE -ne 0) {
        Write-Host "`nERROR: step failed (exit $LASTEXITCODE): $Label" -ForegroundColor Red
        Write-Host "Fix the error above and re-run. Nothing was left half-installed." -ForegroundColor Red
        exit 1
    }
}

$python = "$InstallDir\.venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    Write-Host "ERROR: image venv python not found at $python" -ForegroundColor Red
    Write-Host "Run scripts\setup-windows-images.ps1 first." -ForegroundColor Red
    exit 1
}
Write-Ok "Using image venv: $python"

# -- Dependencies --------------------------------------------------------------
# onnxruntime-gpu runs the swap on CUDA; insightface provides detection,
# recognition, and the inswapper wrapper. opencv is used to read/write frames.

Invoke-Checked "Installing onnxruntime-gpu, insightface, opencv ..." {
    & $python -m pip install onnxruntime-gpu insightface opencv-python-headless
}

# -- inswapper model -----------------------------------------------------------

$modelsDir = "$HOME\.insightface\models"
$modelPath = Join-Path $modelsDir "inswapper_128.onnx"

if (Test-Path $modelPath) {
    Write-Ok "inswapper_128.onnx already present"
} else {
    Write-Step "Downloading inswapper_128.onnx (~530 MB)"
    New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null
    $url = "https://huggingface.co/ezioruan/inswapper_128.onnx/resolve/main/inswapper_128.onnx"
    try {
        Invoke-WebRequest -Uri $url -OutFile $modelPath
        Write-Ok "Model saved to $modelPath"
    } catch {
        Write-Host "ERROR: model download failed: $_" -ForegroundColor Red
        Write-Host "Download inswapper_128.onnx manually into $modelsDir and re-run." -ForegroundColor Red
        exit 1
    }
}

# -- Verify imports ------------------------------------------------------------

Write-Step "Verifying face-swap stack imports"
& $python -c "import onnxruntime, insightface, cv2; print('providers:', onnxruntime.get_available_providers())"
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: face-swap imports failed. Re-run after fixing the error above." -ForegroundColor Red
    exit 1
}

# -- Enable in .env.local ------------------------------------------------------

$envLocalPath = Join-Path (Split-Path $PSScriptRoot -Parent) ".env.local"
$snippet = "`n# --- Face-swap character consistency (setup-windows-faceswap.ps1) ---`nFACE_SWAP_ENABLED=1`n"
if (Test-Path $envLocalPath) {
    if ((Get-Content $envLocalPath -Raw) -match "FACE_SWAP_ENABLED") {
        Write-Ok "FACE_SWAP_ENABLED already in .env.local"
    } else {
        Add-Content $envLocalPath $snippet
        Write-Ok "Enabled FACE_SWAP_ENABLED in .env.local"
    }
} else {
    Set-Content $envLocalPath $snippet.TrimStart()
    Write-Ok "Created .env.local with FACE_SWAP_ENABLED"
}

Write-Host "`n=====================================================================" -ForegroundColor Green
Write-Host " Face-swap ready." -ForegroundColor Green
Write-Host "=====================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Restart the image server so it picks up the change:"
Write-Host "  npm run image:server" -ForegroundColor White
Write-Host ""
Write-Host "Then, per character: add a physical description and click 'Design' to"
Write-Host "generate their canonical portrait. Scenes featuring them will have"
Write-Host "that face swapped in for consistency."
Write-Host ""
