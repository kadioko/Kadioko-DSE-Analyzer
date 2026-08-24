#!/bin/bash
# ===================================================================
#  Kadioko DSE Analyzer - double-click data update for macOS / Linux
#
#  Put today's DSE file into the data/incoming folder, then double-
#  click this. It sends anything new to the live platform and rebuilds
#  the analytics, valuations and rankings.
#
#  Safe to run as often as you like. Files already loaded are skipped,
#  and re-sending a corrected file updates it rather than duplicating.
# ===================================================================

cd "$(dirname "$0")" || exit 1

echo ""
echo "  =========================================="
echo "    KADIOKO - UPDATE DATA"
echo "  =========================================="
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  [x] Node.js is not installed."
  echo ""
  echo "  Download it from https://nodejs.org (choose the LTS version),"
  echo "  install it, then double-click this file again."
  echo ""
  read -r -p "  Press Enter to close." _
  exit 1
fi

if [ ! -f ".env.local" ]; then
  echo "  [x] This copy has not been set up yet."
  echo ""
  echo "  Double-click start-here.command first. It creates the"
  echo "  settings file this needs."
  echo ""
  read -r -p "  Press Enter to close." _
  exit 1
fi

node scripts/sync.mjs
status=$?

echo ""
if [ $status -eq 0 ]; then
  echo "  Done. Open the platform to see the new data."
else
  echo "  Some files did not load. The messages above say which and why."
  echo "  Rejected rows are listed with a reason on the /admin/data page."
fi
echo ""
read -r -p "  Press Enter to close." _
