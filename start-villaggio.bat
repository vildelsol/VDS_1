@echo off
REM ============================================================
REM  Villaggio Del Sol - start the program (run on the HP)
REM  The desktop shortcut points here. It starts the server and
REM  opens the app in your browser.
REM ============================================================
title Villaggio Del Sol - Server (leave this window open)
color 0A
cd /d "%~dp0"

REM Production mode = serve the built app and keep sessions working on the LAN.
set NODE_ENV=production

REM Default port; the setup writes the real one into .env, which the app reads.
set PORT=3000
if exist ".env" for /f "usebackq tokens=1,2 delims==" %%A in (".env") do if /I "%%A"=="PORT" set PORT=%%B

echo.
echo   Starting Villaggio Del Sol...
echo   Keep THIS window open while staff are using the program.
echo   To stop the program, close this window.
echo.

REM Open the browser a few seconds after the server starts.
start "" cmd /c "timeout /t 4 >nul & start "" http://localhost:%PORT%"

node dist\server.cjs

echo.
echo   The server has stopped. Press any key to close.
pause >nul
