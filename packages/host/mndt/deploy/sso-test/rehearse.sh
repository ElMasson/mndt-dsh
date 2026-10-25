#!/usr/bin/env bash
# Rehearse the whole sign-in chain without Entra.
#
# Starts a stand-in OpenID provider and a second oauth2-proxy in front of the
# production gateway, drives one sign-in over HTTP on the loopback, asserts the
# product answers with the expected identity, then removes everything it created.
#
# Run on the server, as root, next to /opt/mndt-front.
set -uo pipefail

DIR=/opt/mndt-ssotest
CFG=/etc/mndt-ssotest
MARKER=sso-rehearsal
PROJECT=mndt-ssotest
HOST=mndt.duke-analytics.com
PORT=8443
EXPECTED=duke@datanalysis.re
failures=0

cleanup() {
  # Never let a failing teardown keep the stack or the name resolution behind:
  # the rehearsal must leave no trace, including after a failed run.
  set +e
  sed -i "/${MARKER}/d" /etc/hosts 2>/dev/null
  (cd "$DIR" 2>/dev/null && docker compose down -v >/dev/null 2>&1)
  docker ps -a --filter "name=${PROJECT}" -q | xargs -r docker rm -f >/dev/null 2>&1
  docker network rm "${PROJECT}_sso" >/dev/null 2>&1
  rm -rf "$DIR" "$CFG"
  set -e
}
trap cleanup EXIT

check() {
  local label=$1 expected=$2 actual=$3
  if printf '%s' "$actual" | grep -q -- "$expected"; then
    printf 'PASS  %s\n' "$label"
  else
    printf 'FAIL  %s (attendu %s, vu %s)\n' "$label" "$expected" "$actual"
    failures=$((failures + 1))
  fi
}

[ -d /opt/mndt-front ] || { echo "lance ce script a cote de /opt/mndt-front" >&2; exit 2; }
mkdir -p "$DIR" "$CFG"
chmod 755 "$CFG"
cp "$(dirname "$0")/sso-stub.mjs" "$DIR/sso-stub.mjs"
cp "$(dirname "$0")/docker-compose.yml" "$DIR/docker-compose.yml"

printf 'test-secret' > "$CFG/client_secret"
openssl rand 32 > "$CFG/cookie_secret"
cat > "$CFG/oauth2.cfg" <<CFGEOF
provider = "oidc"
oidc_issuer_url = "http://stub:9000"
insecure_oidc_skip_issuer_verification = true
client_id = "test-client"
redirect_url = "http://${HOST}:${PORT}/oauth2/callback"
cookie_name = "_mndt_test"
cookie_secure = false
cookie_samesite = "lax"
email_domains = ["*"]
upstreams = ["http://gateway:8080/"]
reverse_proxy = true
pass_user_headers = true
skip_provider_button = true
http_address = "0.0.0.0:${PORT}"
CFGEOF
chmod 644 "$CFG/oauth2.cfg"
chmod 600 "$CFG/client_secret" "$CFG/cookie_secret"
chown 65532:65532 "$CFG/client_secret" "$CFG/cookie_secret"

python3 - "$DIR/docker-compose.yml" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
if '127.0.0.1:9000:9000' not in text:
    text = text.replace('    networks:\n      - sso\n\n  proxy:', '    ports:\n      - "127.0.0.1:9000:9000"\n    networks:\n      - sso\n\n  proxy:')
    open(path, 'w').write(text)
PY

grep -q "$MARKER" /etc/hosts || printf '127.0.0.1 stub %s # %s\n' "$HOST" "$MARKER" >> /etc/hosts
(cd "$DIR" && docker compose up -d >/dev/null) || { echo "la recette n a pas demarre" >&2; exit 1; }
sleep 12

jar=$(mktemp)
body=$(mktemp)
code=$(curl -s -L -c "$jar" -b "$jar" -o "$body" -w '%{http_code}' -m 40 "http://${HOST}:${PORT}/mndt-api/state")
check "parcours de connexion aboutit" '^200$' "$code"
identity=$(python3 -c "import json,sys;print((json.load(open('$body')).get('page') or {}).get('you',''))" 2>/dev/null)
check "identite transmise par le proxy" "$EXPECTED" "$identity"
rights=$(python3 -c "import json;print((json.load(open('$body')).get('page') or {}).get('canWrite'))" 2>/dev/null)
check "droits lus a l autorite" 'True' "$rights"
rm -f "$jar" "$body"

printf '\n%d echec(s)\n' "$failures"
exit $((failures == 0 ? 0 : 1))
