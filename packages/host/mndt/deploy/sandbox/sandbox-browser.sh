#!/usr/bin/env bash
# One hardened browser session: create, take a screenshot, destroy.
#
#   sandbox-browser.sh <identity> <url> <output.png>
#
# Every session is an ephemeral container named after the person and the run, so
# two people never share a browser. The flags are the isolation: read-only root,
# only two writable tmpfs, no capabilities, no-new-privileges, fixed non-root
# user, bounded processes, memory and CPU. The container is removed on exit,
# including when the screenshot fails.
set -euo pipefail

identity=${1:?identite requise}
url=${2:?url requise}
output=${3:-/tmp/screenshot.png}
image=${SANDBOX_IMAGE:-mndt-browser:test}
name="mndt-browser-$(printf '%s' "$identity" | tr '@.' '--')-$(date +%s)"

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mkdir -p "$(dirname "$output")"
rm -f "$output"

timeout 90 docker run --rm --name "$name" \
  --network bridge \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --tmpfs /home/browser:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --user 10001:10001 \
  --pids-limit 128 \
  --memory 768m \
  --cpus 1 \
  --mount "type=bind,src=$(dirname "$output"),dst=/out" \
  "$image" --screenshot=/out/"$(basename "$output")" "$url" >/dev/null 2>&1 || true

if [ -s "$output" ]; then
  echo "capture ecrite: $output ($(stat -c %s "$output") octets)"
else
  echo "aucune capture produite pour $identity" >&2
  exit 1
fi
