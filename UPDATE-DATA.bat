@echo off
REM ===================================================================
REM  Kadioko DSE Analyzer - double-click data update for Windows
REM
REM  Put today's DSE file into the data\incoming folder, then double-
REM  click this. It sends anything new to the live platform and rebuilds
REM  the analytics, valuations and rankings.
REM
REM  Safe to run as often as you like. Files already loaded are skipped,
REM  and re-sending a corrected file updates it rather than duplicating.
REM ===================================================================

title Kadioko DSE Analyzer - Update Data
cd /d "%~dp0"

echo.
echo   ==========================================
echo     KADIOKO - UPDATE DATA
echo   ==========================================
echo.

REM ---- Is Node.js installed? ----------------------------------------
where node >nul 2>nul
if errorlevel 1 goto NO_NODE

REM ---- Has setup been run? ------------------------------------------
if not exist ".env.local" goto NO_ENV

REM ---- Show what will be sent, then send it -------------------------
node scripts\sync.mjs
if errorlevel 1 goto FAILED

echo.
echo   Done. Open the platform to see the new data.
echo.
goto END

:NO_NODE
echo   [x] Node.js is not installed.
echo.
echo   Download it from https://nodejs.org (choose the LTS version),
echo   install it, then double-click this file again.
echo.
goto END

:NO_ENV
echo   [x] This copy has not been set up yet.
echo.
echo   Double-click START-HERE.bat first. It creates the settings
echo   file this needs.
echo.
goto END

:FAILED
echo.
echo   Some files did not load. The messages above say which and why.
echo   Rejected rows are listed with a reason on the /admin/data page.
echo.

:END
echo   Press any key to close this window.
pause >nul
