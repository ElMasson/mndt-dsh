#!/usr/bin/env bash
# Explain a 403 that follows a successful sign-in.
set -uo pipefail
cd /opt/governance || exit 1

echo "=== journal: 403 et emails ==="
docker compose logs --since 30m oauth2proxy 2>&1 | grep -iE '403|email|forbidden|unauthor|denied|claim' | tail -12

echo
echo "=== derniere requete authentifiee ==="
docker compose logs --since 30m oauth2proxy 2>&1 | grep -E 'GET - "/"|GET - "/oauth2/callback"|GET - "/oauth2/auth"' | tail -5

echo
echo "=== configuration effective (sans secrets) ==="
grep -vE '^#' /etc/oauth2-proxy/governance.cfg | grep -vE '^\s*$'
