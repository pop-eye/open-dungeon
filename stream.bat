@echo off
REM ============================================================================
REM  Open Dungeon - Stream launcher
REM  Starts everything needed for a Twitch stream session:
REM    1. Ollama          (reuses if already running)
REM    2. Image server    (FLUX worker)
REM    3. TTS server      (Kokoro voice)
REM    4. Next.js app     (http://localhost:3000)
REM    5. Twitch bot      (chat commands)
REM ============================================================================

setlocal
cd /d "%~dp0"

if not exist "node_modules" (
  echo [stream] Installing dependencies...
  call npm install
  if errorlevel 1 ( echo [stream] npm install failed. & pause & exit /b 1 )
)

REM ---- 1. Ollama ----------------------------------------------------------
call :start_ollama
goto after_ollama

:start_ollama
netstat -ano | findstr ":11434" >nul 2>nul
if not errorlevel 1 (
  echo [stream] Ollama already running - reusing it.
  goto :eof
)
where ollama >nul 2>nul
if errorlevel 1 (
  echo [stream] WARNING: Ollama not found. Text generation will not work.
  goto :eof
)
echo [stream] Starting Ollama...
start "Stream - Ollama" cmd /k "ollama serve"
goto :eof

:after_ollama

REM ---- 2. Image server ----------------------------------------------------
echo [stream] Starting image server [FLUX worker]...
start "Stream - Image server" cmd /k "npm run image:server"

REM ---- 3. TTS server ------------------------------------------------------
echo [stream] Starting TTS server [Kokoro]...
start "Stream - TTS server" cmd /k "npm run tts:server"

REM ---- 4. Next.js app -----------------------------------------------------
echo [stream] Starting app on http://localhost:3000 ...
start "Stream - App" cmd /k "npm run dev"

REM ---- 5. Twitch bot ------------------------------------------------------
if not exist "twitch-bot\.env" (
  echo [stream] twitch-bot\.env not found.
  echo [stream] Run .\stream-setup.bat first to configure your Twitch credentials.
  goto skip_bot
)
findstr /i "STREAM_API_SECRET" .env.local >nul 2>nul
if errorlevel 1 (
  echo [stream] WARNING: STREAM_API_SECRET not set in .env.local
  echo [stream] Add:  STREAM_API_SECRET=any-random-string  to .env.local
)
echo [stream] Starting Twitch bot...
start "Stream - Twitch bot" cmd /k "npm run stream:bot"
:skip_bot

echo.
echo [stream] All services launching. Wait for the App window to say "Ready".
echo [stream] Then open http://localhost:3000, start a story, and in Twitch chat type:
echo [stream]   !chat latest
echo.
echo [stream] OBS browser source: http://localhost:3000/overlay/^<chatId^>?transparent=1
echo.
endlocal
