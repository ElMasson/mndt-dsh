#!/bin/sh
set -eu
# A screen, a window manager, then the control server. Nothing else runs here.
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
sleep 1
DISPLAY=:99 openbox >/tmp/openbox.log 2>&1 &
sleep 1
exec node /app/desktop-agent.mjs
