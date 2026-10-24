#!/usr/bin/env bash
# Replayable smoke test of the deployed mndt stack.
#
# Every check asserts an observable fact and names what it proves. A failure
# exits non-zero: this script is meant to be run before claiming anything works.
set -uo pipefail

LIVE=${MNDT_HOME:-/data/mndt/live}
API=http://127.0.0.1:8795
PAGE=http://127.0.0.1:3111
HOST=mndt.duke-analytics.com
failures=0

check() {
  local label=$1 expected=$2 actual=$3
  if printf '%s' "$actual" | grep -q -- "$expected"; then
    printf 'PASS  %s\n' "$label"
  else
    printf 'FAIL  %s (attendu %s, vu %s)\n' "$label" "$expected" "$actual"
    failures=$((failures + 1))
  fi
}

health=$(curl -s -m 6 "$API/health")
check "API health" '"ok":true' "$health"

owner=$(curl -s -m 8 -H 'x-forwarded-email: duke@datanalysis.re' "$API/state")
viewer=$(curl -s -m 8 -H 'x-forwarded-email: contact@datanalysis.re' "$API/state")
check "proprietaire peut ecrire" '"canWrite":true' "$owner"
check "proprietaire identifie" '"you":"duke@datanalysis.re"' "$owner"
check "lecteur ne peut pas ecrire" '"canWrite":false' "$viewer"

connectors=$(curl -s -m 8 -H 'x-forwarded-email: duke@datanalysis.re' "$API/connectors")
check "connecteur monte" '"server":"workbench_facts"' "$connectors"
check "connecteur Attio monte" '"server":"attio"' "$connectors"

if [ -f "$LIVE/web-token" ]; then
  token=$(cat "$LIVE/web-token")
  page=$(curl -s -c /tmp/smoke-jar -b /tmp/smoke-jar -L -o /dev/null -w '%{http_code}' -m 20 "$PAGE/?token=$token")
  check "page servie avec jeton" '^200$' "$page"
else
  printf 'FAIL  jeton du shell absent de %s\n' "$LIVE/web-token"
  failures=$((failures + 1))
fi

unauth=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$PAGE/")
check "page refuse sans jeton" '^401$' "$unauth"

sso=$(curl -s -o /dev/null -w '%{redirect_url}' -k -m 10 -H "Host: $HOST" https://127.0.0.1/)
check "front SSO renvoie vers Entra" 'login.microsoftonline.com' "$sso"
check "URI de retour attendue" "redirect_uri=https%3A%2F%2F$HOST%2Foauth2%2Fcallback" "$sso"

public_code=$(curl -s -o /dev/null -w '%{http_code}' -m 12 https://mndt.duke-analytics.com/)
check "HTTPS public repond" '^302$' "$public_code"

public_redirect=$(curl -s -o /dev/null -w '%{redirect_url}' -m 12 https://mndt.duke-analytics.com/)
check "HTTPS public renvoie vers Entra" 'login.microsoftonline.com' "$public_redirect"

certificate=$(echo | openssl s_client -connect 127.0.0.1:443 -servername mndt.duke-analytics.com 2>/dev/null \
  | openssl x509 -noout -subject 2>/dev/null)
check "certificat public emis pour cet hote" 'CN *= *mndt.duke-analytics.com' "$certificate"

certificate_issuer=$(echo | openssl s_client -connect 127.0.0.1:443 -servername mndt.duke-analytics.com 2>/dev/null \
  | openssl x509 -noout -issuer 2>/dev/null)
check "certificat public non auto-signe" "Let's Encrypt" "$certificate_issuer"
planified=$(python3 - <<PY
import json
data = json.load(open('$LIVE/state.json'))
rows = [m for m in data.get('missions', []) if m.get('createdBy') == 'scheduler']
print(len(rows))
PY
)
check "automatisation planifiee a tourne" '^[1-9]' "$planified"

printf '\n%d echec(s)\n' "$failures"
exit $((failures == 0 ? 0 : 1))
