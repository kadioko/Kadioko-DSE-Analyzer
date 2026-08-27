@echo off
REM ===================================================================
REM  What the daily scheduled job actually runs.
REM
REM  It lives in a file rather than in the task definition because
REM  Windows Task Scheduler caps a task's command at 261 characters,
REM  and this project's path alone eats a third of that.
REM
REM  Two steps: fetch the session the exchange is publishing, then send
REM  anything new to the platform. Chained so a failed fetch does not go
REM  on to sync, because there would be nothing new to send.
REM
REM  A day with nothing published is not a failure. The fetch exits
REM  cleanly having written nothing and the sync finds nothing new, so
REM  a quiet day stays quiet.
REM ===================================================================

REM %~dp0 is this file's own folder, so the job works wherever the
REM project is checked out.
cd /d "%~dp0.."

call npm run fetch
if errorlevel 1 (
  echo Fetch failed; not syncing.
  exit /b 1
)

call npm run sync
exit /b %errorlevel%
