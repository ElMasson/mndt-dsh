#!/usr/bin/env bash
# Fresh grant table with the real SSO identity as owner. The previous rows were
# test identities (stephane/sara without domain) produced during deployment.
set -uo pipefail
cd /opt/governance || exit 1

docker compose stop authority >/dev/null 2>&1
rm -f /var/lib/dsh/governance/rbac.json /var/lib/dsh/governance/audit.jsonl
docker compose start authority >/dev/null 2>&1
sleep 6

cat > /tmp/fresh-owner.mjs <<'JS'
const base = 'http://governance-authority-1:8787'
const owner = 'duke@datanalysis.re'
const headers = { 'content-type': 'application/json', 'x-auth-request-email': owner }

const bootstrap = await fetch(`${base}/governance/bootstrap`, {
  method: 'POST', headers, body: JSON.stringify({ user: owner, role: 'owner' }),
})
console.log('bootstrap:', bootstrap.status, (await bootstrap.text()).slice(0, 140))

const root = await fetch(`${base}/`, { headers })
console.log('racine:', root.status, (await root.text()).slice(0, 240))

const audit = await fetch(`${base}/governance/snapshot`, { headers })
console.log('snapshot:', audit.status, (await audit.text()).slice(0, 160))
JS
docker run --rm --network governance_internal -v /tmp/fresh-owner.mjs:/probe.mjs:ro node:20-alpine node /probe.mjs

echo
echo "=== audit ecrit par le conteneur ? ==="
wc -l < /var/lib/dsh/governance/audit.jsonl 2>/dev/null || echo "aucune ligne"
tail -1 /var/lib/dsh/governance/audit.jsonl 2>/dev/null
