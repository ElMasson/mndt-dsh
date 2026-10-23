#!/usr/bin/env bash
# One identity per person: the SSO front proves an email, so grants, tokens and
# state all use that email. Resets the test grant table (it holds no real data).
set -uo pipefail
cd /opt/governance || exit 1

echo "=== arret de l autorite et remise a zero de l etat de test ==="
docker compose stop authority >/dev/null 2>&1
rm -f /var/lib/dsh/governance/rbac.json /var/lib/dsh/governance/audit.jsonl
docker compose start authority >/dev/null 2>&1
sleep 6

echo "=== jetons: les utilisateurs deviennent des emails ==="
python3 - <<'PY'
import json
path = '/etc/dsh/tokens.json'
data = json.load(open(path))
renames = {'stephane': 'stephane@duke-analytics.com', 'sara': 'sara@duke-analytics.com', 'lecteur': 'sara@duke-analytics.com'}
for token, entry in data.items():
    entry['user'] = renames.get(entry['user'], entry['user'])
json.dump(data, open(path, 'w'), indent=2)
print("jetons:", [entry['user'] for entry in data.values()])
PY
chown root:dsh /etc/dsh/tokens.json
chmod 0640 /etc/dsh/tokens.json
docker compose restart authority >/dev/null 2>&1
sleep 6

echo "=== bootstrap et grant avec les identites email ==="
docker run --rm --network governance_internal -v /tmp/reconcile.mjs:/reconcile.mjs:ro node:20-alpine node /reconcile.mjs
