#!/usr/bin/env bash
# Prove per-user rights through the public token path: the viewer reads but does
# not write, the owner writes.
set -uo pipefail

HOST=governance.duke-analytics.com
RESOLVE=(--resolve "$HOST:443:127.0.0.1")
readarray -t TOKENS < <(python3 -c "
import json
data = json.load(open('/etc/dsh/tokens.json'))
for token, entry in data.items():
    print(token + '|' + entry['user'])
")
OWNER_TOKEN=${TOKENS[0]%%|*}
OWNER_USER=${TOKENS[0]##*|}
VIEWER_TOKEN=${TOKENS[1]%%|*}
VIEWER_USER=${TOKENS[1]##*|}
echo "jeton 1 = $OWNER_USER, jeton 2 = $VIEWER_USER"

echo
echo "=== lecture avec le jeton du viewer ==="
curl -sk "${RESOLVE[@]}" -H "Authorization: Bearer $VIEWER_TOKEN" "https://$HOST/" -w '\nstatut: %{http_code}\n' | tail -3

echo
echo "=== ecriture avec le jeton du viewer (doit etre refusee) ==="
curl -sk "${RESOLVE[@]}" -X POST "https://$HOST/governance/grant" \
  -H "Authorization: Bearer $VIEWER_TOKEN" -H 'content-type: application/json' \
  -d '{"subject":"contact@datanalysis.re","role":"admin"}' -w '\nstatut: %{http_code}\n' | tail -2

echo
echo "=== etat de la table, vu par le proprietaire ==="
curl -sk "${RESOLVE[@]}" -H "Authorization: Bearer $OWNER_TOKEN" "https://$HOST/governance/snapshot" -w '\nstatut: %{http_code}\n' | tail -2

echo
echo "=== audit cote serveur ==="
tail -3 /var/lib/dsh/governance/audit.jsonl
