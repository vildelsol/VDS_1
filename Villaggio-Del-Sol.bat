@echo off
REM ============================================================
REM  VILLAGGIO DEL SOL - one file, one double-click.
REM
REM  First run: installs, builds, makes a desktop icon, starts.
REM  Every run after: starts straight away.
REM  There is nothing else to run and nothing to activate.
REM ============================================================
setlocal
title Villaggio Del Sol
color 0A
cd /d "%~dp0"

set "LOGFILE=%~dp0last-run-log.txt"
echo Villaggio Del Sol launcher - %DATE% %TIME% > "%LOGFILE%"

echo.
echo   ============================================================
echo      VILLAGGIO DEL SOL
echo   ============================================================
echo.

REM --- Node.js present? -------------------------------------
where node >nul 2>nul
if errorlevel 1 goto :noNode

REM --- First run: install components ------------------------
if exist "node_modules" goto :haveModules
echo   Setting up for the first time. This takes a few minutes.
echo   Please leave this window open...
echo.
call npm install >> "%LOGFILE%" 2>&1
if errorlevel 1 goto :failed
:haveModules

REM --- First run: build the application ---------------------
if exist "dist\server.cjs" goto :haveBuild
echo   Preparing the application...
echo.
call npm run build >> "%LOGFILE%" 2>&1
if errorlevel 1 goto :failed
:haveBuild

REM --- Desktop icon, created once ---------------------------
if exist "%USERPROFILE%\Desktop\Villaggio Del Sol.lnk" goto :haveIcon
powershell -NoProfile -Command "$w=New-Object -COM WScript.Shell; $s=$w.CreateShortcut($w.SpecialFolders('Desktop')+'\Villaggio Del Sol.lnk'); $s.TargetPath='%~f0'; $s.WorkingDirectory='%~dp0.'; $s.IconLocation='%SystemRoot%\System32\shell32.dll,13'; $s.Description='Villaggio Del Sol Property Operations'; $s.Save()" >> "%LOGFILE%" 2>&1
echo   A "Villaggio Del Sol" icon has been added to your Desktop.
echo.
:haveIcon

REM --- Start the server -------------------------------------
set NODE_ENV=production
set PORT=3000
if exist ".env" for /f "usebackq tokens=1,2 delims==" %%A in (".env") do if /I "%%A"=="PORT" set PORT=%%B

echo   Starting up. Your browser will open in a moment.
echo.
echo   KEEP THIS WINDOW OPEN while the program is being used.
echo   Closing this window shuts the program down.
echo.
echo   ------------------------------------------------------------
echo.

start "" cmd /c "timeout /t 5 >nul & start "" http://localhost:%PORT%"

node dist\server.cjs

echo.
echo   The program has stopped.
echo.
pause
exit /b 0

:noNode
echo   One thing is needed first: Node.js. It is free and safe,
echo   and only has to be installed once on this computer.
echo.
echo   1. The download page will open now.
echo   2. Download the big green "LTS" button and install it
echo      (click Next, Next, Finish - the defaults are fine).
echo   3. Then double-click this file again.
echo.
start "" https://nodejs.org/en/download
echo   Press any key to close this window.
pause >nul
exit /b 1

:failed
echo.
echo   ============================================================
echo      Setup could not finish.
echo   ============================================================
echo.
echo   The details were saved to:
echo     %LOGFILE%
echo.
echo   Please send that file so the problem can be found.
echo.
echo   Press any key to close this window.
pause >nul
exit /b 1
