#!/usr/bin/env bash
# Build the portable install in WSL (node 22 installed there), then package it.
set -euo pipefail
export PATH=/usr/local/lib/node22/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/sbin:/bin
export HOME=/root
SRC=/root/mndt-src
OUT=/root/mndt-out
HASH="$1"
WIN="/mnt/c/Project AI/deepseek-harness"

npm install -g pnpm@11.28.5 >/dev/null 2>&1 || true
node -v
pnpm -v

rm -rf "$SRC" "$OUT"
mkdir -p "$SRC"
tar -xf "/mnt/c/Users/StephaneMASSON/AppData/Local/Temp/mndt-src.tar" -C "$SRC"
cd "$SRC"

pnpm install --no-frozen-lockfile
pnpm exec tsx scripts/generate-typert.ts
DSH_CLIENT_COMMIT_HASH="$HASH" pnpm exec tsx scripts/build.ts --scope artifacts
pnpm add -w unrun >/dev/null 2>&1 || true
pnpm exec tsdown --filter @deepseek-ai/dsh
test -f apps/cli/lib/bin.js || { echo "bundle cli absent"; exit 1; }
pnpm --filter @deepseek-ai/dsh deploy --prod --legacy "$OUT"
du -sh "$OUT"
tar -czf "$WIN/packages/host/mndt/deploy/mndt-deploy.tgz" -C "$OUT" .
ls -lh "$WIN/packages/host/mndt/deploy/mndt-deploy.tgz"
