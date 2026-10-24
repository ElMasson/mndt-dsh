#!/usr/bin/env bash
# Install the Entra client secret and validate it against the token endpoint
# without printing it. A wrong secret answers invalid_client / AADSTS7000215; a
# right one rejects the dummy code instead, which is what proves the secret.
set -uo pipefail

[ -f /tmp/entra-client-secret ] || { echo "secret absent" >&2; exit 1; }

install -m 0400 -o 65532 -g 65532 /tmp/entra-client-secret /etc/oauth2-proxy/client_secret
echo "secret installe ($(wc -c < /etc/oauth2-proxy/client_secret) octets, mode $(stat -c '%a' /etc/oauth2-proxy/client_secret), proprietaire $(stat -c '%u' /etc/oauth2-proxy/client_secret))"
shred -u /tmp/entra-client-secret 2>/dev/null || rm -f /tmp/entra-client-secret

cd /opt/governance || exit 1
docker compose restart oauth2proxy >/dev/null 2>&1
sleep 8
echo "=== conteneurs ==="
docker compose ps --format '{{.Name}} {{.Status}}'

echo
echo "=== validation du secret aupres d'Entra (code bidon) ==="
TENANT=5ed9c3e0-522a-46fa-978a-dd6bc245d710
CLIENT=122bdf54-4ab8-4ef1-995e-a08501d04782
SECRET=$(cat /etc/oauth2-proxy/client_secret)
RESP=$(curl -s -X POST "https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token" \
  --data-urlencode "client_id=${CLIENT}" \
  --data-urlencode "client_secret=${SECRET}" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=code-bidon" \
  --data-urlencode "redirect_uri=https://governance.duke-analytics.com/oauth2/callback")
CODE=$(printf '%s' "$RESP" | grep -o 'AADSTS[0-9]*' | head -1)
if [ -z "$CODE" ]; then
  echo "reponse sans code AADSTS (inattendu): $(printf '%s' "$RESP" | head -c 200)"
elif [ "$CODE" = "AADSTS7000215" ]; then
  echo "SECRET INVALIDE ($CODE)"
else
  echo "secret accepte par Entra : le refus porte sur le code, pas sur le client ($CODE)"
fi

echo
echo "=== redirection sans session ==="
curl -sk -o /dev/null -w 'statut: %{http_code}\n' --resolve governance.duke-analytics.com:443:127.0.0.1 https://governance.duke-analytics.com/
