#!/usr/bin/env bash
# Install or refresh the single sign-on front for the mndt workbench.
#
# Run as root on the server after the front files were copied to
# /opt/mndt-front. The Entra client secret is reused from the governance front;
# the cookie secret is specific to this front. The redirect URI
# https://mndt.duke-analytics.com/oauth2/callback must already be registered on
# the application, otherwise Entra refuses the sign-in.
set -euo pipefail

FRONT=/opt/mndt-front
CONF=/etc/mndt-front
GOVERNANCE_CONF=/etc/oauth2-proxy/governance.cfg
GOVERNANCE_SECRET=/etc/oauth2-proxy/client_secret

[ -f "$FRONT/docker-compose.yml" ] || { echo "missing $FRONT/docker-compose.yml" >&2; exit 1; }
[ -f "$FRONT/gateway/server.mjs" ] || { echo "missing gateway server" >&2; exit 1; }
[ -f "$GOVERNANCE_CONF" ] || { echo "missing $GOVERNANCE_CONF" >&2; exit 1; }
[ -f "$GOVERNANCE_SECRET" ] || { echo "missing $GOVERNANCE_SECRET" >&2; exit 1; }

mkdir -p "$CONF"
chmod 700 "$CONF"

if [ ! -f "$CONF/client_secret" ]; then
  cp "$GOVERNANCE_SECRET" "$CONF/client_secret"
fi
if [ ! -f "$CONF/cookie_secret" ]; then
  openssl rand -base64 32 | tr -d '\n' > "$CONF/cookie_secret"
fi

client_id=$(grep -E '^client_id' "$GOVERNANCE_CONF" | head -1 | cut -d'"' -f2)
[ -n "$client_id" ] || { echo "no client_id in $GOVERNANCE_CONF" >&2; exit 1; }
sed "s|__CLIENT_ID__|$client_id|" "$FRONT/oauth2.cfg.template" > "$CONF/oauth2.cfg"

chmod 600 "$CONF/client_secret" "$CONF/cookie_secret"
chmod 644 "$CONF/oauth2.cfg"

cd "$FRONT"
docker compose up -d
docker compose ps
