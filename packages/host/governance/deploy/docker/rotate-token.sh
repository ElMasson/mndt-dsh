#!/usr/bin/env bash
# Rotate one member's token in place, without ever printing it. Used after a
# token is exposed by accident (a shell history, a transcript, a screenshot).
set -euo pipefail

EMAIL=${1:?usage: rotate-token.sh <email>}
TOKENS=/etc/dsh/tokens.json

python3 - "$EMAIL" <<'PY'
import json, secrets, sys
email = sys.argv[1]
path = '/etc/dsh/tokens.json'
data = json.load(open(path))
old = [token for token, entry in data.items() if entry.get('user') == email]
if not old:
    raise SystemExit(f'no token for {email}')
for token in old:
    del data[token]
fresh = secrets.token_urlsafe(48)
data[fresh] = {'user': email}
json.dump(data, open(path, 'w'), indent=2)
print(f'rotated {len(old)} token(s) for {email}')
PY

chown root:dsh "$TOKENS"
chmod 0640 "$TOKENS"
cd /opt/governance && docker compose restart authority >/dev/null && sleep 5
docker compose ps --format '{{.Name}} {{.Status}}'
