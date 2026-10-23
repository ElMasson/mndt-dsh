#!/usr/bin/env bash
# Show exactly why the last login attempt failed.
set -uo pipefail
cd /opt/governance || exit 1

echo "=== erreurs recentes du proxy ==="
docker compose logs --since 90m oauth2proxy 2>&1 | grep -iE 'error|invalid|denied|callback|redeem' | tail -15

echo
echo "=== dernieres requetes vers le callback ==="
docker compose logs --since 90m oauth2proxy 2>&1 | grep -E 'oauth2/callback' | tail -4

echo
echo "=== etat et horloge ==="
docker compose ps --format '{{.Name}} {{.Status}}'
date -u '+UTC %Y-%m-%d %H:%M:%S'
