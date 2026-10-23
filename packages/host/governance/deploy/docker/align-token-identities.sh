#!/usr/bin/env bash
# Align the bearer-token path with the SSO identity: one person, one identity.
# The owner token now points at the real account; the second token is the shared
# contact mailbox, with no grant until someone grants it.
set -uo pipefail
cd /opt/governance || exit 1

python3 - <<'PY'
import json
path = '/etc/dsh/tokens.json'
data = json.load(open(path))
users = sorted({entry['user'] for entry in data.values()})
owner = 'duke@datanalysis.re'
contact = 'contact@datanalysis.re'
first = True
for token, entry in data.items():
    entry['user'] = owner if first else contact
    first = False
json.dump(data, open(path, 'w'), indent=2)
print("jetons:", [entry['user'] for entry in data.values()])
PY
chown root:dsh /etc/dsh/tokens.json
chmod 0640 /etc/dsh/tokens.json

docker compose restart authority >/dev/null 2>&1
sleep 6

cat > /tmp/check-bearer.mjs <<'JS'
import { readFileSync } from 'node:fs'
const tokens = JSON.parse(readFileSync('/etc/dsh/tokens.json', 'utf8'))
const bearer = Object.keys(tokens)[0]
const base = 'http://governance-authority-1:8787'
const withToken = await fetch(`${base}/`, { headers: { authorization: `Bearer ${bearer}` } })
console.log('racine avec jeton:', withToken.status, (await withToken.text()).slice(0, 120))
const anonymous = await fetch(`${base}/`)
console.log('racine sans rien:', anonymous.status)
JS
docker run --rm --network governance_internal -v /etc/dsh/tokens.json:/etc/dsh/tokens.json:ro -v /tmp/check-bearer.mjs:/probe.mjs:ro node:20-alpine node /probe.mjs

echo
docker compose ps --format '{{.Name}} {{.Status}}'
