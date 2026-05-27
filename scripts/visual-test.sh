#!/usr/bin/env bash
# Visual smoke test for NexuSSH on DE-1 via Xvfb + scrot.

set -e

BIN="${1:-/matrix/nexussh/desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/nexussh}"
SHOTS=/tmp/nexussh-shots
mkdir -p "$SHOTS"
rm -f "$SHOTS"/*.png

if [ ! -x "$BIN" ]; then
  echo "❌ binary not found at $BIN"
  exit 1
fi

DISPLAY_NUM=99
WIDTH=1440
HEIGHT=900
echo "→ starting Xvfb :$DISPLAY_NUM (${WIDTH}x${HEIGHT})..."
Xvfb :$DISPLAY_NUM -screen 0 ${WIDTH}x${HEIGHT}x24 -ac &
XVFB_PID=$!
sleep 2

cleanup() {
  kill $XVFB_PID 2>/dev/null || true
  kill $APP_PID 2>/dev/null || true
  pkill -f nexussh 2>/dev/null || true
}
trap cleanup EXIT

export DISPLAY=:$DISPLAY_NUM
echo "→ launching NexuSSH..."
"$BIN" >/tmp/nexussh-stdout.log 2>&1 &
APP_PID=$!
sleep 5

snap() { scrot "$SHOTS/$1.png" 2>/dev/null && echo "   → $1.png"; sleep 1; }

snap 01-launch
# Add a test host so we have something to drag and a folder to test
# Click + add host
xdotool mousemove 210 58 click 1 2>/dev/null || true
sleep 2
snap 02-add-host-dialog
xdotool key Escape 2>/dev/null || true
sleep 1

# Ctrl+, open Settings
xdotool key ctrl+comma 2>/dev/null || true
sleep 2
snap 03-settings

# Theme cards center: row1 at y~395, col1 x~760, col2 x~995
echo "→ click Solarized card"
xdotool mousemove 995 395 click 1 2>/dev/null || true
sleep 1
snap 04-after-solarized-click

# Click Dracula (row2 col1)
echo "→ click Dracula"
xdotool mousemove 760 580 click 1 2>/dev/null || true
sleep 1
snap 05-after-dracula-click

# Back to terminal via Esc
xdotool key Escape 2>/dev/null || true
sleep 1
snap 06-back-to-terminal

# Open History
xdotool mousemove 1031 17 click 1 2>/dev/null || true
sleep 2
snap 07-history-panel

# Click maximize button (top right area of modal)
xdotool mousemove 1280 70 click 1 2>/dev/null || true
sleep 1
snap 08-history-fullscreen

# Close history
xdotool key Escape 2>/dev/null || true
sleep 1
snap 09-final

echo "→ done"
ls -la "$SHOTS"
