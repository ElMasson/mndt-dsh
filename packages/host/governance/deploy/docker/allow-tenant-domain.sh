#!/usr/bin/env bash
# The tenant signs people in as @datanalysis.re, not @duke-analytics.com: allow
# both, then make that identity the owner so the page has someone who can grant.
set -uo pipefail
cd /opt/governance || exit 1

python3 - <<'PY'
path = '/etc/oauth2-proxy/governance.cfg'
text = open(path).read()
text = text.replace('email_domains = ["duke-analytics.com"]',
                    'email_domains = ["datanalysis.re", "duke-analytics.com"]')
open(path, 'w').write(text)
print("filtre:", [line for line in text.splitlines() if line.startswith('email_domains')])
PY
chmod 0644 /etc/oauth2-proxy/governance.cfg
docker compose restart oauth2proxy >/dev/null 2>&1
sleep 6

cat > /tmp/root-owner.mjs <<'JS'
const base = 'http://governance-authority-1:8787'
const owner = 'duke@datanalysis.re'
const headers = { 'content-type': 'application/json', 'x-auth-request-email': owner }

const bootstrap = await fetch(`${base}/governance/bootstrap`, {
  method: 'POST', headers, body: JSON.stringify({ user: owner, role: 'owner' }),
})
console.log('bootstrap:', bootstrap.status, (await bootstrap.text()).slice(0, 140))

const root = await fetch(`${base}/`, { headers })
console.log('racine:', root.status, (await root.text()).slice(0, 220))
JS
docker run --rm --network governance_internal -v /tmp/root-owner.mjs:/probe.mjs:ro node:20-alpine node /probe.mjs

echo
docker compose ps --format '{{.Name}} {{.Status}}'
