#!/usr/bin/env bash
# oauth2-proxy's pass_user_headers forwards X-Forwarded-Email upstream; the
# X-Auth-Request-* headers are for auth_request setups. Point the authority at
# the header the proxy actually sends.
set -uo pipefail
cd /opt/governance || exit 1

python3 - <<'PY'
path = '/opt/governance/docker-compose.yml'
text = open(path).read()
text = text.replace('DSH_GOVERNANCE_PROXY_USER_HEADER: x-auth-request-email',
                    'DSH_GOVERNANCE_PROXY_USER_HEADER: x-forwarded-email')
open(path, 'w').write(text)
print("env:", [line.strip() for line in text.splitlines() if 'PROXY_USER_HEADER' in line])
PY

docker compose up -d --force-recreate authority 2>&1 | tail -2
sleep 8

cat > /tmp/check-header.mjs <<'JS'
const base = 'http://governance-authority-1:8787'
for (const header of ['x-forwarded-email', 'x-auth-request-email']) {
  const response = await fetch(`${base}/`, { headers: { [header]: 'duke@datanalysis.re' } })
  console.log(`${header}:`, response.status, (await response.text()).slice(0, 90))
}
JS
docker run --rm --network governance_internal -v /tmp/check-header.mjs:/probe.mjs:ro node:20-alpine node /probe.mjs

echo
docker compose ps --format '{{.Name}} {{.Status}}'
