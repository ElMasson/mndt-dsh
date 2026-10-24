#!/usr/bin/env bash
# Add one teammate: mint their token, record their role, restart, and print the
# token once. Run on the authority host, as root.
#
#   ./add-member.sh <email> <viewer|operator|admin|owner>
#
# The token is printed once and stored 0640 root:dsh; the authority maps it to the
# email, so every action it takes is attributed to that person in the audit.
set -euo pipefail

EMAIL=${1:?usage: add-member.sh <email> <role>}
ROLE=${2:?usage: add-member.sh <email> <role>}
case "$ROLE" in
  viewer|operator|admin|owner) ;;
  *) echo "role inconnu: $ROLE" >&2; exit 1 ;;
esac

TOKENS=/etc/dsh/tokens.json
[ -f "$TOKENS" ] || { echo "jetons absents: $TOKENS" >&2; exit 1; }

EXISTING=$(python3 - "$EMAIL" <<'PY'
import json, sys
email = sys.argv[1]
data = json.load(open('/etc/dsh/tokens.json'))
for token, entry in data.items():
    if entry.get('user') == email:
        print(token)
        break
PY
)

CREATED=0
if [ -n "$EXISTING" ]; then
  TOKEN=$EXISTING
  # Reusing a token must not print it again: the secret stays in its file, and a
  # log or a chat transcript is exactly where it must never end up twice.
  echo "jeton existant reutilise pour $EMAIL (non reaffiche)"
else
  CREATED=1
  TOKEN=$(python3 -c "import secrets;print(secrets.token_urlsafe(48))")
  python3 - "$TOKEN" "$EMAIL" <<'PY'
import json, sys
token, email = sys.argv[1], sys.argv[2]
path = '/etc/dsh/tokens.json'
data = json.load(open(path))
data[token] = {'user': email}
json.dump(data, open(path, 'w'), indent=2)
PY
  chown root:dsh "$TOKENS"
  chmod 0640 "$TOKENS"
  echo "jeton cree pour $EMAIL"
fi

cd /opt/governance
docker compose restart authority >/dev/null
sleep 5

OWNER_TOKEN=$(python3 - <<'PY'
import json
data = json.load(open('/etc/dsh/tokens.json'))
for token, entry in data.items():
    if entry.get('user') == 'duke@datanalysis.re':
        print(token)
        break
PY
)
if [ -z "${OWNER_TOKEN:-}" ]; then
  echo "aucun jeton proprietaire pour enregistrer le role" >&2
  exit 1
fi

curl -sk --resolve governance.duke-analytics.com:443:127.0.0.1 \
  -X POST https://governance.duke-analytics.com/governance/grant \
  -H "Authorization: Bearer $OWNER_TOKEN" -H 'content-type: application/json' \
  -d "{\"subject\":\"$EMAIL\",\"role\":\"$ROLE\"}" -w '\nstatut: %{http_code}\n'

if [ "$CREATED" = "1" ]; then
  cat <<EOF

Teammate ready. Give them these two variables for their workstation:

  DSH_GOVERNANCE_AUTHORITY=https://governance.duke-analytics.com
  DSH_GOVERNANCE_TOKEN=$TOKEN

The token is shown once. Their write actions are attributed to $EMAIL in
/var/lib/dsh/governance/audit.jsonl.
EOF
else
  echo
  echo "Role recorded. Their existing token was not printed: read it on the authority"
  echo "host from $TOKENS (0640, root:dsh) and hand it over out of band."
fi
