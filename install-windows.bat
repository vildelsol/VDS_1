@echo off
REM ============================================================
REM  Villaggio Del Sol - one-time installer for Windows
REM  Double-click this file. It sets everything up and makes a
REM  desktop icon. You only run this once, on the HP.
REM ============================================================
title Villaggio Del Sol - Installer
color 0B
cd /d "%~dp0"

echo.
echo   ============================================================
echo      VILLAGGIO DEL SOL - INSTALLER
echo   ============================================================
echo.

REM --- 1. Check that Node.js is installed --------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed yet. It is free and takes 2 minutes.
  echo.
  echo   1. The download page will open now.
  echo   2. Download the "LTS" version and install it (click Next, Next, Finish).
  echo   3. When it is done, run THIS file again.
  echo.
  start "" https://nodejs.org/en/download
  echo   Press any key to close.
  pause >nul
  exit /b 1
)

echo   [1/4] Installing the application components...
call npm install
if errorlevel 1 goto :failed

echo.
echo   [2/4] Building the application...
call npm run build
if errorlevel 1 goto :failed

echo.
echo   [3/4] Let's set up your folders and password...
echo.
call npm run setup
if errorlevel 1 goto :failed

echo.
echo   [4/4] Creating a desktop shortcut...
powershell -NoProfile -Command ^
  "$s=(New-Object -COM WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Villaggio Del Sol.lnk');" ^
  "$s.TargetPath='%~dp0start-villaggio.bat';" ^
  "$s.WorkingDirectory='%~dp0';" ^
  "$s.IconLocation='%SystemRoot%\System32\shell32.dll,13';" ^
  "$s.Description='Open Villaggio Del Sol Property Operations';" ^
  "$s.Save()"

echo.
echo   ============================================================
echo      DONE. You now have a "Villaggio Del Sol" icon on your
echo      desktop. Double-click it any time to start the program.
echo   ============================================================
echo.
echo   Press any key to close.
pause >nul
exit /b 0

:failed
echo.
echo   Something went wrong during install. Please take a photo of
echo   this window so it can be checked, then close and try again.
echo.
pause >nul
exit /b 1
