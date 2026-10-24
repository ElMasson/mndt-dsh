#!/usr/bin/env bash
# Provision the authority tokens and prove the deployment behaves.
# Run on the server as root. Tokens are generated here and never printed.
set -euo pipefail

OWNER=$(openssl rand -hex 32)
READER=$(openssl rand -hex 32)

umask 077
cat > /etc/dsh/tokens.json <<JSON
{
  "${OWNER}": { "user": "stephane" },
  "${READER}": { "user": "sara" }
}
JSON
chown root:dsh /etc/dsh/tokens.json
chmod 0640 /etc/dsh/tokens.json

systemctl restart dsh-governance-authority
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1; then break; fi
  [ "$attempt" -eq 30 ] && { journalctl -u dsh-governance-authority -n 20 --no-pager >&2; exit 1; }
  sleep 1
done

echo "=== health ==="
curl -s http://127.0.0.1:8787/health; echo
echo "=== anonyme (attendu 401) ==="
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/governance/snapshot
echo "=== bootstrap owner ==="
curl -s -X POST http://127.0.0.1:8787/governance/bootstrap \
  -H "authorization: Bearer ${OWNER}" -H 'content-type: application/json' \
  -d '{"user":"stephane","role":"owner"}'; echo
echo "=== grant sara viewer ==="
curl -s -X POST http://127.0.0.1:8787/governance/grant \
  -H "authorization: Bearer ${OWNER}" -H 'content-type: application/json' \
  -d '{"actor":"stephane","subject":"sara","role":"viewer"}'; echo
echo "=== escalation par sara (attendu 403) ==="
curl -s -X POST http://127.0.0.1:8787/governance/grant \
  -H "authorization: Bearer ${READER}" -H 'content-type: application/json' \
  -d '{"actor":"sara","subject":"sara","role":"admin"}'; echo
echo "=== snapshot ==="
curl -s http://127.0.0.1:8787/governance/snapshot -H "authorization: Bearer ${OWNER}"; echo
echo "=== redemarrage, puis persistance ==="
systemctl restart dsh-governance-authority
sleep 2
curl -s http://127.0.0.1:8787/governance/snapshot -H "authorization: Bearer ${OWNER}"; echo
echo "=== service ==="
systemctl is-active dsh-governance-authority
systemctl is-enabled dsh-governance-authority
echo "=== audit ==="
wc -l < /var/lib/dsh/governance/audit.jsonl
tail -n 2 /var/lib/dsh/governance/audit.jsonl
echo "=== jetons (empreintes seules) ==="
node -e 'const t=require("/etc/dsh/tokens.json");for(const k of Object.keys(t))console.log(t[k].user, k.slice(0,8)+"...")'
