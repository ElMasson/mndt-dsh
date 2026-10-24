#!/usr/bin/env bash
# Prove the SSO configuration without DNS: ask oauth2-proxy directly for the
# unauthenticated root and print where it redirects. Also pin the trusted proxy
# range to the Traefik network instead of trusting every address.
set -uo pipefail

cd /opt/governance || exit 1

SUBNET=$(docker network inspect tellus-ai_default --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null | head -1)
echo "reseau Traefik: ${SUBNET:-introuvable}"

if [ -n "$SUBNET" ] && ! grep -q 'trusted_proxy_ip' /etc/oauth2-proxy/governance.cfg; then
  printf '\n# Only the Traefik network may supply X-Forwarded-* headers.\ntrusted_proxy_ip = ["%s"]\n' "$SUBNET" >> /etc/oauth2-proxy/governance.cfg
  chmod 0644 /etc/oauth2-proxy/governance.cfg
  echo "trusted_proxy_ip ajoute"
  docker compose up -d oauth2proxy >/dev/null 2>&1
  sleep 6
fi

echo
echo "=== redirection demandee par oauth2-proxy (sans session) ==="
docker run --rm --network governance_internal node:20-alpine node -e "
fetch('http://governance-oauth2proxy-1:4180/', { redirect: 'manual' })
  .then((r) => { console.log('statut:', r.status); console.log('location:', r.headers.get('location')); })
  .catch((e) => console.log('ECHEC:', e.message))
" 2>&1 | tail -4

echo
echo "=== etat final ==="
docker compose ps
