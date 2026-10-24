#!/usr/bin/env bash
# Restart the authority on the new bundle and prove the snapshot now names the
# reader, through the public token path.
set -uo pipefail
cd /opt/governance || exit 1

docker compose restart authority >/dev/null 2>&1
sleep 6
docker compose ps --format '{{.Name}} {{.Status}}'

TOKEN=$(python3 -c "import json;print(next(iter(json.load(open('/etc/dsh/tokens.json')))))")
echo
echo "=== snapshot avec jeton ==="
curl -sk --resolve governance.duke-analytics.com:443:127.0.0.1 \
  -H "Authorization: Bearer $TOKEN" \
  https://governance.duke-analytics.com/governance/snapshot -w '\nstatut: %{http_code}\n' | tail -3
