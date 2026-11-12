#!/usr/bin/env bash
# Replayable smoke test of the deployed mndt stack.
#
# Every check asserts an observable fact and names what it proves. A failure
# exits non-zero: this script is meant to be run before claiming anything works.
set -uo pipefail

LIVE=${MNDT_HOME:-/data/mndt/live}
PAGE_HOST=${MNDT_PAGE_HOST:-127.0.0.1}
API=http://127.0.0.1:8795
PAGE=http://$PAGE_HOST:3111
HOST=${MNDT_PUBLIC_HOST:-mndt.duke-analytics.com}
# Connectors this tenant must have mounted, by MCP server name. The agentic
# Slack tenant sets: MNDT_SMOKE_CONNECTORS="approvals office365 qonto dolibarr swing".
EXPECTED_CONNECTORS=${MNDT_SMOKE_CONNECTORS:-workbench_facts attio approvals office365}
WORKBENCH_CONTAINER=${MNDT_WORKBENCH_CONTAINER:-mndt-front-workbench-1}
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

# A container that just restarted publishes its launch token and opens its API a
# few seconds later. Wait for that, so a green run means the stack is healthy and
# a red one means it is not.
for _ in $(seq 1 20); do
  if curl -s -m 3 "$API/health" | grep -q '"ok":true' && [ -s "$LIVE/web-token" ]; then
    break
  fi
  sleep 3
done
health=$(curl -s -m 6 "$API/health")
check "API health" '"ok":true' "$health"

owner=$(curl -s -m 8 -H 'x-forwarded-email: duke@datanalysis.re' "$API/state")
viewer=$(curl -s -m 8 -H 'x-forwarded-email: contact@datanalysis.re' "$API/state")
check "proprietaire peut ecrire" '"canWrite":true' "$owner"
check "proprietaire identifie" '"you":"duke@datanalysis.re"' "$owner"
check "lecteur ne peut pas ecrire" '"canWrite":false' "$viewer"

viewer_mission=$(curl -s -o /dev/null -w '%{http_code}' -m 8 -X POST \
  -H 'x-forwarded-email: contact@datanalysis.re' -H 'content-type: application/json' \
  -d '{"kind":"custom","prompt":"controle des droits"}' "$API/missions")
check "lecteur ne peut pas lancer de mission" '^403$' "$viewer_mission"

pending_id=$(curl -s -m 8 -H 'x-forwarded-email: duke@datanalysis.re' "$API/approvals?state=pending" \
  | python3 -c "import json,sys; rows=json.load(sys.stdin).get('approvals',[]); print(rows[0]['id'] if rows else '')")
if [ -n "$pending_id" ]; then
  viewer_decide=$(curl -s -o /dev/null -w '%{http_code}' -m 8 -X POST \
    -H 'x-forwarded-email: contact@datanalysis.re' -H 'content-type: application/json' \
    -d '{"decision":"approved"}' "$API/approvals/$pending_id/decide")
  check "lecteur ne peut pas decider" '^403$' "$viewer_decide"
fi
connectors=$(curl -s -m 8 -H 'x-forwarded-email: duke@datanalysis.re' "$API/connectors")
for server in $EXPECTED_CONNECTORS; do
  check "connecteur $server monte" "\"server\":\"$server\"" "$connectors"
done

# Read-only connectors: every descriptor that carries an allow list must be
# wrapped by the proxy, and the deployed proxy must refuse a write on its own.
for descriptor in "$LIVE"/connectors/*.json; do
  [ -f "$descriptor" ] || continue
  name=$(basename "$descriptor" .json)
  if grep -q '"allow"' "$descriptor"; then
    row=$(grep -A8 "id: mcp-$name\$" "$LIVE/home/profiles/web/cordis.patch.yml" 2>/dev/null | tr -d '\n')
    check "connecteur $name derriere le proxy" 'mcp-proxy.mjs' "$row"
  fi
done
if command -v docker >/dev/null 2>&1 && docker inspect "$WORKBENCH_CONTAINER" >/dev/null 2>&1; then
  stub='process.stdin.on("data",d=>{for(const l of String(d).split("\n").filter(Boolean)){const m=JSON.parse(l);process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:"stub reached"}]}})+"\n")}})'
  refused=$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"dolibarr_raw_api","arguments":{}}}' \
    | timeout 10 docker exec -i -e MCP_PROXY_ALLOW='get_*' -e MCP_PROXY_DENY=dolibarr_raw_api "$WORKBENCH_CONTAINER" \
      node /opt/mndt-tools/mcp-proxy.mjs node -e "$stub" 2>/dev/null | head -1)
  check "proxy deploye refuse une ecriture" 'outside the read-only allow list' "$refused"
fi

# LLM routes (agentic Slack): rendered in the home patch, keys by reference only.
if [ -n "${MNDT_SMOKE_LLM_ROUTES:-}" ]; then
  home_patch="$LIVE/home/cordis.patch.yml"
  routes=$(tr -d '\n' < "$home_patch" 2>/dev/null)
  check "route LLM scaleway-genapi declaree" 'scaleway-genapi:' "$routes"
  check "route LLM vllm-qwen declaree" 'vllm-qwen:' "$routes"
  check "cle Scaleway par reference" 'apiKeyEnv: SCW_GENAPI_KEY' "$routes"
  key_in_patch=$(grep -cE '(sk-|scw-|SCW_SECRET|SCW_GENAPI_KEY=)' "$home_patch" 2>/dev/null || true)
  check "aucune cle dans la composition" '^0$' "${key_in_patch:-0}"
  key_set=$(grep -cE '^SCW_GENAPI_KEY=.+' "$LIVE/model.env" 2>/dev/null || true)
  check "cle Scaleway fournie au workbench" '^1$' "${key_set:-0}"
fi

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

authority=$(grep -E '^DSH_MNDT_AUTHORITY=' "$LIVE/model.env" 2>/dev/null | cut -d= -f2-)
if [ -n "$authority" ]; then
  authority_token=$(grep -E '^DSH_MNDT_AUTHORITY_TOKEN=' "$LIVE/model.env" 2>/dev/null | cut -d= -f2-)
  snapshot=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -H "Authorization: Bearer $authority_token" "$authority/governance/snapshot")
  check "autorite centrale joignable" '^200$' "$snapshot"
fi
public_code=$(curl -s -o /dev/null -w '%{http_code}' -m 12 "https://$HOST/")
check "HTTPS public repond" '^302$' "$public_code"

public_redirect=$(curl -s -o /dev/null -w '%{redirect_url}' -m 12 "https://$HOST/")
check "HTTPS public renvoie vers Entra" 'login.microsoftonline.com' "$public_redirect"

certificate=$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$HOST" 2>/dev/null \
  | openssl x509 -noout -subject 2>/dev/null)
check "certificat public emis pour cet hote" "CN *= *$HOST" "$certificate"

certificate_issuer=$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$HOST" 2>/dev/null \
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
