#!/usr/bin/env bash
# The assembled lot 1 rehearsal, in the instance's real order, on this machine:
#   1. create-tenant.sh, the LLM keys and routes, the role file;
#   2. the workbench's first start (DSH writes its default patch template);
#   3. the real seed-team.sh (approvals mounted, workbench restarted, agents
#      seeded), its two Compose calls passed through compose-shim.sh;
#   4. the restart survives, then drive.mjs: the real page in Chromium, the
#      shell's WebSocket, a real agent turn on a fake LLM, abrupt resets.
# Nothing leaves this machine: the LLM routes point at fake-llm.mjs, SSO is
# replaced by the identity header given to the gateway.
#
#   rehearse.sh <workbench image> [rehearsal root]
# The image is built beforehand from a clean export of the branch, as on the
# server: docker build -f packages/host/mndt/deploy/Dockerfile.workbench -t <image> .
# KEEP=1 leaves the containers running for inspection.
set -uo pipefail
image=${1:?usage: rehearse.sh <workbench image> [rehearsal root]}
here=$(cd "$(dirname "$0")" && pwd)
deploy=$(cd "$here/.." && pwd)
repo=$(cd "$deploy/../../../.." && pwd)
project=mndt-rehearsal
# The rehearsal root is written freely (model.env, grants.json, chmod -R): never
# an existing instance. Only a new or empty folder under the temporary directory.
tmp_base=$(cd "${TMPDIR:-/tmp}" && pwd -P)
if [ -n "${2:-}" ]; then
  # Resolved without creating anything: a refused root is never touched.
  root=$(realpath -m "${2}")
else
  root=$(mktemp -d "$tmp_base/mndt-rehearsal-XXXX")
fi
case $root in
  "$tmp_base"/?*) ;;
  *) echo "refused: the rehearsal root must be under $tmp_base, not $root" >&2; exit 2 ;;
esac
mkdir -p "$root" || exit 1
if [ -n "$(ls -A "$root")" ]; then echo "refused: the rehearsal root $root is not empty" >&2; exit 2; fi
touch "$root/.mndt-rehearsal"
# Whatever the exit, the containers and their network go, unless KEEP=1: the
# workbench restarts unless stopped and would loop on. The root stays, for the
# screenshots and the logs.
cleanup() {
  if [ "${KEEP:-0}" != 1 ]; then
    docker rm -f $project-gateway $project-workbench $project-fakellm $project-signer >/dev/null 2>&1
    docker network rm ${project}_front ${project}_ingress ${project}_outside >/dev/null 2>&1
  fi
  echo "rehearsal root: $root"
}
trap cleanup EXIT
owner=duke@datanalysis.re; viewer=smarion@datanalysis.re; admin=jadmin@datanalysis.re
app=$root/opt/mndt/datanalysis; data=$root/data/mndt/datanalysis/live
mkdir -p "$root/root" "$root/shots"
# The API answers before dsh web prints its launch URL (it waits for every plugin):
# the page is ready when the gateway opens the owner's shell session (under /dsh/).
page_ready() {
  for _ in $(seq 1 "${1:-150}"); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-forwarded-email: $owner" http://127.0.0.1:18080/dsh/)" = 302 ] && return 0
    sleep 3
  done
  return 1
}
# The tenant's real topology, without Entra: the signing proxy stands in for
# oauth2-proxy on the ingress network (an internal network cannot publish a
# port, so the proxy also joins an "outside" network that does); the gateway
# listens only there and publishes nothing.
signed_override() {
  cat > "$root/compose.override.yml" <<YML
networks:
  outside: {}
services:
  workbench:
    # Nothing leaves this machine: the managed endpoint answers nowhere.
    extra_hosts: ["api.scaleway.ai:127.0.0.1"]
  fakellm:
    image: node:22-bookworm-slim
    command: ["node", "/opt/fake/fake-llm.mjs"]
    volumes: ["$here:/opt/fake:ro"]
  signer:
    image: node:22-bookworm-slim
    command: ["node", "/opt/rehearsal/signing-proxy.mjs"]
    environment:
      PROXY_SIGNATURE_KEY_FILE: /run/secrets/mndt-proxy-signature
      UPSTREAM: http://gateway-ingress:8080
    volumes: ["$here:/opt/rehearsal:ro", "$root/etc/mndt/datanalysis/proxy_signature_key:/run/secrets/mndt-proxy-signature:ro"]
    ports: ["127.0.0.1:18080:8080"]
    networks: [ingress, outside]
YML
}
# The attack of the security report, from the workbench (where an agent's
# commands run): the owner's header to the gateway, to its proxy-side name, and
# to the API without the gateway's secret. Every one must fail.
attack() {
  local script
  script="const owner='$owner'
const tries=[['gateway:8080','http://gateway:8080/mndt-api/me'],['gateway-ingress:8080','http://gateway-ingress:8080/mndt-api/me'],['api without secret','http://127.0.0.1:8795/me']]
let breached=0
for (const [label,url] of tries) {
  try { const r = await fetch(url,{headers:{'x-forwarded-email':owner},signal:AbortSignal.timeout(5000)}); const b = await r.text()
    const ok = r.status === 200 && b.includes(owner); if (ok) breached=1; console.log((ok?'BREACHED ':'refused  ')+label+': '+r.status)
  } catch (e) { console.log('refused  '+label+': '+(e.cause?.code ?? e.name)) }
}
process.exit(breached)"
  docker exec -i $project-workbench node --input-type=module -e "$script"
}
# A document deposit of a few MiB goes through the proxy and the gateway to the
# API (the gateway reads up to 20 MiB for this route only): neither 413 nor 401.
deposit() {
  local body code
  body=$(mktemp "$root/deposit-XXXX")
  printf '{"name":"rehearsal.bin","contentBase64":"%s"}' "$(head -c 3145728 /dev/zero | base64 -w0)" > "$body"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-forwarded-email: $owner" -H 'content-type: application/json' \
    --data-binary @"$body" http://127.0.0.1:18080/mndt-api/channels/no-such-channel/files)
  echo "deposit of 4 MiB (3 MiB of content): HTTP $code (the API answers: 404 for a channel that does not exist)"
  [ "$code" != 413 ] && [ "$code" != 401 ] && [ "$code" != 000 ]
}
step() { printf '\n== %s\n' "$*"; }
health() {
  for _ in $(seq 1 "${1:-80}"); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/mndt-api/health)" = 200 ] && return 0
    sleep 3
  done
  return 1
}
workbench_log() { echo "--- last lines of the shell log (/run/mndt-launch/web.log)"; docker exec $project-workbench tail -15 /run/mndt-launch/web.log 2>/dev/null; }

step "1. tenant, keys, routes, roles (root $root)"
printf 'secret' > "$root/root/entra_client_secret"
MNDT_ROOT=$root bash "$deploy/create-tenant.sh" datanalysis equipe.datanalysis.re --owner $owner \
  --client-id 00000000-0000-0000-0000-000000000000 --client-secret-file /root/entra_client_secret --no-docker || exit 1
cat > "$data/model.env" <<ENV
SCW_GENAPI_KEY=rehearsal
VLLM_API_KEY=placeholder
SCW_PROJECT_ID=11111111-2222-3333-4444-555555555555
VLLM_QWEN_BASE_URL=http://fakellm:8000/v1
VLLM_QWEN_MODEL=fake-qwen
CANARY_SECRET_MODEL_ENV=CANARY_SECRET_model_env_value
ENV
MNDT_HOME=$data python3 "$deploy/llm/render-llm-routes.py" --env-file "$data/model.env" || exit 1
# An admin who is not the owner: missions and automations stay closed to them.
printf '{ "grants": [ { "subject": "%s", "role": "owner" }, { "subject": "%s", "role": "viewer" }, { "subject": "%s", "role": "admin" } ] }\n' $owner $viewer $admin > "$data/grants.json"
sed -e "s#/data/mndt/datanalysis/live#$data#g" -e "s#/opt/mndt/datanalysis#$app#g" -e "s#/etc/mndt/datanalysis#$root/etc/mndt/datanalysis#g" \
    -e "s#image: mndt-workbench:local#image: $image#" \
    -e "s#PUBLIC_URL: https://equipe.datanalysis.re/#PUBLIC_URL: http://127.0.0.1:18080/#" \
    -e "s#TRUSTED_HOST: equipe.datanalysis.re#TRUSTED_HOST: 127.0.0.1:18080#" \
    "$app/docker-compose.yml" > "$root/compose.yml"
signed_override
# Readable by the containers, but never under home/: the workbench refuses a
# credentials file readable beyond its owner (credentials-local, mode 600).
find "$root" -path "$data/home" -prune -o -exec chmod a+rX {} + 2>/dev/null

# A mission runs on the workstation's default model (deepseek on Scaleway in
# production): here it is the fake model too, or a mission could not reach it.
for routes in $(grep -rl "id: agent-default-model" "$data" 2>/dev/null); do
  sed -i "s#config: {provider: scaleway-genapi, model: deepseek-v4.1-flash}#config: {provider: vllm-qwen, model: fake-qwen}#" "$routes"
  echo "default model of the rehearsal: vllm-qwen/fake-qwen ($routes)"
done
step "1 bis. nothing of an operator's machine in the image"
# .git (its config may carry a credential), environment files but the examples,
# npm credentials, and key-shaped strings in the image's own code.
image_secrets=$(docker run --rm --entrypoint sh "$image" -c '
  find /app /etc -name .git -prune -print 2>/dev/null | head -3
  find /app /etc \( -name "*.env" -o -name ".env" -o -name ".env.*" \) -not -name "*.example" -not -path "*/node_modules/*" 2>/dev/null | head -3
  find /app /etc /root -name .npmrc -not -path "*/node_modules/*" -exec grep -l "_authToken" {} + 2>/dev/null | head -3
  grep -rIlE "(lin_api_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})" /app --exclude-dir=node_modules --exclude="*.js" --exclude="*.mjs" --exclude="*.cjs" --exclude="*.map" 2>/dev/null | head -3' 2>&1)
if [ -z "$image_secrets" ]; then echo "OK  image-clean    no .git, no environment file, no npm credential, no key-shaped string in /app and /etc"; imaged=0
else echo "KO  image-clean    found in the image:"; echo "$image_secrets" | sed 's/^/      /'; imaged=1; fi
step "2. first start"
node "$here/up-run.mjs" "$root/compose.yml" "$root/compose.override.yml" $project || exit 1
if health 80; then echo "API answers through the gateway"; else echo "KO: the API does not answer after the first start"; workbench_log; fi
echo "--- profiles/web/cordis.patch.yml as DSH wrote it:"; cat "$data/home/profiles/web/cordis.patch.yml" 2>/dev/null || echo "(absent)"

step "3. seed-team.sh, the production script (Compose calls through compose-shim.sh)"
# The workbench writes its profile files as root; on the server seed-team.sh runs
# as root too. Here it runs as this user, so hand the profile files over first.
docker exec -u 0 $project-workbench chown -R "$(id -u):$(id -g)" /state/home/profiles || exit 1
# A second MCP server, mounted for the tool probe and never allowed in the
# rehearsal's channel: the turn must neither see nor run it (seed-team.sh
# restarts the workbench right after, which starts it).
mkdir -p "$data/tools"
cp "$deploy/connectors/facts-mcp.mjs" "$data/tools/facts-mcp.mjs"
printf 'Faits de repetition.\n' > "$data/tools/facts.md"
MNDT_HOME=$data RENDER_SCRIPT="$deploy/connectors/render-connectors.py" \
  bash "$deploy/enable-facts-connector.sh" /nonexistent.tar.gz --no-restart || echo "KO: the facts server was not mounted"
shim=$(mktemp -d "$root/shim-XXXX"); cp "$here/compose-shim.sh" "$shim/docker"; chmod +x "$shim/docker"
REHEARSAL_DOCKER=$(command -v docker) REHEARSAL_PROJECT=$project MNDT_ROOT=$root PATH="$shim:$PATH" \
  bash "$deploy/tenant/seed-team.sh" datanalysis --owner $owner; seeded=$?
echo "seed-team.sh exit $seeded"
echo "--- profiles/web/cordis.patch.yml after the mount:"; cat "$data/home/profiles/web/cordis.patch.yml"

step "4. after the restart"
if health 60; then echo "the workbench came back"; else echo "KO: the workbench does not come back after seed-team.sh"; docker ps -a --filter name=$project --format '{{.Names}} {{.Status}}'; workbench_log; fi

step "4 bis. both patch files, then the connectors without any model"
checked=0
for file in "$data/home/cordis.patch.yml" "$data/home/profiles/web/cordis.patch.yml"; do
  python3 "$deploy/patchfile.py" "$file" --check || checked=1
done
# mcp-check.mjs, as install-connectors.sh installs it (the rehearsal does not
# run install-connectors.sh: it downloads, and needs the real secrets).
cp "$deploy/connectors/mcp-check.mjs" "$data/tools/mcp-check.mjs"
MNDT_ROOT=$root MNDT_CHECK_EXEC="docker exec -i $project-workbench" bash "$deploy/tenant/check-connectors.sh" datanalysis; connectors=$?
echo "check-connectors.sh exit $connectors"

step "4 ter. the attack of the security report, from the workbench"
attack; attacked=$?
echo "attack exit $attacked (0 = every path refused)"
deposit; deposited=$?

step "5. the page, the turn, the resets"
page=0
if page_ready 150; then echo "the page is ready (launch token published)"; else page=1; echo "KO: the gateway opens no session after 450 s (no launch token)"; docker logs --tail 5 $project-workbench 2>&1; fi
playwright=$(ls -d "$repo"/node_modules/.pnpm/playwright@*/node_modules/playwright 2>/dev/null | sort -V | head -1)
if [ -z "$playwright" ]; then echo "KO: Playwright is not installed in $repo/node_modules (pnpm install)" >&2; exit 1; fi
node "$here/drive.mjs" "$playwright/index.mjs" $project "$root/shots"; driven=$?

step "6. the sandbox of the running workbench, canaries where its secrets live"
# The model.env canary is in the workbench's environment (env_file): the probe
# must not reach it. The others where the instance keeps its secrets (the tools
# folder, mounted from inside /state, and another session's spill in /tmp
# included), plus one where reading is allowed (the probe must see it, or it
# proves nothing).
printf '{ "CANARY_SECRET_tokens": { "user": "nobody@datanalysis.re" } }\n' > "$data/tokens.json"
printf 'CANARY_SECRET_connector_env=1\n' > "$data/connectors/probe-canary.env"
printf 'CANARY_SECRET_tools_data\n' > "$data/tools/canary-facts.md"
docker exec -u 0 $project-workbench sh -c 'mkdir -p /state/channels/chn_other/files /state/home/sessions/--state-channels-chn_other-files-- /state/channels/chn_probe/files /tmp/probe-tools /tmp/dsh-subprocess-other \
  && echo CANARY_SECRET_other_channel > /state/channels/chn_other/files/note.txt \
  && echo CANARY_SECRET_transcript > /state/home/sessions/--state-channels-chn_other-files--/turn.jsonl \
  && echo CANARY_SECRET_spill > /tmp/dsh-subprocess-other/stdout \
  && echo CANARY_SECRET_dev_shm > /dev/shm/canary && echo "# CANARY_SEARCHED_etc" > /etc/mndt-probe-searched.conf'
docker cp "$here/probe.sh" $project-workbench:/state/channels/chn_probe/files/probe.sh >/dev/null
docker cp "$here/sandbox-probe.mjs" $project-workbench:/tmp/probe-tools/sandbox-probe.mjs >/dev/null
planted=$(docker exec $project-workbench sh -c 'tr "\0" "\n" < /proc/1/environ | grep -c CANARY_SECRET_MODEL_ENV; grep -c . /run/mndt-launch/web-token')
probe_out=$(docker exec $project-workbench node /tmp/probe-tools/sandbox-probe.mjs /state/channels/chn_probe/files probe.sh 2>&1)
echo "$probe_out" | grep -E '^(RUNNER|READ|LEAK|SEEN|CROSS|OPEN|DONE|TIMEOUT|TRUNCATED|WITNESS|SANDBOX-REFUSED)' | sed 's/^/    /'
live=0
[ "$(echo "$planted" | head -1)" -ge 1 ] && [ "$(echo "$planted" | tail -1)" -ge 1 ] || { echo "KO  live-planted   the model.env canary is not in the workbench's environment, or no launch token: the probe would prove nothing"; live=1; }
leaks=$(echo "$probe_out" | grep -cE '^(LEAK|CROSS|OPEN|TIMEOUT|TRUNCATED)')
if [ "$leaks" = 0 ]; then echo "OK  live-no-leak   on the running workbench: no LEAK, no CROSS, no cut walk (environment, /proc, /state, /opt/mndt-tools, /run, /tmp, /dev/shm, /root)"; else echo "KO  live-no-leak   $leaks LEAK/CROSS/OPEN/TIMEOUT/TRUNCATED line(s)"; live=1; fi
if echo "$probe_out" | grep -q '^SEEN file .*SEARCHED_etc'; then echo "OK  live-searched  the probe read /etc, where reading is allowed"; else echo "KO  live-searched  the probe did not read the allowed place"; live=1; fi
if echo "$probe_out" | grep -q '^DONE6' && echo "$probe_out" | grep -q '^WITNESS own-channel-file' && echo "$probe_out" | grep -q '^RUNNER .*landlock'; then echo "OK  live-witness   Landlock, every step done, the agent still writes in its channel"; else echo "KO  live-witness   $(echo "$probe_out" | grep -E '^(RUNNER|SANDBOX-REFUSED)' | head -1)"; live=1; fi

step "7. the sandbox proof: the same probe with and without the allow-list, three sessions"
bash "$here/sandbox-proof.sh" "$image" | grep -E '^(OK|KO|LIMIT|NOTE|sandbox-proof) ' ; proved=${PIPESTATUS[0]}

[ "$proved" = 0 ] && [ "$page" = 0 ] && [ "$attacked" = 0 ] && [ "$deposited" = 0 ] && [ "$seeded" = 0 ] && [ "$checked" = 0 ] && [ "$connectors" = 0 ] && [ "$driven" = 0 ] && [ "$imaged" = 0 ] && [ "$live" = 0 ]
