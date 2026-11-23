#!/bin/sh
# Workbench entrypoint.
#
# The web shell mints a launch token at boot and prints it once. The front
# gateway needs that token to bootstrap a browser arriving through single
# sign-on, so this wrapper publishes it to a shared file and keeps the log.
set -eu

STATE=${DSH_HOME:-/state/home}
# Inside a bridge network the shell must bind the interface address: a wildcard is
# rejected and the loopback is unreachable from the front.
WEB_BIND=${WEB_HOST:-}
if [ -z "$WEB_BIND" ]; then
  WEB_BIND=$(hostname -i 2>/dev/null | awk "{print \$1}")
fi
[ -n "$WEB_BIND" ] || WEB_BIND=127.0.0.1
mkdir -p "$STATE"
# The shell prints its launch token in this log: on a team tenant it lives with
# the published token, outside /state (DSH_MNDT_WEB_LOG).
LOG="${DSH_MNDT_WEB_LOG:-$STATE/web.log}"
TOKEN_FILE="${DSH_MNDT_WEB_TOKEN_FILE:-/state/web-token}"
rm -f "$TOKEN_FILE"
# A token published elsewhere than /state (team tenant): the one an earlier
# version left under /state goes, and the log that printed it, they never stay
# where agents' state lives.
if [ "$TOKEN_FILE" != "/state/web-token" ]; then rm -f /state/web-token; fi
if [ "$LOG" != "$STATE/web.log" ]; then rm -f "$STATE/web.log"; fi

# The log of the previous start is kept once, as $LOG.1, before this start
# empties $LOG: what the workbench said then (a role-file row set aside, a
# mandate retired, a missing gateway secret) survives one restart. Its launch
# tokens are replaced on the way: that process is gone, and a token never stays
# in a log kept after it. One previous log only, never an endless append.
if [ -s "$LOG" ]; then
  if sed 's/token=[A-Za-z0-9_-]*/token=…/g' "$LOG" > "$LOG.1.tmp"; then
    chmod --reference="$LOG" "$LOG.1.tmp" 2>/dev/null || true
    mv -f "$LOG.1.tmp" "$LOG.1"
  else
    rm -f "$LOG.1.tmp"
  fi
fi

node /app/apps/cli/lib/bin.js web \
  --host "$WEB_BIND" \
  --port 3111 \
  --no-open \
  --public-url "${PUBLIC_URL:-https://mndt.duke-analytics.com/}" \
  --trusted-host "${TRUSTED_HOST:-mndt.duke-analytics.com}" \
  > "$LOG" 2>&1 &
pid=$!

# The launch token is printed only once every plugin settled: a connector whose
# server starts but does not answer can hold it for minutes. Watch for it as long
# as the web process lives, never give up in silence: a token published late is
# still published, and the gateway reads the file again when it changes.
(
  attempt=0
  published=''
  while kill -0 "$pid" 2>/dev/null; do
    token=$(grep -o 'token=[A-Za-z0-9_-]*' "$LOG" 2>/dev/null | tail -1 | cut -d= -f2 || true)
    if [ -n "$token" ] && [ "$token" != "$published" ]; then
      # Written whole or not at all, owner-only: the gateway never reads half a token.
      (umask 077 && printf '%s' "$token" > "$TOKEN_FILE.tmp") && mv -f "$TOKEN_FILE.tmp" "$TOKEN_FILE"
      if [ -z "$published" ]; then
        echo "workbench: launch token published after ${attempt} s"
      else
        echo "workbench: a new launch token was published"
      fi
      published=$token
    fi
    attempt=$((attempt + 1))
    if [ -z "$published" ] && [ "$attempt" = "${DSH_MNDT_TOKEN_WARN_AFTER:-180}" ]; then
      echo "workbench: no launch token after ${attempt} s, still waiting; a plugin has not settled (see $LOG)" >&2
    fi
    sleep 1
  done
  if [ -z "$published" ]; then
    echo "workbench: the web process exited before printing its launch token" >&2
    tail -20 "$LOG" >&2 || true
  fi
) &

# dsh web's exit code is the container's; the second wait lets the watcher finish
# its last words (and the log's last lines) before PID 1 ends.
status=0
wait "$pid" || status=$?
wait
exit "$status"
