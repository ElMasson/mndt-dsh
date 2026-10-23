#!/usr/bin/env bash
# Give the authority container the identity that owns its state, then reconcile
# the identities with the emails the SSO front proves.
set -uo pipefail

UID_D=$(id -u dsh)
GID_D=$(id -g dsh)
echo "compte dsh: ${UID_D}:${GID_D}"

chown -R "${UID_D}:${GID_D}" /var/lib/dsh/governance
chmod 0750 /var/lib/dsh/governance

printf 'GOV_UID=%s\nGOV_GID=%s\n' "$UID_D" "$GID_D" > /opt/governance/.env
chmod 0644 /opt/governance/.env

python3 - <<'PY'
import re
path = '/opt/governance/docker-compose.yml'
text = open(path).read()
if 'user: "${GOV_UID' not in text:
    text = text.replace('    command: ["node", "/app/governance-authority.mjs"]',
        '    # The container drops CAP_DAC_OVERRIDE, so it must run as the account that\n'
        '    # owns the state directory rather than as root.\n'
        '    user: "${GOV_UID:-0}:${GOV_GID:-0}"\n'
        '    command: ["node", "/app/governance-authority.mjs"]', 1)
    open(path, 'w').write(text)
    print("compose: user ajoute")
PY

cd /opt/governance || exit 1
docker compose up -d --force-recreate authority 2>&1 | tail -2
sleep 8
docker compose ps --format '{{.Name}} {{.Status}}'
echo "--- autorite, ecriture de l audit ---"
docker compose logs --tail 6 authority 2>&1 | tail -6
