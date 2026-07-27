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
echo Folder: %~dp0 >> "%LOGFILE%"

echo.
echo   ============================================================
echo      VILLAGGIO DEL SOL
echo   ============================================================
echo.

REM --- Must be in its own folder, not loose on a drive ------
REM When the files are extracted straight onto C:\ instead of into a folder,
REM every path below resolves against the whole drive: Node then looks for
REM C:\dist\server.cjs, and the build tries to scan the entire disk and never
REM finishes. Detect a drive root (where %~dp0 is just "C:\") and stop with
REM plain instructions rather than failing cryptically later.
if /I "%~dp0"=="%~d0\" goto :atDriveRoot

REM --- Node.js present? -------------------------------------
where node >nul 2>nul
if errorlevel 1 goto :noNode

REM --- Install components (first run, or a previous install cut short) ------
REM Checks a real dependency, not just the folder, so a half-finished install
REM is completed rather than mistaken for a good one.
if exist "node_modules\express\package.json" goto :haveModules
echo   Setting up for the first time. This takes a few minutes.
echo   Please leave this window open...
echo.
call npm install >> "%LOGFILE%" 2>&1
if errorlevel 1 goto :failed
:haveModules

REM --- Build the application (first run, or if the build is missing) --------
if exist "dist\server.cjs" goto :haveBuild
echo   Preparing the application...
echo.
call npm run build >> "%LOGFILE%" 2>&1
:haveBuild

REM --- The build must actually be there before we try to launch it ---------
REM The build "succeeding" is not enough - verify the file exists, so a build
REM that produced nothing turns into a clear message instead of a Node crash.
if not exist "dist\server.cjs" goto :noBuild

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

REM The server opens the browser itself, the moment it is actually ready to
REM answer. A fixed timer in a second window used to open it too early on a
REM first run, leaving the browser loading against a server that had not
REM finished starting.
set VDS_OPEN_BROWSER=1

echo   Starting up. Your browser will open by itself when ready.
echo   On the very first run this can take up to a minute.
echo.
echo   KEEP THIS WINDOW OPEN while the program is being used.
echo   Closing this window shuts the program down.
echo.
echo   ------------------------------------------------------------
echo.

node dist\server.cjs

echo.
echo   The program has stopped.
echo.
pause
exit /b 0

:atDriveRoot
echo.
echo   ============================================================
echo      Please move this into its own folder first.
echo   ============================================================
echo.
echo   These files are sitting directly on the %~d0 drive, which the
echo   program cannot run from.
echo.
echo   1. Make a new, empty folder, for example:  %~d0\Villaggio
echo   2. Move ALL of these files into that folder
echo      (including this Villaggio-Del-Sol file).
echo   3. Open that folder and double-click Villaggio-Del-Sol there.
echo.
echo   Tip: when unzipping, use "Extract All" and let it create its
echo   own folder - do not extract onto the C: drive itself.
echo.
echo   Press any key to close this window.
pause >nul
exit /b 1

:noBuild
echo.
echo   ============================================================
echo      The application could not be prepared.
echo   ============================================================
echo.
echo   The build did not finish, so there is nothing to start yet.
echo   The details were saved to:
echo     %LOGFILE%
echo.
echo   Please send that file so the problem can be found. A restart
echo   of this computer, then double-clicking again, often clears it.
echo.
echo   Press any key to close this window.
pause >nul
exit /b 1

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
