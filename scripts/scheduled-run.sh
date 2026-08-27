#!/bin/bash
# ===================================================================
#  What the daily scheduled job actually runs, on macOS and Linux.
#
#  Kept in a file to match the Windows runner, and so the crontab line
#  stays short and readable.
#
#  Two steps: fetch the session the exchange is publishing, then send
#  anything new to the platform. Chained so a failed fetch does not go
#  on to sync, because there would be nothing new to send.
#
#  A day with nothing published is not a failure. The fetch exits
#  cleanly having written nothing and the sync finds nothing new, so a
#  quiet day stays quiet.
# ===================================================================

# Resolve this file's own folder, so the job works wherever the project
# is checked out.
cd "$(dirname "$0")/.." || exit 1

if ! npm run fetch; then
  echo "Fetch failed; not syncing."
  exit 1
fi

npm run sync
