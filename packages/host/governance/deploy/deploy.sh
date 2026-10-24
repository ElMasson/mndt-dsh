#!/usr/bin/env bash
# Install the DSH governance authority on a Linux host.
#
# Idempotent: re-running upgrades the unit and the configuration in place, keeps
# the state directory and the secrets, and never overwrites an existing token
# file. Every step either succeeds or stops the script with a message.
#
# Usage: sudo ./deploy.sh
# Prerequisites: the repository checked out at /opt/dsh with node_modules
# installed, and node on PATH at /usr/bin/node.

set -euo pipefail

REPO=${REPO:-/opt/dsh}
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
[ -d "$REPO/packages/host/governance" ] || fail "depot introuvable dans $REPO"
[ -x /usr/bin/node ] || fail "/usr/bin/node est absent"
[ -x /usr/bin/nginx ] || fail "nginx est absent"

say "1/7 compte et repertoires"
id -u dsh >/dev/null 2>&1 || useradd --system --home /opt/dsh --shell /usr/sbin/nologin dsh
install -d -o dsh -g dsh -m 0750 "$STATE_DIR"
install -d -m 0755 /etc/dsh
install -d -m 0700 "$CONF_DIR"

say "2/7 jetons d'autorite"
if [ -f "$TOKENS" ]; then
  echo "le fichier de jetons existe deja, conserve"
else
  # One owner token and one reader token; replace the users with real identities.
  umask 077
  cat > "$TOKENS" <<'JSON'
{
  "REMPLACER-PAR-UN-JETON-OWNER": { "user": "stephane" },
  "REMPLACER-PAR-UN-JETON-LECTEUR": { "user": "lecteur" }
}
JSON
  echo "jetons crees dans $TOKENS : remplacez-les avant le premier demarrage"
fi
chown root:dsh "$TOKENS"
chmod 0640 "$TOKENS"

say "3/7 secrets oauth2-proxy"
[ -f "$CONF_DIR/cookie_secret" ] || openssl rand -base64 32 > "$CONF_DIR/cookie_secret"
[ -f "$CONF_DIR/client_secret" ] || { echo "ECHEC: placez le secret Entra dans $CONF_DIR/client_secret" >&2; exit 1; }
chmod 0600 "$CONF_DIR/cookie_secret" "$CONF_DIR/client_secret"

say "4/7 unite systemd"
install -m 0644 "$REPO/packages/host/governance/deploy/${SERVICE}.service" "$UNIT"
systemctl daemon-reload
systemctl enable --now "$SERVICE"
sleep 2

say "5/7 controle de sante de l'autorite"
for attempt in $(seq 1 30); do
  if curl -fsS "$HEALTH" >/dev/null 2>&1; then
    echo "autorite en ligne sur 127.0.0.1:8787"
    break
  fi
  [ "$attempt" -eq 30 ] && { journalctl -u "$SERVICE" -n 30 --no-pager >&2; fail "l'autorite ne repond pas sur $HEALTH"; }
  sleep 1
done

say "6/7 proxy et SSO"
install -m 0644 "$REPO/packages/host/governance/deploy/oauth2-proxy.cfg" "$CONF_DIR/governance.cfg"
install -m 0644 "$REPO/packages/host/governance/deploy/nginx-governance.conf" "$SITE"
nginx -t
systemctl reload nginx

say "7/7 verification anonyme et authentifiee"
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/governance/snapshot)
[ "$code" = "401" ] || fail "l'autorite devait refuser un appel anonyme, elle a repondu $code"
echo "appel anonyme refuse (401) : attendu"
echo
echo "Termine. Deux actions restent manuelles, et volontairement hors script :"
echo "  1. remplacer les deux jetons de $TOKENS par de vrais secrets, puis systemctl restart $SERVICE"
echo "  2. amorcer le premier proprietaire : curl -sS -X POST http://127.0.0.1:8787/governance/bootstrap \\"
echo "       -H 'authorization: Bearer <jeton-owner>' -H 'content-type: application/json' \\"
echo "       -d '{\"user\":\"stephane\",\"role\":\"owner\"}'"
