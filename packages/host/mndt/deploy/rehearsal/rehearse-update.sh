#!/usr/bin/env bash
# The update of an installed instance, rehearsed on this machine, as the
# guide's step 13 does it on the server:
#   A. the instance as installed at OLD_REF: that commit's tenant scripts and
#      its image, its own seed-team.sh, an automation briefing run by the owner;
#   B. step 13 with this checkout: create-tenant.sh with the same arguments, the
#      LLM routes, the containers recreated on the new image, seed-team.sh, the
#      installed renderer run as install-connectors.sh runs it, a restart, both
#      patch files checked by patchfile.py, check-connectors.sh, then drive.mjs.
# Nothing leaves this machine: the routes point at fake-llm.mjs, SSO is replaced
# by the identity header given to the gateway.
#
#   rehearse-update.sh <old image> <new image> [rehearsal root]
# OLD_REF (required) names the commit the instance runs: the rehearsal starts
# from an instance installed and working there, with that commit's tenant
# scripts; an automation briefing runs on it first, so the update must stop
# serving an old shared brief to the team. OLD_STATE, if given, must be
# « installed »: the departure from the broken 13/11 instance (OLD_STATE=broken)
# was retired on 23/11, the instance having left it behind and its reference
# image being gone. KEEP=1 leaves the containers running.
# NEW_REF names the new version's tenant scripts (phase B: create-tenant.sh,
# seed-team.sh, the tools copied to tools/, the patch checks), extracted from
# that commit as OLD_REF's are; the harness (deploy/rehearsal) stays the
# running tree's. Without it, phase B takes the running tree's scripts: a pass
# for an older new image then mixes that image with newer tenant scripts.
set -uo pipefail
# A step that cannot go on says why, as a named KO, then stops.
die() { echo "KO $1  $2"; exit 1; }
old_image=${1:?usage: rehearse-update.sh <old image> <new image> [rehearsal root]}
new_image=${2:?usage: rehearse-update.sh <old image> <new image> [rehearsal root]}
here=$(cd "$(dirname "$0")" && pwd)
. "$here/checks.sh"
deploy=$(cd "$here/.." && pwd)
repo=$(cd "$deploy/../../../.." && pwd)
old_state=${OLD_STATE:-installed}
if [ "$old_state" != installed ]; then echo "KO unknown-old-state  OLD_STATE=$old_state: only « installed » is rehearsed (the 13/11 departure was retired on 23/11)" >&2; exit 2; fi
if [ -z "${OLD_REF:-}" ]; then echo "refused: OLD_REF is required, the commit the instance runs (9979d2532e before the second jump)" >&2; exit 2; fi
old_ref=$OLD_REF
# The checks a full run makes, by name, each printed once OK or KO (the exit
# trap compares): change the list with the checks.
EXPECTED_CHECKS=$here/expected-checks-update.txt
project=mndt-rehearsal
# The members' computers: their images, their settings, their cleanup.
. "$here/machines-rehearsal.sh"
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
mkdir -p "$root" || die root-mkdir "cannot create the rehearsal root $root"
if [ -n "$(ls -A "$root")" ]; then echo "refused: the rehearsal root $root is not empty" >&2; exit 2; fi
touch "$root/.mndt-rehearsal"
# Whatever the exit, the containers and their network go, unless KEEP=1: the
# workbench restarts unless stopped and would loop on. The root stays, for the
# screenshots and the logs.
cleanup() {
  if [ "${KEEP:-0}" != 1 ]; then
    docker rm -f $project-gateway $project-workbench $project-fakellm $project-signer >/dev/null 2>&1
    docker network rm ${project}_front ${project}_ingress ${project}_outside >/dev/null 2>&1
    machines_cleanup
  fi
  # Stopped before its verdict (a die, a guard, a crash): said as a KO, with
  # the last step it reached, so the total never reads « ko=0 » on a run cut short.
  if [ -z "${verdict:-}" ]; then echo "KO aborted  stopped before the verdict, during « ${last_step:-the set-up} »"; fi
  # The total, counted by the script over everything it and its sub-scripts
  # said: the one line a reader goes by. The pipe to tee is closed and tee
  # waited for first, so the count reads the whole log.
  if [ -n "${tee_pid:-}" ]; then exec 1>&3 2>&4; wait "$tee_pid" 2>/dev/null; fi
  total_ok=$(grep -acE '^OK ' "$root/output.log" 2>/dev/null) || total_ok=0
  total_ko=$(grep -acE '^KO ' "$root/output.log" 2>/dev/null) || total_ko=0
  # Every check the run must make, by name: a check skipped without an error
  # (a condition that jumps a block, an early return) prints neither OK nor KO,
  # and a check printed twice would hide it in a mere count. The KO lines
  # about the run itself are not checks.
  grep -aE '^(OK|KO) ' "$root/output.log" 2>/dev/null \
    | grep -avE '^KO +(aborted|drive-exit|missing-checks|duplicate-check|unexpected-check) ' \
    | awk '{ print $2 }' > "$root/checks-seen.txt"
  grep -v '^#' "$EXPECTED_CHECKS" | sort -u > "$root/checks-expected.txt"
  expected=$(grep -c . "$root/checks-expected.txt") || expected=0
  missing=$(sort -u "$root/checks-seen.txt" | comm -23 "$root/checks-expected.txt" - | tr '\n' ' ')
  unexpected=$(sort -u "$root/checks-seen.txt" | comm -13 "$root/checks-expected.txt" - | tr '\n' ' ')
  if [ -n "$missing" ]; then echo "KO missing-checks ${missing% }"; total_ko=$((total_ko + 1)); fi
  for name in $(sort "$root/checks-seen.txt" | uniq -d); do echo "KO duplicate-check $name"; total_ko=$((total_ko + 1)); done
  if [ -n "$unexpected" ]; then echo "KO unexpected-check ${unexpected% }  printed, not declared in $(basename "$EXPECTED_CHECKS")"; total_ko=$((total_ko + 1)); fi
  echo "TOTAL ok=$total_ok ko=$total_ko expected=$expected"
  echo "rehearsal root: $root"
  if [ "$total_ko" -gt 0 ] || [ "${verdict:-1}" != 0 ]; then exit 1; fi
}
trap cleanup EXIT
# Everything said goes to the screen and to output.log, which the total counts.
: > "$root/output.log"
exec 3>&1 4>&2
exec > >(tee -a "$root/output.log") 2>&1
tee_pid=$!
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
# The managed route answered by the fake model, in this rehearsal's copy of the
# patch only: the coordinated turns need models of their own, priced as on the
# instance. The tenant's own rendering keeps the real URL: checked below.
fake_scaleway() {
  sed -i 's#baseURL: https://api.scaleway.ai/[^ ]*#baseURL: http://fakellm:8000/v1#' "$data/home/cordis.patch.yml"
  real=$(MNDT_HOME=$data python3 "$deploy/llm/render-llm-routes.py" --env-file "$data/model.env" --print | grep -c 'baseURL: https://api.scaleway.ai/') || real=0
  copied=$(grep -c 'baseURL: http://fakellm:8000/v1' "$data/home/cordis.patch.yml") || copied=0
  template=$(grep -c 'api.scaleway.ai' "$deploy/llm/routes.patch.yml.template") || template=0
  if [ "$real" -ge 1 ] && [ "$template" -ge 1 ] && [ "$copied" -ge 2 ]; then
    echo "OK  routes-real-scaleway  the tenant's rendering keeps https://api.scaleway.ai/ ($real), the rehearsal's copy alone points both routes at the fake model ($copied)"
  else
    echo "KO  routes-real-scaleway  rendering $real, template $template, rehearsal copy $copied: the fake URL must stay in the rehearsal's copy"
  fi
}
step() { last_step=$*; printf '\n== %s\n' "$*"; }
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
      -e "s#image: mndt-machines:local#image: $machines_image#" -e "s#PC_IMAGE: mndt-pc:local#PC_IMAGE: $pc_image#" \
      -e "s#image: mndt-workbench:local#image: $1#" \
      -e "s#PUBLIC_URL: https://equipe.datanalysis.re/#PUBLIC_URL: http://127.0.0.1:18080/#" \
      -e "s#TRUSTED_HOST: equipe.datanalysis.re#TRUSTED_HOST: 127.0.0.1:18080#" \
      "$app/docker-compose.yml" > "$root/compose.yml"
  # The computers, once the new tenant scripts render them (the old ones did not).
  machines_rehearsal_compose "$root/compose.yml"
}
seed() { # <deploy dir>
  local shim; shim=$(mktemp -d "$root/shim-XXXX"); cp "$here/compose-shim.sh" "$shim/docker"; chmod +x "$shim/docker"
  REHEARSAL_DOCKER=$(command -v docker) REHEARSAL_PROJECT=$project MNDT_ROOT=$root PATH="$shim:$PATH" \
    bash "$1/tenant/seed-team.sh" datanalysis --owner $owner
}

step "A1. the instance as installed: tenant scripts of $old_ref, image $old_image (root $root)"
git -C "$repo" archive "$old_ref" packages/host/mndt/deploy | tar -x -C "$root/old" || die old-archive "cannot extract the tenant scripts of $old_ref"
old=$root/old/packages/host/mndt/deploy
if [ -n "${NEW_REF:-}" ]; then
  mkdir -p "$root/new"
  git -C "$repo" archive "$NEW_REF" packages/host/mndt/deploy | tar -x -C "$root/new" || die new-archive "cannot extract the tenant scripts of $NEW_REF"
  deploy=$root/new/packages/host/mndt/deploy
  echo "new tenant scripts: $NEW_REF (the harness stays this tree's)"
fi
printf 'secret' > "$root/root/entra_client_secret"
tenant "$old" || die old-tenant "create-tenant.sh of $old_ref failed"
cat > "$data/model.env" <<ENV
SCW_GENAPI_KEY=rehearsal
VLLM_API_KEY=placeholder
SCW_PROJECT_ID=11111111-2222-3333-4444-555555555555
VLLM_QWEN_BASE_URL=http://fakellm:8000/v1
VLLM_QWEN_MODEL=fake-qwen
ENV
MNDT_HOME=$data python3 "$old/llm/render-llm-routes.py" --env-file "$data/model.env" || die old-routes "the LLM routes of $old_ref were not written"
# A mission (the old briefing) runs on the default model: the fake one here too.
for routes in $(grep -rl "id: agent-default-model" "$data" 2>/dev/null); do
  sed -i "s#config: {provider: scaleway-genapi, model: deepseek-v4.1-flash}#config: {provider: vllm-qwen, model: fake-qwen}#" "$routes"
done
# An admin who is not the owner too: the drive checks that missions stay closed to them.
printf '{ "grants": [ { "subject": "%s", "role": "owner" }, { "subject": "%s", "role": "viewer" }, { "subject": "%s", "role": "admin" }, { "subject": "%s", "role": "operator" } ] }\n' $owner $viewer $admin operateur@datanalysis.re > "$data/grants.json"
compose_for "$old_image"
# An installed instance has the tenant topology since #56: the gateway listens
# on the ingress network only, behind the signing proxy.
signed_override
# Readable by the containers, but never under home/: the workbench refuses a
# credentials file readable beyond its owner (credentials-local, mode 600).
find "$root" -path "$data/home" -prune -o -exec chmod a+rX {} + 2>/dev/null
node "$here/up-run.mjs" "$root/compose.yml" "$root/compose.override.yml" $project || die up "up-run.mjs could not start the containers"
if health 80; then echo "first start: the API answers"; else
  echo "KO first-start-api  no API after the first start"
  # An installed starting point that does not answer: nothing after it would prove anything.
  exit 1
fi

step "A2. the instance as installed at $old_ref: its own seed-team.sh, then an automation briefing run by the owner"
own
seed "$old"; echo "old seed-team.sh exit $?"
if health 80; then echo "installed: the API answers"; else echo "KO installed-api  the installed instance does not answer"; exit 1; fi
# On the old version a briefing is the team's (createdBy « scheduler »,
# visibility team): after the update it must no longer reach a non-owner.
old_run=$(curl -s -m 200 -o /dev/null -w '%{http_code}' -X POST -H "x-forwarded-email: $owner" -H 'content-type: application/json' -d '{}' \
  http://127.0.0.1:18080/mndt-api/automations/auto_briefing/run)
old_seen=$(curl -s -m 20 -H "x-forwarded-email: $viewer" http://127.0.0.1:18080/mndt-api/briefs | grep -o '"id":"brf_[^"]*"' | wc -l)
old_own=$(curl -s -m 20 -H "x-forwarded-email: $owner" http://127.0.0.1:18080/mndt-api/briefs | grep -o '"id":"brf_[^"]*"' | wc -l)
echo "old briefing run by the owner: $old_run; briefs on the old version: the viewer reads $old_seen, the owner $old_own"
# The starting point this rehearsal needs: an old shared brief the team reads
# (the update must stop serving it). Without it, the update proves nothing.
# Briefs became private in 9979d2532e (canReadMission): from 47169065bf the
# old brief is shared and the update must stop serving it; from a later
# version it is already private, and the owner must read it.
# 5bb9e1ea60 required the facts server for every briefing, and an instance the
# guide installs mounts none: there its briefings all failed (fixed after it).
# Said either way, then the facts mounted on the old version, so the
# rehearsal still has its starting brief.
old_failed=$(curl -s -m 20 -H "x-forwarded-email: $owner" http://127.0.0.1:18080/mndt-api/missions | jq -r '[.missions[]? | select(.kind == "briefing")] | last | .error // ""' 2>/dev/null)
if [ "$old_own" = 0 ] && echo "$old_failed" | grep -q 'outils indisponibles : workbench_facts'; then
  echo "OK  old-briefing-facts  the old version ($old_ref) requires the facts for a briefing, and the installed instance mounts none: « $old_failed ». The facts server is mounted on the old version for the starting brief"
  cp "$old/connectors/facts-mcp.mjs" "$data/tools/facts-mcp.mjs" 2>/dev/null || true
  printf 'Faits de repetition.\n' > "$data/tools/facts.md"
  own
  MNDT_HOME=$data RENDER_SCRIPT="$old/connectors/render-connectors.py" bash "$old/enable-facts-connector.sh" /nonexistent.tar.gz --no-restart >/dev/null || echo "KO old-facts-mounted  the facts server could not be mounted on the old version"
  docker restart $project-workbench >/dev/null
  if health 80; then echo "the old version restarted with the facts"; else echo "KO old-restart  the old version does not come back"; exit 1; fi
  sleep 20
  old_run=$(curl -s -m 200 -o /dev/null -w '%{http_code}' -X POST -H "x-forwarded-email: $owner" -H 'content-type: application/json' -d '{}' \
    http://127.0.0.1:18080/mndt-api/automations/auto_briefing/run)
  old_seen=$(curl -s -m 20 -H "x-forwarded-email: $viewer" http://127.0.0.1:18080/mndt-api/briefs | grep -o '"id":"brf_[^"]*"' | wc -l)
  old_own=$(curl -s -m 20 -H "x-forwarded-email: $owner" http://127.0.0.1:18080/mndt-api/briefs | grep -o '"id":"brf_[^"]*"' | wc -l)
  echo "old briefing run again, with the facts: $old_run; the viewer reads $old_seen, the owner $old_own"
else
  echo "OK  old-briefing-facts  the old version's briefing needed no facts server (briefs read by the owner: $old_own)"
fi
if [ "$old_run" != 200 ]; then echo "KO old-briefing-run  the old briefing did not run ($old_run): no starting point"; exit 1; fi
if [ "$old_seen" -ge 1 ]; then broke=1; echo "OK old-brief-shared  the viewer reads $old_seen old brief(s): the update must stop serving them"
elif [ "$old_own" -ge 1 ]; then broke=1; echo "OK old-brief-private  already private on the old version: the owner reads $old_own, the viewer none"
else broke=0; echo "KO old-brief-missing  nobody reads the old brief: no starting point"; exit 1; fi

# The guide's backups (§13.9 c.), before anything of the new version is written:
# the rollback rehearsal (reverse-rollback-8.sh) puts them back, as the guide does.
mkdir -p "$root/backup"
cp -a "$app" "$root/backup/compose" && cp -a "$root/etc/mndt/datanalysis" "$root/backup/etc" \
  && cp -a "$data/state.json" "$data/grants.json" "$data/connectors/approvals.json" "$root/backup/compose/" \
  || die backup "the guide's backups could not be made"
step "B1. step 13: create-tenant.sh with the same arguments, the LLM routes"
own
tenant "$deploy" || die tenant "create-tenant.sh of this version failed"
MNDT_HOME=$data python3 "$deploy/llm/render-llm-routes.py" --env-file "$data/model.env" || die routes "the LLM routes of this version were not written"
fake_scaleway
# As rehearse.sh: a mission runs on the default model, here the fake one, and a
# second MCP server is mounted that no channel allows (the drive's tool probe).
for routes in $(grep -rl "id: agent-default-model" "$data" 2>/dev/null); do
  sed -i "s#config: {provider: scaleway-genapi, model: deepseek-v4.1-flash}#config: {provider: vllm-qwen, model: fake-qwen}#" "$routes"
done
echo "installed renderer now: $(grep -c patchfile "$app/gateway/render-connectors.py") mention(s) of patchfile"

step "B2. docker compose up -d on $new_image: a container whose configuration did not change is kept"
machines_images_present || die machines-images "the computers' images are missing: build them first (build-machines.sh)"
compose_for "$new_image"
signed_override
# Readable by the containers, but never under home/: the workbench refuses a
# credentials file readable beyond its owner (credentials-local, mode 600).
find "$root" -path "$data/home" -prune -o -exec chmod a+rX {} + 2>/dev/null
node "$here/up-run.mjs" "$root/compose.yml" "$root/compose.override.yml" $project || die up "up-run.mjs could not start the containers"
# As the guide does: seed-team.sh right after up -d, without waiting here.
gateway_code=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $project-gateway | grep -c '^MNDT_GATEWAY_CODE=' || true)
echo "gateway: $(docker inspect -f '{{.State.StartedAt}}' $project-gateway), code fingerprint in its env: $gateway_code"

step "B3. seed-team.sh right away (it restarts the workbench itself when approvals changed), then the installed renderer"
started_before=$(docker inspect -f '{{.State.StartedAt}}' $project-workbench)
# What seed-team.sh restarts on: the approvals descriptor and the patch it renders.
approvals_print() { for f in "$data/connectors/approvals.json" "$web_patch"; do if [ -f "$f" ]; then sha256sum < "$f"; else echo absent; fi; done; }
approvals_before=$(approvals_print)
own
seed "$deploy"; seeded=$?; echo "seed-team.sh exit $seeded"
started_after=$(docker inspect -f '{{.State.StartedAt}}' $project-workbench)
approvals_after=$(approvals_print)
# When seed-team.sh changed the approvals descriptor or its rendered patch, it
# must have restarted the workbench on its own (no restart of ours hides it).
# When neither changed (an instance whose catalog is already this one's), no
# restart is the right answer: the check does not assume the update changes it.
restarted=0
seed_restart_verdict "$approvals_before" "$approvals_after" "$started_before" "$started_after" || restarted=1
own
# The second MCP server no channel allows (the drive's tool probe), mounted now
# that seed-team.sh has rewritten the descriptors from this version's catalog:
# the instance renders nothing before it either. facts-mcp.mjs itself: this
# version's create-tenant.sh installed it (tools-current).
printf 'Faits de repetition.\n' > "$data/tools/facts.md"
MNDT_HOME=$data RENDER_SCRIPT="$app/gateway/render-connectors.py" CONNECTOR_CATALOG="$app/gateway/catalog.json" \
  bash "$deploy/enable-facts-connector.sh" /nonexistent.tar.gz --no-restart || echo "KO facts-mounted  the facts server was not mounted"
patch_before=$(sha256sum < "$web_patch" 2>/dev/null)
MNDT_HOME=$data python3 "$app/gateway/render-connectors.py"; rendered=$?; echo "installed renderer exit $rendered"
# As install-connectors.sh: a restart only when the renderer changed the patch.
if [ "$(sha256sum < "$web_patch" 2>/dev/null)" != "$patch_before" ]; then echo "the renderer changed the patch: restart"; docker restart $project-workbench >/dev/null; else echo "the renderer changed nothing"; fi
if health 80; then echo "the workbench answers"; else echo "KO workbench-answers  the workbench does not answer"; echo "workbench: $(state)"; docker exec $project-workbench tail -15 /run/mndt-launch/web.log 2>/dev/null; fi

step "B4. both patch files, then the connectors without any model"
checked=0
for file in "$data/home/cordis.patch.yml" "$web_patch"; do
  python3 "$deploy/patchfile.py" "$file" --check || checked=1
done
echo "workbench: $(state)"
# The connector code create-tenant.sh installed: in the workbench, each file the
# same as this version's, and the two the update used to miss carry its marks
# (mcp-check.mjs knows --discover, facts-mcp.mjs answers « method not found »).
# Nothing here copies them: the tenant's own scripts must.
tools_current() {
  local stale="" tool inside
  for tool in approvals-mcp.mjs mcp-proxy.mjs office365-mcp.mjs facts-mcp.mjs mcp-check.mjs; do
    inside=$(docker exec $project-workbench sha256sum /opt/mndt-tools/$tool 2>/dev/null | cut -c1-16)
    [ "$inside" = "$(sha256sum "$deploy/connectors/$tool" | cut -c1-16)" ] || stale="$stale $tool"
  done
  local marks; marks=$(docker exec $project-workbench sh -c "grep -c 'sonde server/discover' /opt/mndt-tools/mcp-check.mjs; grep -c 'method not found' /opt/mndt-tools/facts-mcp.mjs" 2>/dev/null | paste -sd' ')
  if [ -z "$stale" ] && [ "${marks%% *}" -ge 1 ] 2>/dev/null && [ "${marks##* }" -ge 1 ] 2>/dev/null; then
    echo "OK  tools-current  the 5 connector files in /opt/mndt-tools are this version's (sha256), marks found (mcp-check --discover, facts -32601: $marks)"
  else
    echo "KO  tools-current  stale or missing in /opt/mndt-tools:${stale:- none}; marks « ${marks:-none} »"
  fi
}
tools_current
# mcp-check.mjs: this version's create-tenant.sh installed it, as on the
# instance (an update does not run install-connectors.sh).
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
if page_ready 150; then echo "the page is ready (launch token published)"; else page=1; echo "KO page-session  the gateway opens no session after 450 s (no launch token)"; docker logs --tail 5 $project-workbench 2>&1; fi
playwright=$(ls -d "$repo"/node_modules/.pnpm/playwright@*/node_modules/playwright 2>/dev/null | sort -V | head -1)
if [ -z "$playwright" ]; then echo "KO playwright  Playwright is not installed in $repo/node_modules (pnpm install)"; exit 1; fi
MNDT_REHEARSAL_CATALOG="$app/gateway/catalog.json" node "$here/drive.mjs" "$playwright/index.mjs" $project "$root/shots"; driven=$?
# A drive that dies prints no KO for the checks it never reached: say it, or
# the TOTAL reads ko=0 over a run cut short.
[ "$driven" = 0 ] || echo "KO  drive-exit  drive.mjs exited $driven: the checks after its last line were not run"

step "B6. the members' computers, new with this version (runtime $REHEARSAL_RUNTIME)"
bash "$here/machines-checks.sh" $project $owner operateur@datanalysis.re "$machines_space"; machined=$?
connector_secrets_check "$data" $project-workbench || machined=1

[ "$page" = 0 ] && [ "$machined" = 0 ] && [ "$attacked" = 0 ] && [ "$deposited" = 0 ] && [ "$broke" = 1 ] && [ "$seeded" = 0 ] && [ "$rendered" = 0 ] && [ "$checked" = 0 ] && [ "$connectors" = 0 ] && [ "$driven" = 0 ] && [ "$gone" = 0 ] && [ "$restarted" = 0 ]
verdict=$?
