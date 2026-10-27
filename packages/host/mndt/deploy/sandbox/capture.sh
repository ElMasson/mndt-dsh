#!/bin/sh
# Screenshot one URL into /out, then exit. Nothing else runs in this container.
#
# Usage: capture.sh <url> [output]
# The browser writes into /tmp first because /out is a bind mount whose
# permissions belong to the host; the copy is the only thing done as a file
# write outside the browser profile.
set -eu

url=${1:-about:blank}
output=${2:-/out/screenshot.png}
rm -f /tmp/shot.png

chromium \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --no-first-run \
  --disable-extensions \
  --disable-crash-reporter \
  --disable-breakpad \
  --no-zygote \
  --hide-scrollbars \
  --user-data-dir=/tmp/chrome \
  --virtual-time-budget=8000 \
  --window-size=1280,800 \
  --screenshot=/tmp/shot.png \
  "$url" >/dev/null 2>&1 || true

if [ -s /tmp/shot.png ]; then
  cp /tmp/shot.png "$output"
  echo "capture ecrite: $output"
else
  echo "aucune capture produite" >&2
  exit 1
fi
