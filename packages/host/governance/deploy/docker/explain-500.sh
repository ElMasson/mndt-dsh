#!/usr/bin/env bash
# Read the last minutes of the SSO front to explain an HTTP 500 seen in a browser.
set -uo pipefail
cd /opt/governance || exit 1

echo "=== etat ==="
docker compose ps

echo
echo "=== oauth2-proxy, 30 dernieres lignes ==="
docker compose logs --tail 30 oauth2proxy 2>&1 | tail -30

echo
echo "=== traefik, requetes vers /oauth2 ==="
docker logs tellus-ai-traefik-1 --tail 200 2>&1 | grep -i 'oauth2' | tail -5
