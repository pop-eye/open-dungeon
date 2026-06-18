@echo off
REM ============================================================================
REM  Open Dungeon - Windows launcher
REM
REM  Starts every service the app needs, each in its own titled window so you
REM  can read its logs and close it independently. Close a window (or Ctrl+C in
REM  it) to stop that one service; the others keep running.
REM
REM  Services:
REM    1. Ollama          - local text generation        (port 11434)
REM    2. Next.js app     - the web UI                    (http://localhost:3000)
REM    3. Image server    - FLUX.2-klein image worker     (port 7869, optional)
REM    4. TTS server      - Kokoro voice narration        (optional)
REM
REM  Usage:
REM    run.bat              start app + Ollama + image server + TTS
REM    run.bat --no-images  skip the FLUX image worker
REM    run.bat --no-tts     skip the Kokoro TTS server
REM    run.bat --app-only   only Ollama + the Next.js app (text play)
REM ============================================================================

setlocal
cd /d "%~dp0"

REM ---- Parse flags --------------------------------------------------------
set START_IMAGES=1
set START_TTS=1
set START_OLLAMA=1

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--no-images" set START_IMAGES=0
if /i "%~1"=="--no-tts"    set START_TTS=0
if /i "%~1"=="--app-only"  ( set START_IMAGES=0 & set START_TTS=0 )
shift
goto parse
:parsed

REM ---- Sanity checks ------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [run] Node.js is not on PATH. Install it from https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [run] node_modules missing - installing dependencies once...
  call npm install
  if errorlevel 1 (
    echo [run] npm install failed. Fix the error above and re-run.
    pause
    exit /b 1
  )
)

REM ---- 1. Ollama ----------------------------------------------------------
if "%START_OLLAMA%"=="1" (
  where ollama >nul 2>nul
  if errorlevel 1 (
    echo [run] Ollama not found on PATH - skipping. Install from https://ollama.com/download
    echo [run] Text generation will not work until Ollama is running.
  ) else (
    echo [run] Starting Ollama...
    start "Open Dungeon - Ollama" cmd /k "ollama serve"
  )
)

REM ---- 2. Image server (optional) ----------------------------------------
if "%START_IMAGES%"=="1" (
  echo [run] Starting image server (FLUX worker)...
  start "Open Dungeon - Image server" cmd /k "npm run image:server"
)

REM ---- 3. TTS server (optional) ------------------------------------------
if "%START_TTS%"=="1" (
  echo [run] Starting TTS server (Kokoro)...
  start "Open Dungeon - TTS server" cmd /k "npm run tts:server"
)

REM ---- 4. Next.js app -----------------------------------------------------
echo [run] Starting the app on http://localhost:3000 ...
start "Open Dungeon - App" cmd /k "npm run dev"

echo.
echo [run] All requested services are launching in their own windows.
echo [run] Open http://localhost:3000 in your browser once the app window says "Ready".
echo.
echo [run] Tips:
echo [run]   - First image request downloads ~7-10 GB of model weights.
echo [run]   - Pull a text model once with:  ollama pull gemma4:12b-it-qat
echo [run]   - Close any service window to stop just that service.
echo.
endlocal
