#!/usr/bin/env bash
# Verify the governance stack: containers up, proxy answering, and the redirect
# to Microsoft in place. Certificate issuance needs DNS, so TLS is checked with
# --resolve against loopback and -k.
set -uo pipefail

cd /opt/governance || exit 1

echo "=== conteneurs ==="
docker compose ps

echo
echo "=== journaux oauth2-proxy (10 dernieres lignes) ==="
docker compose logs --tail 10 oauth2proxy 2>&1 | tail -10

echo
echo "=== journaux autorite (5 dernieres lignes) ==="
docker compose logs --tail 5 authority 2>&1 | tail -5

echo
echo "=== routage HTTP -> HTTPS sur ce host ==="
curl -s -o /dev/null -w 'port 80: %{http_code} -> %{redirect_url}\n' \
  -H 'Host: governance.duke-analytics.com' http://127.0.0.1/ || true

echo "=== sans session, en TLS local (certificat auto-signe tolere) ==="
curl -sk -o /dev/null -w 'port 443: %{http_code} -> %{redirect_url}\n' \
  --resolve governance.duke-analytics.com:443:127.0.0.1 \
  https://governance.duke-analytics.com/ || true

echo
echo "=== routeur connu de Traefik ? ==="
docker logs tellus-ai-traefik-1 --tail 40 2>&1 | grep -i 'governance' | tail -6 || echo "aucune ligne governance dans les 40 dernieres"
