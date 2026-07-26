@echo off
REM ============================================================
REM  Villaggio Del Sol - run the automated test suite
REM  Double-click this file. It checks the app and prints a
REM  pass/fail summary. Nothing here changes any real data.
REM ============================================================
title Villaggio Del Sol - Tests
color 0B
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is needed the first time. It is free and takes 2 minutes.
  echo   The download page will open now. Install the "LTS" version,
  echo   then double-click this file again.
  echo.
  start "" https://nodejs.org/en/download
  pause >nul
  exit /b 1
)

if not exist "node_modules" (
  echo.
  echo   First run: installing components. This happens once and
  echo   takes a few minutes. Please wait...
  echo.
  call npm install
  if errorlevel 1 goto :failed
)

echo.
echo   Building and running the full test suite...
echo.
call npm test
if errorlevel 1 goto :failed

echo.
echo   ============================================================
echo      Look above. It should end with "83 passed, 0 failed".
echo      If anything failed, take a photo of this window.
echo   ============================================================
echo.
pause >nul
exit /b 0

:failed
echo.
echo   Something went wrong. Please take a photo of this window
echo   so it can be checked.
echo.
pause >nul
exit /b 1
