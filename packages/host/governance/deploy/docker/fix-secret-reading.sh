#!/usr/bin/env bash
# Read the two secrets through the documented flags instead of the "@file"
# syntax, which is not resolved for client_secret in this version.
set -uo pipefail

CFG=/etc/oauth2-proxy/governance.cfg

sed -i -E 's|^client_secret = .*|# client_secret is passed with --client-secret-file (the @file form is not resolved here).|' "$CFG"
sed -i -E 's|^cookie_secret = .*|# cookie_secret is passed with --cookie-secret-file.|' "$CFG"
chmod 0644 "$CFG"

cd /opt/governance || exit 1
python3 - <<'PY'
import re
path = '/opt/governance/docker-compose.yml'
text = open(path).read()
command = ('command: ["--config=/etc/oauth2-proxy/governance.cfg", '
           '"--client-secret-file=/etc/oauth2-proxy/client_secret", '
           '"--cookie-secret-file=/etc/oauth2-proxy/cookie_secret", '
           '"--trusted-proxy-ip=172.18.0.0/16"]')
text = re.sub(r'command: \[[^\]]*\]', command, text, count=1)
open(path, 'w').write(text)
print("commande mise a jour")
PY

docker compose up -d oauth2proxy 2>&1 | tail -3
sleep 8
docker compose ps --format '{{.Name}} {{.Status}}'
echo "--- redirection ---"
curl -sk -o /dev/null -w 'statut: %{http_code}\n' --resolve governance.duke-analytics.com:443:127.0.0.1 https://governance.duke-analytics.com/
echo "--- erreurs recentes ---"
docker compose logs --since 2m oauth2proxy 2>&1 | grep -iE 'error|invalid' | tail -3
