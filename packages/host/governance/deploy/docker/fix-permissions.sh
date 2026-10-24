#!/usr/bin/env bash
# Make the configuration readable by the oauth2-proxy container user, then bring
# the stack up and verify the redirect to Microsoft.
set -uo pipefail

cd /opt/governance || exit 1

echo "=== utilisateur du conteneur oauth2-proxy ==="
docker image inspect quay.io/oauth2-proxy/oauth2-proxy:v7.15.5 --format 'User={{.Config.User}}'

USER_ID=$(docker image inspect quay.io/oauth2-proxy/oauth2-proxy:v7.15.5 --format '{{.Config.User}}')
USER_ID=${USER_ID:-65534}
USER_ID=${USER_ID%%:*}

echo "==> droits: proprietaire ${USER_ID}, dossier lisible"
chmod 0755 /etc/oauth2-proxy
chmod 0644 /etc/oauth2-proxy/governance.cfg
chown "${USER_ID}:${USER_ID}" /etc/oauth2-proxy/cookie_secret /etc/oauth2-proxy/client_secret
chmod 0400 /etc/oauth2-proxy/cookie_secret /etc/oauth2-proxy/client_secret
ls -l /etc/oauth2-proxy

echo
echo "=== redemarrage ==="
docker compose up -d --remove-orphans >/tmp/up.log 2>&1
echo "up exit=$?"
sleep 10
docker compose ps

echo
echo "=== autorite, de l interieur du reseau ==="
docker run --rm --network governance_internal node:20-alpine \
  node -e "fetch('http://authority:8787/health').then(r=>r.text()).then(t=>console.log('health:',t)).catch(e=>console.log('health ECHEC:',e.message))" 2>&1 | tail -2

echo
echo "=== journaux oauth2proxy ==="
docker compose logs --tail 6 oauth2proxy 2>&1 | tail -6

echo
echo "=== redirection sans session via Traefik ==="
curl -sk -o /dev/null -w 'statut: %{http_code}\nredirection: %{redirect_url}\n' \
  --resolve governance.duke-analytics.com:443:127.0.0.1 \
  https://governance.duke-analytics.com/ || true
