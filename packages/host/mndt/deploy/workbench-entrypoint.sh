#!/bin/sh
# Workbench entrypoint.
#
# The web shell mints a launch token at boot and prints it once. The front
# gateway needs that token to bootstrap a browser arriving through single
# sign-on, so this wrapper publishes it to a shared file and keeps the log.
set -eu

STATE=${DSH_HOME:-/state/home}
mkdir -p "$STATE"
LOG="$STATE/web.log"
TOKEN_FILE="${DSH_MNDT_WEB_TOKEN_FILE:-/state/web-token}"
rm -f "$TOKEN_FILE"

node /app/apps/cli/lib/bin.js web \
  --host 127.0.0.1 \
  --port 3111 \
  --no-open \
  --public-url "${PUBLIC_URL:-https://mndt.duke-analytics.com/}" \
  --trusted-host "${TRUSTED_HOST:-mndt.duke-analytics.com}" \
  > "$LOG" 2>&1 &
pid=$!

attempt=0
while [ "$attempt" -lt 180 ]; do
  token=$(grep -o 'token=[A-Za-z0-9_-]*' "$LOG" 2>/dev/null | tail -1 | cut -d= -f2 || true)
  if [ -n "$token" ]; then
    printf '%s' "$token" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
    echo "workbench: launch token published"
    break
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "workbench: the web process exited during startup" >&2
    tail -20 "$LOG" >&2 || true
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 1
done

wait "$pid"
