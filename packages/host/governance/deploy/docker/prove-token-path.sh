#!/usr/bin/env bash
# Prove the three access paths of the public endpoint:
#   browser, no credential   -> SSO redirect
#   machine, valid token     -> authority answer
#   machine, bad token       -> authority refusal, not a redirect
set -uo pipefail
cd /opt/governance || exit 1

docker compose up -d --force-recreate authority 2>&1 | tail -2
sleep 8
docker compose ps --format '{{.Name}} {{.Status}}'

HOST=governance.duke-analytics.com
RESOLVE=(--resolve "$HOST:443:127.0.0.1")

echo
echo "=== navigateur sans identifiants ==="
curl -sk -o /dev/null -w 'statut: %{http_code} -> %{redirect_url}\n' "${RESOLVE[@]}" "https://$HOST/" | cut -c1-150

echo
echo "=== machine avec jeton valide ==="
TOKEN=$(python3 -c "import json;print(next(iter(json.load(open('/etc/dsh/tokens.json')))))")
curl -sk "${RESOLVE[@]}" -H "Authorization: Bearer $TOKEN" "https://$HOST/" -w '\nstatut: %{http_code}\n' | tail -3

echo
echo "=== machine avec jeton invalide ==="
curl -sk "${RESOLVE[@]}" -H "Authorization: Bearer faux" "https://$HOST/" -w '\nstatut: %{http_code}\n' | tail -2

echo
echo "=== ecriture avec jeton valide ==="
curl -sk "${RESOLVE[@]}" -X POST "https://$HOST/governance/grant" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"subject":"contact@datanalysis.re","role":"viewer"}' -w '\nstatut: %{http_code}\n' | tail -2
