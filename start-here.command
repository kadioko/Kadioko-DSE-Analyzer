#!/usr/bin/env bash
# ===================================================================
#  Kadioko DSE Analyzer - double-click launcher for macOS and Linux
#
#  macOS: double-click this file in Finder.
#  Linux: double-click and choose "Run in Terminal", or run it from
#         a terminal.
#
#  It changes to its own folder first, so it works from anywhere.
# ===================================================================
set -uo pipefail
cd "$(dirname "$0")" || exit 1

echo ""
echo "  =========================================="
echo "    KADIOKO DSE ANALYZER"
echo "  =========================================="
echo ""
echo "  Setting things up. This window will explain"
echo "  anything it needs from you."
echo ""

pause_and_exit() {
  echo ""
  read -r -p "  Press Enter to close this window. " _
  exit "${1:-0}"
}

# ---- Is Node.js installed? ----------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "  [X] Node.js is not installed on this computer."
  echo ""
  echo "  Kadioko needs it to run. It is free and safe."
  echo ""
  echo "  1. Go to  https://nodejs.org/en/download"
  echo "  2. Download the version marked LTS"
  echo "  3. Install it, accepting all the defaults"
  echo "  4. Close this window, then double-click start-here again"
  echo ""
  command -v open >/dev/null 2>&1 && open "https://nodejs.org/en/download"
  pause_and_exit 1
fi

MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 20 ]; then
  echo "  [X] Node.js $(node --version) is too old. Version 20 or newer is needed."
  echo "      Install the LTS version from https://nodejs.org and try again."
  pause_and_exit 1
fi

echo "  [ok] Node.js $(node --version) found."
echo ""

# ---- Hand over to the setup script --------------------------------
if ! npm run setup; then
  echo ""
  echo "  ------------------------------------------"
  echo "  Setup did not finish."
  echo ""
  echo "  Read the messages above - the line marked"
  echo "  XX says what to fix. The most common one is"
  echo "  needing a database address in the .env file."
  echo ""
  echo "  Full instructions are in QUICKSTART.md"
  echo "  ------------------------------------------"
  pause_and_exit 1
fi

pause_and_exit 0
