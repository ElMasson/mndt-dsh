#!/usr/bin/env bash
# Build and run the mndt workbench on the server, under Linux.
#
# The portable install produced on Windows could not run here (native binaries,
# node 18). This script builds from source inside a node 22 container, publishes a
# portable install, then runs it as a container bound to loopback.
set -euo pipefail

SRC=/opt/mndt-src
OUT=/out
STATE=/var/lib/dsh/mndt

echo "=== espace disque ==="
df -h / | tail -1
AVAILABLE_GB=$(df -BG / | awk 'NR==2 {gsub("G","",$4); print $4}')
if [ "$AVAILABLE_GB" -lt 6 ]; then
  echo "espace insuffisant: ${AVAILABLE_GB} Go"; exit 1
fi

echo "=== extraction du source ==="
rm -rf "$SRC"
mkdir -p "$SRC" "$OUT" "$STATE/home"
python3 -m zipfile -e /root/mndt-src.zip "$SRC"

echo "=== construction dans node 22 ==="
docker run --rm -v "$SRC":/src -v "$OUT":/out -w /src node:22-bookworm bash -lc '
  set -euo pipefail
  corepack enable
  pnpm --version
  pnpm install --frozen-lockfile
  pnpm exec tsx scripts/build.ts --scope artifacts
  pnpm --filter @deepseek-ai/dsh deploy --prod --legacy /out
  ls /out | head -5
'

echo "=== arret d une instance precedente ==="
docker rm -f mndt-workbench >/dev/null 2>&1 || true

echo "=== demarrage ==="
docker run -d --name mndt-workbench --restart unless-stopped --network host \
  -v "$OUT":/app -v "$STATE":/state \
  -e DSH_MNDT_IDENTITY=duke@datanalysis.re \
  -e DSH_MNDT_LOCAL_OWNER=duke@datanalysis.re \
  -e DSH_MNDT_STATE=/state/state.json \
  -e DSH_MNDT_PORT=8795 \
  -e DSH_MNDT_HOST=127.0.0.1 \
  -e DSH_MNDT_BRIEFING_AT=06:30 \
  -e DSH_PERMISSION_MODE=danger-full-access \
  -e DSH_HOME=/state/home \
  node:22-bookworm node /app/lib/index.js web --port 3111 --no-open

sleep 30
echo "=== etat ==="
docker ps --filter name=mndt-workbench --format '{{.Status}}'
echo "--- sante API produit ---"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8795/health || true
echo "--- page servie ---"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3111/ || true
echo "--- journal ---"
docker logs --tail 12 mndt-workbench 2>&1 | tail -12
