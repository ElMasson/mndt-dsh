#!/usr/bin/env bash
# Read-only: how Traefik is configured, and which routers already exist.
set -uo pipefail

echo "=== traefik.yml (statique, sans secrets) ==="
grep -vE 'password|token|secret' /data/app/tellus-ai/traefik.yml | head -40

echo
echo "=== routeurs existants dans traefik-dynamic.yml ==="
grep -nE '^\s{0,4}[a-zA-Z0-9_-]+:|Host\(|service:|middlewares:|certResolver|entryPoints' /data/app/tellus-ai/traefik-dynamic.yml | head -40

echo
echo "=== taille du fichier dynamique ==="
wc -l /data/app/tellus-ai/traefik-dynamic.yml
