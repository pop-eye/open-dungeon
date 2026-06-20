@echo off
REM ============================================================================
REM  Open Dungeon - Twitch streaming setup
REM
REM  Run this once before your first stream. It creates the config files
REM  the Twitch bot needs and adds the required env vars to .env.local.
REM ============================================================================

setlocal
cd /d "%~dp0"

echo.
echo ============================================================
echo  Open Dungeon - Twitch Streaming Setup
echo ============================================================
echo.

REM ---- Create twitch-bot\.env if missing ----------------------------------
if exist "twitch-bot\.env" (
  echo [setup] twitch-bot\.env already exists - skipping bot config.
  echo [setup] Edit it manually if you need to change credentials.
  goto check_secret
)

echo [setup] Creating twitch-bot\.env from template...
copy "twitch-bot\.env.example" "twitch-bot\.env" >nul
echo.
echo [setup] STEP 1 of 3: Twitch bot credentials
echo.
echo You need a Twitch account for the bot - it can be your main account
echo or a dedicated bot account ^(recommended^).
echo.
set /p BOT_USERNAME=[setup] Bot Twitch username:
echo.
echo Get an OAuth token for the bot account at:
echo   https://twitchapps.com/tmi/
echo Log in as the BOT account ^(not your main account^), then copy the token.
echo.
set /p BOT_TOKEN=[setup] Bot OAuth token ^(oauth:xxxx...^):
echo.
set /p CHANNEL=[setup] Your Twitch channel name ^(without #^):

REM Write the values into twitch-bot\.env
powershell -Command "(Get-Content 'twitch-bot\.env') -replace 'TWITCH_BOT_USERNAME=.*', 'TWITCH_BOT_USERNAME=%BOT_USERNAME%' | Set-Content 'twitch-bot\.env'"
powershell -Command "(Get-Content 'twitch-bot\.env') -replace 'TWITCH_BOT_OAUTH_TOKEN=.*', 'TWITCH_BOT_OAUTH_TOKEN=%BOT_TOKEN%' | Set-Content 'twitch-bot\.env'"
powershell -Command "(Get-Content 'twitch-bot\.env') -replace 'TWITCH_CHANNEL=.*', 'TWITCH_CHANNEL=%CHANNEL%' | Set-Content 'twitch-bot\.env'"

echo.
echo [setup] Bot credentials saved to twitch-bot\.env

:check_secret
REM ---- Add STREAM_API_SECRET to .env.local if missing ---------------------
echo.
echo [setup] STEP 2 of 3: Stream API secret

if not exist ".env.local" (
  if exist ".env.example" (
    copy ".env.example" ".env.local" >nul
    echo [setup] Created .env.local from .env.example
  ) else (
    echo. > ".env.local"
  )
)

findstr /i "STREAM_API_SECRET" ".env.local" >nul 2>nul
if not errorlevel 1 (
  echo [setup] STREAM_API_SECRET already set in .env.local - skipping.
  goto vote_mode
)

REM Generate a random secret using PowerShell
for /f "delims=" %%s in ('powershell -Command "[System.Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).Replace('+','').Replace('/','').Replace('=','').Substring(0,32)"') do set GENERATED_SECRET=%%s

echo STREAM_API_SECRET=%GENERATED_SECRET%>> ".env.local"
echo.
echo [setup] Generated and saved STREAM_API_SECRET to .env.local
echo [setup] The bot reads it automatically - you don't need to copy it anywhere.

:vote_mode
REM ---- Ask about voting mode ----------------------------------------------
echo.
echo [setup] STEP 3 of 3: Viewer interaction mode
echo.
echo How should viewers control the story?
echo.
echo   1. Voting mode ^(default^) - viewers vote, most popular action wins
echo      Each viewer casts one vote. A mod opens rounds with !vote
echo      Best for larger streams with many viewers.
echo.
echo   2. Direct mode - first valid command goes straight through
echo      Anyone can submit actions in real time ^(with a rate limit^).
echo      Best for small streams or trusted communities.
echo.
set /p VOTE_CHOICE=[setup] Choose 1 or 2 ^(default: 1^):
if "%VOTE_CHOICE%"=="2" (
  powershell -Command "(Get-Content 'twitch-bot\.env') -replace 'DIRECT_SUBMIT=false', 'DIRECT_SUBMIT=true' | Set-Content 'twitch-bot\.env'"
  echo [setup] Direct mode enabled.
) else (
  echo [setup] Voting mode selected.
)

REM ---- Done ---------------------------------------------------------------
echo.
echo ============================================================
echo  Setup complete!
echo ============================================================
echo.
echo Next steps:
echo.
echo  1. Start the stream stack:
echo       .\run.bat --stream
echo.
echo  2. Open the app, create a story, and copy its ID from the URL:
echo       http://localhost:3000/?chat=^<chatId^>
echo.
echo  3. In your Twitch chat, type:
echo       !chat ^<chatId^>
echo.
echo  4. Add an OBS Browser Source for the overlay:
echo       URL:    http://localhost:3000/overlay/^<chatId^>?transparent=1
echo       Width:  800   Height: 600
echo       Check "Allow transparency"
echo.
echo  5. Tell viewers to use:
echo       !do ^<action^>    !say ^<words^>    !continue
echo       !odhelp  ^(shows full command list^)
echo.
if not "%VOTE_CHOICE%"=="2" (
  echo  6. Open voting rounds as a mod with:
  echo       !vote [seconds]
  echo.
)
pause
endlocal
