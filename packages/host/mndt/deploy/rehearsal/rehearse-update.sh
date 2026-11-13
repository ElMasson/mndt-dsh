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
root=${3:-$(mktemp -d /tmp/mndt-update-XXXX)}
old_ref=${OLD_REF:-96d2801d8a}
project=mndt-rehearsal
owner=duke@datanalysis.re; viewer=smarion@datanalysis.re
app=$root/opt/mndt/datanalysis; data=$root/data/mndt/datanalysis/live
web_patch=$data/home/profiles/web/cordis.patch.yml
mkdir -p "$root/root" "$root/shots" "$root/old"
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
  local shim; shim=$(mktemp -d); cp "$here/compose-shim.sh" "$shim/docker"; chmod +x "$shim/docker"
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
python3 "$deploy/patchfile.py" "$web_patch" --check; echo "check exit $? (1 expected: the 13/11 breakage)"

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
playwright=$(ls -d "$repo"/node_modules/.pnpm/playwright@*/node_modules/playwright 2>/dev/null | sort -V | head -1)
node "$here/drive.mjs" "$playwright/index.mjs" $project "$root/shots"; driven=$?

if [ "${KEEP:-0}" != 1 ]; then
  docker rm -f $project-gateway $project-workbench $project-fakellm >/dev/null 2>&1
fi
echo; echo "rehearsal root: $root"
[ "$seeded" = 0 ] && [ "$rendered" = 0 ] && [ "$checked" = 0 ] && [ "$connectors" = 0 ] && [ "$driven" = 0 ]
