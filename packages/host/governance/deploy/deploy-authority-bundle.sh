#!/usr/bin/env bash
# Install the governance authority from the standalone bundle.
#
# Needed on the server: node 20+, nginx, systemd, and this directory (extracted
# from dsh-governance-bundle.tar.gz). No git, no pnpm, no build.
#
# Usage: sudo ./deploy-authority-bundle.sh
# Idempotent: re-running replaces the bundle and the unit, keeps state and tokens.

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SERVICE=dsh-governance-authority
UNIT=/etc/systemd/system/${SERVICE}.service
CONF_DIR=/etc/oauth2-proxy
STATE_DIR=/var/lib/dsh/governance
TOKENS=/etc/dsh/tokens.json
SITE=/etc/nginx/conf.d/governance.conf
HEALTH=http://127.0.0.1:8787/health

say() { printf '\n==> %s\n' "$1"; }
fail() { printf 'ECHEC: %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "ce script doit tourner en root"
[ -f "$HERE/governance-authority.mjs" ] || fail "bundle absent: governance-authority.mjs"
[ -x /usr/bin/node ] || fail "/usr/bin/node est absent (node 20+ requis)"

say "1/6 installation du bundle"
id -u dsh >/dev/null 2>&1 || useradd --system --home /opt/dsh-governance --shell /usr/sbin/nologin dsh
install -d -o root -g root -m 0755 /opt/dsh-governance
install -m 0644 "$HERE/governance-authority.mjs" /opt/dsh-governance/governance-authority.mjs
install -m 0644 "$HERE/README-DEPLOY.md" /opt/dsh-governance/README-DEPLOY.md

say "2/6 etat et jetons"
install -d -o dsh -g dsh -m 0750 "$STATE_DIR"
install -d -m 0755 /etc/dsh
if [ -f "$TOKENS" ]; then
  echo "jetons conserves: $TOKENS"
else
  umask 077
  { printf '{\n  "REMPLACER-PAR-UN-JETON-OWNER": { "user": "stephane" },\n'
    printf '  "REMPLACER-PAR-UN-JETON-LECTEUR": { "user": "lecteur" }\n}\n'; } > "$TOKENS"
  echo "jetons crees: remplacez-les avant le premier demarrage"
fi
chown root:dsh "$TOKENS"
chmod 0640 "$TOKENS"

say "3/6 secrets oauth2-proxy"
install -d -m 0700 "$CONF_DIR"
[ -f "$CONF_DIR/cookie_secret" ] || openssl rand -base64 32 > "$CONF_DIR/cookie_secret"
[ -f "$CONF_DIR/client_secret" ] || { echo "ECHEC: placez le secret Entra dans $CONF_DIR/client_secret" >&2; exit 1; }
chmod 0600 "$CONF_DIR/cookie_secret" "$CONF_DIR/client_secret"

say "4/6 unite systemd"
install -m 0644 "$HERE/dsh-governance-authority-bundle.service" "$UNIT"
systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"

say "5/6 controle de sante"
for attempt in $(seq 1 30); do
  if curl -fsS "$HEALTH" >/dev/null 2>&1; then echo "autorite en ligne"; break; fi
  [ "$attempt" -eq 30 ] && { journalctl -u "$SERVICE" -n 40 --no-pager >&2; fail "pas de reponse sur $HEALTH"; }
  sleep 1
done
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/governance/snapshot)
[ "$code" = "401" ] || fail "un appel anonyme devait etre refuse, reponse $code"
echo "appel anonyme refuse (401) : attendu"

say "6/6 proxy et SSO"
install -m 0644 "$HERE/oauth2-proxy.cfg" "$CONF_DIR/governance.cfg"
install -m 0644 "$HERE/nginx-governance.conf" "$SITE"
command -v nginx >/dev/null || fail "nginx absent"
nginx -t
systemctl reload nginx

echo
echo "Termine. Deux actions restent manuelles et volontairement hors script :"
echo "  1. remplacer les jetons de $TOKENS, puis systemctl restart $SERVICE"
echo "  2. amorcer le premier proprietaire :"
echo "     curl -sS -X POST http://127.0.0.1:8787/governance/bootstrap \\"
echo "       -H 'authorization: Bearer <jeton-owner>' -H 'content-type: application/json' \\"
echo "       -d '{\"user\":\"stephane\",\"role\":\"owner\"}'"
