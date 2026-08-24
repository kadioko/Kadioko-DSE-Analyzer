@echo off
REM ===================================================================
REM  Kadioko DSE Analyzer - double-click launcher for Windows
REM
REM  Someone who downloaded this folder should be able to double-click
REM  this file and get a running system, without opening a terminal or
REM  knowing what npm is.
REM
REM  It changes to its own folder first, so it works from anywhere:
REM  Downloads, Desktop, a USB stick.
REM ===================================================================

title Kadioko DSE Analyzer - Setup
cd /d "%~dp0"

echo.
echo   ==========================================
echo     KADIOKO DSE ANALYZER
echo   ==========================================
echo.
echo   Setting things up. This window will explain
echo   anything it needs from you.
echo.

REM ---- Is Node.js installed? ----------------------------------------
where node >nul 2>nul
if errorlevel 1 goto NO_NODE

for /f "tokens=*" %%v in ('node --version') do set NODEVER=%%v
echo   [ok] Node.js %NODEVER% found.
echo.

REM ---- Hand over to the setup script --------------------------------
call npm run setup
if errorlevel 1 goto SETUP_FAILED

goto DONE

REM ===================================================================
:NO_NODE
echo   [X] Node.js is not installed on this computer.
echo.
echo   Kadioko needs it to run. It is free and safe.
echo.
echo   1. A download page will open in your browser
echo   2. Download the button marked "LTS"
echo   3. Install it, accepting all the defaults
echo   4. Close this window, then double-click START-HERE again
echo.
pause
start "" "https://nodejs.org/en/download"
exit /b 1

REM ===================================================================
:SETUP_FAILED
echo.
echo   ------------------------------------------
echo   Setup did not finish.
echo.
echo   Read the messages above - the line marked
echo   XX says what to fix. The most common one is
echo   needing a database address in the .env file.
echo.
echo   Full instructions are in QUICKSTART.md
echo   ------------------------------------------
echo.
pause
exit /b 1

REM ===================================================================
:DONE
echo.
echo   Finished. You can close this window.
echo.
pause
exit /b 0
