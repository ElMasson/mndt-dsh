#!/usr/bin/env bash
# Build and start the mndt workbench on the server itself.
#
# Two obstacles were proven here: the host typecheck needs more memory than the
# small root volume offers, and tsdown's config loader needs Node's native
# TypeScript stripping rather than the unrun bundler. Both are handled below.
set -euo pipefail

SRC=/data/mndt/src2
OUT=/data/mndt/out2
STATE=/data/mndt/state

echo "=== memoire avant ==="
free -g | head -2

echo "=== fichier d echange temporaire ==="
if ! swapon --show | grep -q '/data/swapfile'; then
  if [ ! -f /data/swapfile ]; then
    fallocate -l 8G /data/swapfile 2>/dev/null || dd if=/dev/zero of=/data/swapfile bs=1M count=8192 status=none
    chmod 600 /data/swapfile
    mkswap /data/swapfile >/dev/null
  fi
  swapon /data/swapfile
fi
free -g | head -2

echo "=== extraction ==="
rm -rf "$SRC" "$OUT"
mkdir -p "$SRC" "$OUT" "$STATE/home"
tar -xzf /root/mndt-src.tar.gz -C "$SRC"

echo "=== construction dans node 22 ==="
docker run --rm -v "$SRC":/src -v "$OUT":/out -w /src \
  -e NODE_OPTIONS="--experimental-strip-types --max-old-space-size=5120" \
  node:22-bookworm bash -lc '
    set -euo pipefail
    npm install -g pnpm@11.28.5 >/dev/null 2>&1
    pnpm install --frozen-lockfile
    pnpm exec tsx scripts/generate-typert.ts
    DSH_CLIENT_COMMIT_HASH=server pnpm exec tsx scripts/build.ts --scope artifacts
    if [ ! -f apps/cli/lib/bin.js ]; then
      pnpm exec tsdown --config-loader native --env.DSH_BUILD_FACE host --filter @deepseek-ai/dsh
    fi
    test -f apps/cli/lib/bin.js
    ls apps/cli/lib | head -3
    pnpm --filter @deepseek-ai/dsh deploy --prod --legacy /out
'

echo "=== demarrage ==="
docker rm -f mndt-workbench >/dev/null 2>&1 || true
docker run -d --name mndt-workbench --restart unless-stopped --network host \
  -v "$OUT":/app -v "$STATE":/state \
  -e DSH_MNDT_IDENTITY=duke@datanalysis.re -e DSH_MNDT_LOCAL_OWNER=duke@datanalysis.re \
  -e DSH_MNDT_STATE=/state/state.json -e DSH_MNDT_PORT=8795 -e DSH_MNDT_HOST=127.0.0.1 \
  -e DSH_MNDT_BRIEFING_AT=06:30 -e DSH_PERMISSION_MODE=danger-full-access -e DSH_HOME=/state/home \
  node:22-bookworm node /app/lib/bin.js web --port 3111 --no-open

sleep 40
echo "=== etat ==="
docker ps --filter name=mndt-workbench --format '{{.Status}}'
curl -s -m 5 http://127.0.0.1:8795/health; echo
curl -s -o /dev/null -w 'page=%{http_code}\n' -m 8 http://127.0.0.1:3111/
docker logs --tail 10 mndt-workbench 2>&1 | tail -10
