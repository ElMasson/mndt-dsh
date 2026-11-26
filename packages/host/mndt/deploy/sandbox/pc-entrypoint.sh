#!/bin/sh
set -eu
# A member's computer: a screen, a window manager, then its two agents, both on
# the loopback. If one of them stops, the computer stops (the sidecar restarts
# it on the next call).
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
sleep 1
DISPLAY=:99 openbox >/tmp/openbox.log 2>&1 &
node /app/desktop-agent.mjs >/tmp/desktop-agent.log 2>&1 &
desktop=$!
node /app/browser-agent.mjs >/tmp/browser-agent.log 2>&1 &
browser=$!
while kill -0 "$desktop" 2>/dev/null && kill -0 "$browser" 2>/dev/null; do sleep 2; done
exit 1
