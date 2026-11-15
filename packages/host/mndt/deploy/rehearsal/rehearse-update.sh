#!/usr/bin/env bash
# The update of an instance installed before the shared patch guard, rehearsed on
# this machine, as the guide's step 13 does it on the server:
#   A. the instance of 13/11: the tenant scripts of OLD_REF (before #27..#36) and
#      their image; seed-team.sh appends its block after the `[]` dsh writes, the
#      workbench restarts in a loop; repaired by hand as on the instance (the `[]`
#      line removed), the old installed renderer left in place;
#   B. step 13 with this checkout: create-tenant.sh with the same arguments, the
#      LLM routes, the containers recreated on the new image, seed-team.sh, the
#      installed renderer run as install-connectors.sh runs it, a restart, both
#      patch files checked by patchfile.py, check-connectors.sh, then drive.mjs.
# Nothing leaves this machine: the routes point at fake-llm.mjs, SSO is replaced
# by the identity header given to the gateway.
#
#   rehearse-update.sh <old image> <new image> [rehearsal root]
# OLD_REF (default 96d2801d8a, the 13/11 breakage) names the old tenant scripts. OLD_STATE=installed
# starts instead from an instance installed and working at OLD_REF, required then
# (47169065bf, the one of 14/11): no 13/11 breakage to reproduce; an automation briefing runs
# on it first, so the update must stop serving that old shared brief to the
# team. KEEP=1 leaves the containers running.
set -uo pipefail
old_image=${1:?usage: rehearse-update.sh <old image> <new image> [rehearsal root]}
new_image=${2:?usage: rehearse-update.sh <old image> <new image> [rehearsal root]}
here=$(cd "$(dirname "$0")" && pwd)
deploy=$(cd "$here/.." && pwd)
repo=$(cd "$deploy/../../../.." && pwd)
old_ref=${OLD_REF:-96d2801d8a}
old_state=${OLD_STATE:-broken}
if [ "$old_state" = installed ] && [ -z "${OLD_REF:-}" ]; then echo "refused: OLD_STATE=installed needs OLD_REF, the commit the instance runs (47169065bf on 16/11)" >&2; exit 2; fi
project=mndt-rehearsal
# The rehearsal root is written freely (model.env, grants.json, chmod -R): never
# an existing instance. Only a new or empty folder under the temporary directory.
tmp_base=$(cd "${TMPDIR:-/tmp}" && pwd -P)
if [ -n "${3:-}" ]; then
  # Resolved without creating anything: a refused root is never touched.
  root=$(realpath -m "${3}")
else
  root=$(mktemp -d "$tmp_base/mndt-update-XXXX")
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
web_patch=$data/home/profiles/web/cordis.patch.yml
mkdir -p "$root/root" "$root/shots" "$root/old"
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
state() { docker inspect -f '{{.State.Status}} restarts={{.RestartCount}}' $project-workbench 2>/dev/null; }
# The workbench writes its profile files as root; on the server the scripts run
# as root too. Here they run as this user: hand the files over before each write.
own() { docker exec -u 0 $project-workbench chown -R "$(id -u):$(id -g)" /state/home >/dev/null 2>&1 || true; }
tenant() { # <deploy dir>
  MNDT_ROOT=$root bash "$1/create-tenant.sh" datanalysis equipe.datanalysis.re --owner $owner \
    --client-id 00000000-0000-0000-0000-000000000000 --client-secret-file /root/entra_client_secret --no-docker
}
compose_for() { # <image>
  sed -e "s#/data/mndt/datanalysis/live#$data#g" -e "s#/opt/mndt/datanalysis#$app#g" -e "s#/etc/mndt/datanalysis#$root/etc/mndt/datanalysis#g" \
      -e "s#image: mndt-workbench:local#image: $1#" \
      -e "s#PUBLIC_URL: https://equipe.datanalysis.re/#PUBLIC_URL: http://127.0.0.1:18080/#" \
      -e "s#TRUSTED_HOST: equipe.datanalysis.re#TRUSTED_HOST: 127.0.0.1:18080#" \
      "$app/docker-compose.yml" > "$root/compose.yml"
}
seed() { # <deploy dir>
  local shim; shim=$(mktemp -d "$root/shim-XXXX"); cp "$here/compose-shim.sh" "$shim/docker"; chmod +x "$shim/docker"
  REHEARSAL_DOCKER=$(command -v docker) REHEARSAL_PROJECT=$project MNDT_ROOT=$root PATH="$shim:$PATH" \
    bash "$1/tenant/seed-team.sh" datanalysis --owner $owner
}

step "A1. the instance of 13/11: tenant scripts of $old_ref, image $old_image (root $root)"
git -C "$repo" archive "$old_ref" packages/host/mndt/deploy | tar -x -C "$root/old" || exit 1
old=$root/old/packages/host/mndt/deploy
printf 'secret' > "$root/root/entra_client_secret"
tenant "$old" || exit 1
cat > "$data/model.env" <<ENV
SCW_GENAPI_KEY=rehearsal
VLLM_API_KEY=placeholder
SCW_PROJECT_ID=11111111-2222-3333-4444-555555555555
VLLM_QWEN_BASE_URL=http://fakellm:8000/v1
VLLM_QWEN_MODEL=fake-qwen
ENV
MNDT_HOME=$data python3 "$old/llm/render-llm-routes.py" --env-file "$data/model.env" || exit 1
# A mission (the old briefing) runs on the default model: the fake one here too.
for routes in $(grep -rl "id: agent-default-model" "$data" 2>/dev/null); do
  sed -i "s#config: {provider: scaleway-genapi, model: deepseek-v4.1-flash}#config: {provider: vllm-qwen, model: fake-qwen}#" "$routes"
done
# An admin who is not the owner too: the drive checks that missions stay closed to them.
printf '{ "grants": [ { "subject": "%s", "role": "owner" }, { "subject": "%s", "role": "viewer" }, { "subject": "%s", "role": "admin" } ] }\n' $owner $viewer $admin > "$data/grants.json"
compose_for "$old_image"
cat > "$root/compose.override.yml" <<YML
services:
  gateway:
    ports: ["127.0.0.1:18080:8080"]
  workbench:
    # Nothing leaves this machine: the managed endpoint answers nowhere.
    extra_hosts: ["api.scaleway.ai:127.0.0.1"]
  fakellm:
    image: node:22-bookworm-slim
    command: ["node", "/opt/fake/fake-llm.mjs"]
    volumes: ["$here:/opt/fake:ro"]
YML
# Readable by the containers, but never under home/: the workbench refuses a
# credentials file readable beyond its owner (credentials-local, mode 600).
find "$root" -path "$data/home" -prune -o -exec chmod a+rX {} + 2>/dev/null
node "$here/up-run.mjs" "$root/compose.yml" "$root/compose.override.yml" $project || exit 1
if health 80; then echo "first start: the API answers"; else echo "KO: no API after the first start"; fi

if [ "$old_state" = installed ]; then
  step "A2. the instance as installed at $old_ref: its own seed-team.sh, then an automation briefing run by the owner"
  own
  seed "$old"; echo "old seed-team.sh exit $?"
  if health 80; then echo "installed: the API answers"; else echo "KO: the installed instance does not answer"; fi
  # On the old version a briefing is the team's (createdBy « scheduler »,
  # visibility team): after the update it must no longer reach a non-owner.
  old_run=$(curl -s -m 200 -o /dev/null -w '%{http_code}' -X POST -H "x-forwarded-email: $owner" -H 'content-type: application/json' -d '{}' \
    http://127.0.0.1:18080/mndt-api/automations/auto_briefing/run)
  old_seen=$(curl -s -m 20 -H "x-forwarded-email: $viewer" http://127.0.0.1:18080/mndt-api/briefs | grep -o '"id":"brf_[^"]*"' | wc -l)
  echo "old briefing run by the owner: $old_run; briefs the viewer reads on the old version: $old_seen"
  # The starting point this rehearsal needs: an old shared brief the team reads
  # (the update must stop serving it). Without it, the update proves nothing.
  if [ "$old_run" = 200 ] && [ "$old_seen" -ge 1 ]; then broke=1; else broke=0; echo "KO: no old shared brief to hide, the update below would prove nothing"; fi
else
step "A2. the old seed-team.sh: its block lands after the [] (expected to break)"
own
seed "$old"; echo "old seed-team.sh exit $?"
sleep 15
echo "workbench: $(state)"
# Refused because it does not parse, not because it is absent (exit 1 either way).
if [ -f "$web_patch" ]; then python3 "$deploy/patchfile.py" "$web_patch" --check; broke=$?; else echo "absent: $web_patch"; broke=0; fi
echo "check exit $broke (1 expected: the 13/11 breakage)"
# The update proves something only if the old instance really broke.
if [ "$broke" != 1 ]; then echo "KO: the 13/11 breakage was not reproduced, the update below would prove nothing"; fi

step "A3. repaired by hand, as on the instance: the [] line removed, the old renderer left installed"
own
sed -i '/^\[\][[:space:]]*$/d' "$web_patch"
docker restart $project-workbench >/dev/null
if health 80; then echo "repaired: the API answers"; else echo "KO: no API after the hand repair"; fi
own
seed "$old"; echo "old seed-team.sh (agents) exit $?"
echo "installed renderer before step 13: $(grep -c patchfile "$app/gateway/render-connectors.py") mention(s) of patchfile (0 = before the guard)"

fi

step "B1. step 13: create-tenant.sh with the same arguments, the LLM routes"
own
tenant "$deploy" || exit 1
MNDT_HOME=$data python3 "$deploy/llm/render-llm-routes.py" --env-file "$data/model.env" || exit 1
# As rehearse.sh: a mission runs on the default model, here the fake one, and a
# second MCP server is mounted that no channel allows (the drive's tool probe).
for routes in $(grep -rl "id: agent-default-model" "$data" 2>/dev/null); do
  sed -i "s#config: {provider: scaleway-genapi, model: deepseek-v4.1-flash}#config: {provider: vllm-qwen, model: fake-qwen}#" "$routes"
done
mkdir -p "$data/tools"
cp "$deploy/connectors/facts-mcp.mjs" "$data/tools/facts-mcp.mjs"
printf 'Faits de repetition.\n' > "$data/tools/facts.md"
MNDT_HOME=$data RENDER_SCRIPT="$deploy/connectors/render-connectors.py" \
  bash "$deploy/enable-facts-connector.sh" /nonexistent.tar.gz --no-restart || echo "KO: the facts server was not mounted"
echo "installed renderer now: $(grep -c patchfile "$app/gateway/render-connectors.py") mention(s) of patchfile"

step "B2. docker compose up -d on $new_image: a container whose configuration did not change is kept"
compose_for "$new_image"
signed_override
# Readable by the containers, but never under home/: the workbench refuses a
# credentials file readable beyond its owner (credentials-local, mode 600).
find "$root" -path "$data/home" -prune -o -exec chmod a+rX {} + 2>/dev/null
node "$here/up-run.mjs" "$root/compose.yml" "$root/compose.override.yml" $project || exit 1
# As the guide does: seed-team.sh right after up -d, without waiting here.
gateway_code=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $project-gateway | grep -c '^MNDT_GATEWAY_CODE=' || true)
echo "gateway: $(docker inspect -f '{{.State.StartedAt}}' $project-gateway), code fingerprint in its env: $gateway_code"

step "B3. seed-team.sh right away (it restarts the workbench itself when approvals changed), then the installed renderer"
started_before=$(docker inspect -f '{{.State.StartedAt}}' $project-workbench)
own
seed "$deploy"; seeded=$?; echo "seed-team.sh exit $seeded"
started_after=$(docker inspect -f '{{.State.StartedAt}}' $project-workbench)
# From the instance as installed the approvals descriptor is rewritten: seed-team.sh
# must have restarted the workbench on its own (no restart of ours hides it).
restarted=0
if [ "$old_state" = installed ]; then
  if [ "$started_before" != "$started_after" ]; then echo "OK  seed-restart   seed-team.sh restarted the workbench after rewriting approvals"
  else echo "KO  seed-restart   seed-team.sh rewrote approvals but did not restart the workbench"; restarted=1; fi
fi
own
patch_before=$(sha256sum < "$web_patch" 2>/dev/null)
MNDT_HOME=$data python3 "$app/gateway/render-connectors.py"; rendered=$?; echo "installed renderer exit $rendered"
# As install-connectors.sh: a restart only when the renderer changed the patch.
if [ "$(sha256sum < "$web_patch" 2>/dev/null)" != "$patch_before" ]; then echo "the renderer changed the patch: restart"; docker restart $project-workbench >/dev/null; else echo "the renderer changed nothing"; fi
if health 80; then echo "the workbench answers"; else echo "KO: the workbench does not answer"; echo "workbench: $(state)"; docker exec $project-workbench tail -15 /run/mndt-launch/web.log 2>/dev/null; fi

step "B4. both patch files, then the connectors without any model"
checked=0
for file in "$data/home/cordis.patch.yml" "$web_patch"; do
  python3 "$deploy/patchfile.py" "$file" --check || checked=1
done
echo "workbench: $(state)"
# mcp-check.mjs, as install-connectors.sh installs it (the rehearsal does not
# run install-connectors.sh: it downloads, and needs the real secrets).
cp "$deploy/connectors/mcp-check.mjs" "$data/tools/mcp-check.mjs"
MNDT_ROOT=$root MNDT_CHECK_EXEC="docker exec -i $project-workbench" bash "$deploy/tenant/check-connectors.sh" datanalysis; connectors=$?
echo "check-connectors.sh exit $connectors"

step "B4 bis. the attack of the security report, from the workbench"
attack; attacked=$?
echo "attack exit $attacked (0 = every path refused)"
deposit; deposited=$?

step "B5. the page, the turn, the resets"
# The launch token and the shell's log left under /state by the old version are gone.
gone=0
if [ -e "$data/web-token" ]; then echo "KO  web-token-gone  $data/web-token is still there"; gone=1; else echo "OK  web-token-gone  no launch token under /state"; fi
if [ -e "$data/home/web.log" ]; then echo "KO  web-log-gone    $data/home/web.log is still there"; gone=1; else echo "OK  web-log-gone    no shell log under /state"; fi
page=0
if page_ready 150; then echo "the page is ready (launch token published)"; else page=1; echo "KO: the gateway opens no session after 450 s (no launch token)"; docker logs --tail 5 $project-workbench 2>&1; fi
playwright=$(ls -d "$repo"/node_modules/.pnpm/playwright@*/node_modules/playwright 2>/dev/null | sort -V | head -1)
if [ -z "$playwright" ]; then echo "KO: Playwright is not installed in $repo/node_modules (pnpm install)" >&2; exit 1; fi
node "$here/drive.mjs" "$playwright/index.mjs" $project "$root/shots"; driven=$?

[ "$page" = 0 ] && [ "$attacked" = 0 ] && [ "$deposited" = 0 ] && [ "$broke" = 1 ] && [ "$seeded" = 0 ] && [ "$rendered" = 0 ] && [ "$checked" = 0 ] && [ "$connectors" = 0 ] && [ "$driven" = 0 ] && [ "$gone" = 0 ] && [ "$restarted" = 0 ]
