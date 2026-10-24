#!/usr/bin/env bash
# Install the governance Docker stack next to the Tellus stack.
# Expects, in the current directory: docker-compose.yml, oauth2-proxy.cfg and
# client-secret.txt (a single line, no newline needed).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)

[ "$(id -u)" -eq 0 ] || { echo "root requis" >&2; exit 1; }
for f in docker-compose.yml oauth2-proxy.cfg client-secret.txt; do
  [ -f "$HERE/$f" ] || { echo "fichier manquant: $f" >&2; exit 1; }
done

echo "==> repertoires"
install -d -m 0755 /opt/governance /opt/dsh-governance
install -d -m 0700 /etc/oauth2-proxy
install -d -o root -g root -m 0755 /var/lib/dsh/governance

echo "==> configuration"
install -m 0644 "$HERE/docker-compose.yml" /opt/governance/docker-compose.yml
install -m 0644 "$HERE/oauth2-proxy.cfg" /etc/oauth2-proxy/governance.cfg

echo "==> secrets"
if [ ! -f /etc/oauth2-proxy/cookie_secret ]; then
  openssl rand 32 > /etc/oauth2-proxy/cookie_secret
fi
cp "$HERE/client-secret.txt" /etc/oauth2-proxy/client_secret
chmod 0600 /etc/oauth2-proxy/cookie_secret /etc/oauth2-proxy/client_secret
echo "cookie_secret: genere ($(wc -c < /etc/oauth2-proxy/cookie_secret) octets)"
echo "client_secret: installe ($(wc -c < /etc/oauth2-proxy/client_secret) octets)"

echo "==> bundle de l autorite"
if [ -f /opt/dsh-governance/governance-authority.mjs ]; then
  echo "bundle deja present"
else
  echo "ECHEC: /opt/dsh-governance/governance-authority.mjs absent" >&2
  exit 1
fi

echo "==> un seul proprietaire du fichier d etat"
systemctl disable --now dsh-governance-authority 2>/dev/null || true

echo "==> demarrage du projet"
cd /opt/governance
docker compose up -d
sleep 8
docker compose ps
