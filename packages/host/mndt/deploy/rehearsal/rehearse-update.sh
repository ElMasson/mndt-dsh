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
# OLD_REF (default 96d2801d8a) names the old tenant scripts. KEEP=1 leaves the
# containers running.
set -uo pipefail
old_image=${1:?usage: rehearse-update.sh <old image> <new image> [rehearsal root]}
new_image=${2:?usage: rehearse-update.sh <old image> <new image> [rehearsal root]}
here=$(cd "$(dirname "$0")" && pwd)
deploy=$(cd "$here/.." && pwd)
repo=$(cd "$deploy/../../../.." && pwd)
old_ref=${OLD_REF:-96d2801d8a}
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
    docker rm -f $project-gateway $project-workbench $project-fakellm >/dev/null 2>&1
    docker network rm ${project}_front >/dev/null 2>&1
  fi
  echo "rehearsal root: $root"
}
trap cleanup EXIT
owner=duke@datanalysis.re; viewer=smarion@datanalysis.re
app=$root/opt/mndt/datanalysis; data=$root/data/mndt/datanalysis/live
web_patch=$data/home/profiles/web/cordis.patch.yml
mkdir -p "$root/root" "$root/shots" "$root/old"
# The API answers before dsh web prints its launch URL (it waits for every plugin):
# the page is ready when the gateway opens a session for a signed-in person.
page_ready() {
  for _ in $(seq 1 "${1:-150}"); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-forwarded-email: $owner" http://127.0.0.1:18080/)" = 302 ] && return 0
    sleep 3
  done
  return 1
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
  sed -e "s#/data/mndt/datanalysis/live#$data#g" -e "s#/opt/mndt/datanalysis#$app#g" \
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
printf '{ "grants": [ { "subject": "%s", "role": "owner" }, { "subject": "%s", "role": "viewer" } ] }\n' $owner $viewer > "$data/grants.json"
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
chmod -R a+rX "$root"
node "$here/up-run.mjs" "$root/compose.yml" "$root/compose.override.yml" $project || exit 1
if health 80; then echo "first start: the API answers"; else echo "KO: no API after the first start"; fi

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

step "B1. step 13: create-tenant.sh with the same arguments, the LLM routes"
own
tenant "$deploy" || exit 1
MNDT_HOME=$data python3 "$deploy/llm/render-llm-routes.py" --env-file "$data/model.env" || exit 1
echo "installed renderer now: $(grep -c patchfile "$app/gateway/render-connectors.py") mention(s) of patchfile"

step "B2. the containers recreated on $new_image (docker compose up -d)"
compose_for "$new_image"
chmod -R a+rX "$root"
node "$here/up-run.mjs" "$root/compose.yml" "$root/compose.override.yml" $project || exit 1
if health 80; then echo "the API answers on the new image"; else echo "KO: no API on the new image"; fi

step "B3. seed-team.sh, then the installed renderer as install-connectors.sh runs it, then a restart"
own
seed "$deploy"; seeded=$?; echo "seed-team.sh exit $seeded"
own
MNDT_HOME=$data python3 "$app/gateway/render-connectors.py"; rendered=$?; echo "installed renderer exit $rendered"
docker restart $project-workbench >/dev/null
if health 80; then echo "the workbench came back"; else echo "KO: the workbench does not come back"; echo "workbench: $(state)"; tail -15 "$data/home/web.log" 2>/dev/null; fi

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

step "B5. the page, the turn, the resets"
page=0
if page_ready 150; then echo "the page is ready (launch token published)"; else page=1; echo "KO: the gateway opens no session after 450 s (no launch token)"; docker logs --tail 5 $project-workbench 2>&1; fi
playwright=$(ls -d "$repo"/node_modules/.pnpm/playwright@*/node_modules/playwright 2>/dev/null | sort -V | head -1)
if [ -z "$playwright" ]; then echo "KO: Playwright is not installed in $repo/node_modules (pnpm install)" >&2; exit 1; fi
node "$here/drive.mjs" "$playwright/index.mjs" $project "$root/shots"; driven=$?

[ "$page" = 0 ] && [ "$broke" = 1 ] && [ "$seeded" = 0 ] && [ "$rendered" = 0 ] && [ "$checked" = 0 ] && [ "$connectors" = 0 ] && [ "$driven" = 0 ]
