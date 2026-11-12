#!/bin/bash
# start.command — double-click in Finder to start abswitch's controller (takectl) and open its page.
#
# Checks for Node.js 22 or later and says what to install if it is missing; starts takectl (in setup
# mode when there is no takectl.config.json yet); opens http://localhost:<port>/ in the browser as
# soon as takectl answers. Close this window, or press Ctrl+C, to stop takectl.
#
# The first time, macOS may refuse a file downloaded from the internet: right-click start.command,
# choose Open, then Open again.
#
# Test hooks (leave unset): ABSWITCH_NO_DIALOG=1 skips the macOS dialog and the keypress wait;
# ABSWITCH_EXTRA_PATH replaces the folders added to PATH to find Node.

cd "$(dirname "$0")" || exit 1
export PATH="$PATH:${ABSWITCH_EXTRA_PATH-/opt/homebrew/bin:/usr/local/bin}"
NEED=22

stop() {
  echo
  echo "$1"
  echo
  if [ -z "$ABSWITCH_NO_DIALOG" ]; then
    osascript -e "display dialog \"$1\" with title \"abswitch\" buttons {\"OK\"} default button 1 with icon caution" >/dev/null 2>&1
    read -n 1 -s -r -p "Press any key to close this window."
  fi
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  stop "abswitch needs Node.js $NEED or later, and this Mac does not have it. Install the LTS version from https://nodejs.org (the macOS installer), then double-click start.command again."
fi
MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
if ! [ "$MAJOR" -ge "$NEED" ] 2>/dev/null; then
  stop "abswitch needs Node.js $NEED or later; this Mac has $(node -v 2>/dev/null || echo 'a version that does not run'). Install the LTS version from https://nodejs.org, then double-click start.command again."
fi

PORT=$(node -e 'const f=require("fs");for(const n of ["takectl.config.json","takectl.config.example.json"]){try{console.log(JSON.parse(f.readFileSync(n,"utf8")).port||8991);process.exit(0)}catch{}}console.log(8991)')
URL="http://localhost:$PORT/"

if curl -s -m 1 -o /dev/null "${URL}state"; then
  echo "takectl is already running: opening $URL"
  open "$URL"
  exit 0
fi

# Open the page once takectl answers (it serves /setup first when there is no config yet).
( for _ in $(seq 1 80); do
    sleep 0.25
    if curl -s -m 1 -o /dev/null "${URL}state"; then open "$URL"; exit 0; fi
  done ) &

echo "Starting takectl with Node $(node -v). The page opens at $URL; close this window to stop."
exec node takectl.mjs
