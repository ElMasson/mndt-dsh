#!/usr/bin/env bash
# The sign-in list (authenticated_emails_file) against the real oauth2-proxy
# v7.15.5, the version of the tenant's compose, on this machine: a stand-in
# OpenID provider whose identity changes between sign-ins (EMAIL_FILE), an
# upstream that answers 200, everything on a private Docker network, removed at
# the end. Answers what reading the code cannot:
#   - an address in the list signs in, one outside it is refused;
#   - the list replaced by renaming (as render-authenticated-emails.py writes
#     it): is the new list applied without a restart, to a new sign-in and to a
#     cookie issued before?
#   - a list missing or unreadable at start, and made unreadable while running:
#     does the proxy stop, refuse everyone, or keep the last list?
#   emails-list.sh            (needs docker and curl; no root)
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
IMAGE=quay.io/oauth2-proxy/oauth2-proxy:v7.15.5
P=mndt-emailtest
PROXY_PORT=14180
STUB_PORT=19000
work=$(mktemp -d)
failures=0
cleanup() {
  docker rm -f $P-proxy $P-stub $P-upstream >/dev/null 2>&1
  docker network rm $P >/dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT
cleanup; work=$(mktemp -d)

check() { if [ "$2" = "$3" ]; then echo "OK  $1 ($3)"; else echo "KO  $1: expected $2, got $3"; failures=$((failures + 1)); fi; }
note() { echo "FACT $*"; }

mkdir -p "$work/conf" "$work/stub"
chmod 755 "$work" "$work/conf" "$work/stub"
cp "$here/sso-stub.mjs" "$work/stub/sso-stub.mjs"
printf 'test-secret' > "$work/conf/client_secret"
head -c 32 /dev/urandom > "$work/conf/cookie_secret"
printf 'alice@datanalysis.re\n' > "$work/conf/authenticated_emails"
chmod 644 "$work/conf/"*
cat > "$work/conf/oauth2.cfg" <<CFG
provider = "oidc"
oidc_issuer_url = "http://stub:$STUB_PORT"
insecure_oidc_skip_issuer_verification = true
client_id = "test-client"
redirect_url = "http://127.0.0.1:$PROXY_PORT/oauth2/callback"
authenticated_emails_file = "/etc/mndt-front/authenticated_emails"
cookie_secure = false
cookie_samesite = "lax"
cookie_expire = "8h"
cookie_name = "_mndt_emailtest"
http_address = "0.0.0.0:4180"
upstreams = ["http://upstream:8080/"]
reverse_proxy = true
skip_provider_button = true
CFG
chmod 644 "$work/conf/oauth2.cfg"

docker network create $P >/dev/null
docker run -d --name $P-upstream --network $P --network-alias upstream node:22-bookworm-slim \
  node -e 'require("http").createServer((q,r)=>{r.end("upstream "+(q.headers["x-forwarded-email"]||"-"))}).listen(8080)' >/dev/null
printf 'alice@datanalysis.re\n' > "$work/stub/email"; chmod 644 "$work/stub/email"
docker run -d --name $P-stub --network $P --network-alias stub -p 127.0.0.1:$STUB_PORT:$STUB_PORT \
  -e PORT=$STUB_PORT -e ISSUER=http://stub:$STUB_PORT -e CLIENT_ID=test-client -e EMAIL_FILE=/w/email \
  -v "$work/stub:/w:ro" node:22-bookworm-slim node /w/sso-stub.mjs >/dev/null
for _ in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:$STUB_PORT/health && break; sleep 1; done

start_proxy() {
  docker rm -f $P-proxy >/dev/null 2>&1
  docker run -d --name $P-proxy --network $P -p 127.0.0.1:$PROXY_PORT:4180 -v "$work/conf:/etc/mndt-front:ro" $IMAGE \
    --config=/etc/mndt-front/oauth2.cfg --client-secret-file=/etc/mndt-front/client_secret --cookie-secret-file=/etc/mndt-front/cookie_secret >/dev/null
  for _ in $(seq 1 20); do
    [ "$(docker inspect -f '{{.State.Running}}' $P-proxy 2>/dev/null)" = true ] || break
    curl -s -o /dev/null http://127.0.0.1:$PROXY_PORT/ping && return 0
    sleep 1
  done
  return 1
}
# One sign-in as <email>, cookies in <jar>: the provider approves at once.
# Prints the final HTTP status of the upstream page.
sign_in() {
  printf '%s\n' "$1" > "$work/stub/email"
  rm -f "$2"
  curl -s -o /dev/null -w '%{http_code}' -L -c "$2" -b "$2" --max-redirs 6 \
    --connect-to stub:$STUB_PORT:127.0.0.1:$STUB_PORT "http://127.0.0.1:$PROXY_PORT/oauth2/start?rd=%2F"
}
# The upstream page with an existing cookie, no new sign-in.
with_cookie() { curl -s -o /dev/null -w '%{http_code}' -b "$1" "http://127.0.0.1:$PROXY_PORT/"; }
running() { [ "$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' $P-proxy 2>/dev/null)" = "true 0" ] && echo yes || echo no; }

echo "== 1. the list admits its addresses and nobody else"
start_proxy || { echo "KO  the proxy does not start"; docker logs $P-proxy 2>&1 | tail -5; exit 1; }
check "alice, in the list, signs in" 200 "$(sign_in alice@datanalysis.re "$work/alice")"
check "bob, of the same domain but not in the list, is refused" 403 "$(sign_in bob@datanalysis.re "$work/bob")"

echo "== 2. the list replaced by renaming, the proxy running (no restart)"
printf 'bob@datanalysis.re\n' > "$work/conf/.authenticated_emails.new"; chmod 644 "$work/conf/.authenticated_emails.new"
mv -f "$work/conf/.authenticated_emails.new" "$work/conf/authenticated_emails"
sleep 5
check "the proxy is still running" yes "$(running)"
bob=$(sign_in bob@datanalysis.re "$work/bob2")
alice_new=$(sign_in alice@datanalysis.re "$work/alice2")
alice_old=$(with_cookie "$work/alice")
check "the renamed list admits bob without a restart" 200 "$bob"
check "the renamed list refuses a new sign-in of alice" 403 "$alice_new"
check "alice's cookie, issued before her removal, is rechecked" 403 "$alice_old"
docker logs $P-proxy 2>&1 | grep -i "authenticated\|reload\|watch" | tail -3 | sed 's/^/    log: /'

echo "== 3. the list made unreadable while the proxy runs"
printf 'alice@datanalysis.re\n' > "$work/conf/.authenticated_emails.new"; chmod 600 "$work/conf/.authenticated_emails.new"
mv -f "$work/conf/.authenticated_emails.new" "$work/conf/authenticated_emails"
sleep 5
check "an unreadable list while running: the proxy keeps running" yes "$(running)"
check "an unreadable list while running: the last good list stays (bob)" 200 "$(sign_in bob@datanalysis.re "$work/bob3")"
check "an unreadable list while running: the last good list stays (alice refused)" 403 "$(sign_in alice@datanalysis.re "$work/alice3")"
docker logs $P-proxy 2>&1 | tail -3 | sed 's/^/    log: /'

echo "== 4. the list unreadable, then missing, at start"
start_proxy; started=$?
check "an unreadable list at start: the proxy does not start" 1 "$started"
note "$(docker logs $P-proxy 2>&1 | tail -1)"
rm -f "$work/conf/authenticated_emails"
start_proxy; started=$?
check "a missing list at start: the proxy does not start" 1 "$started"

echo "== 5. the list as the product writes it: render-authenticated-emails.py as root"
# A test switch left in the environment must not apply to root: the list must
# still be 65532:65532 640, its header line harmless, and the proxy start on it.
printf '{ "grants": [ { "subject": "alice@datanalysis.re", "role": "owner" } ] }\n' > "$work/conf/grants.json"
chmod 644 "$work/conf/grants.json"; chmod 777 "$work/conf"
rendered=$(docker run --rm -e MNDT_EMAILS_UNPRIVILEGED=1 -v "$work/conf:/c" -v "$here/../tenant:/s:ro" node:22-bookworm \
  sh -c 'python3 /s/render-authenticated-emails.py /c/grants.json /c/authenticated_emails datanalysis.re --owner alice@datanalysis.re && stat -c "%u:%g %a" /c/authenticated_emails' 2>&1)
check "rendered as root, with the test switch set: owner and mode" "65532:65532 640" "$(echo "$rendered" | tail -1)"
start_proxy; started=$?
check "the proxy starts on the rendered list (header line included)" 0 "$started"
check "alice, from the rendered list, signs in" 200 "$(sign_in alice@datanalysis.re "$work/alice6")"
check "bob is refused by the rendered list" 403 "$(sign_in bob@datanalysis.re "$work/bob6")"

echo "emails-list exit $failures"
exit $failures
