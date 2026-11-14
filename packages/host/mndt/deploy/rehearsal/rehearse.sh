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
    docker rm -f $project-gateway $project-workbench $project-fakellm >/dev/null 2>&1
    docker network rm ${project}_front >/dev/null 2>&1
  fi
  echo "rehearsal root: $root"
}
trap cleanup EXIT
owner=duke@datanalysis.re; viewer=smarion@datanalysis.re
app=$root/opt/mndt/datanalysis; data=$root/data/mndt/datanalysis/live
mkdir -p "$root/root" "$root/shots"
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
workbench_log() { echo "--- last lines of home/web.log"; tail -15 "$data/home/web.log" 2>/dev/null; }

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
ENV
MNDT_HOME=$data python3 "$deploy/llm/render-llm-routes.py" --env-file "$data/model.env" || exit 1
printf '{ "grants": [ { "subject": "%s", "role": "owner" }, { "subject": "%s", "role": "viewer" } ] }\n' $owner $viewer > "$data/grants.json"
sed -e "s#/data/mndt/datanalysis/live#$data#g" -e "s#/opt/mndt/datanalysis#$app#g" \
    -e "s#image: mndt-workbench:local#image: $image#" \
    -e "s#PUBLIC_URL: https://equipe.datanalysis.re/#PUBLIC_URL: http://127.0.0.1:18080/#" \
    -e "s#TRUSTED_HOST: equipe.datanalysis.re#TRUSTED_HOST: 127.0.0.1:18080#" \
    "$app/docker-compose.yml" > "$root/compose.yml"
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

step "2. first start"
node "$here/up-run.mjs" "$root/compose.yml" "$root/compose.override.yml" $project || exit 1
if health 80; then echo "API answers through the gateway"; else echo "KO: the API does not answer after the first start"; workbench_log; fi
echo "--- profiles/web/cordis.patch.yml as DSH wrote it:"; cat "$data/home/profiles/web/cordis.patch.yml" 2>/dev/null || echo "(absent)"

step "3. seed-team.sh, the production script (Compose calls through compose-shim.sh)"
# The workbench writes its profile files as root; on the server seed-team.sh runs
# as root too. Here it runs as this user, so hand the profile files over first.
docker exec -u 0 $project-workbench chown -R "$(id -u):$(id -g)" /state/home/profiles || exit 1
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

step "5. the page, the turn, the resets"
if page_ready 150; then echo "the page is ready (launch token published)"; else echo "KO: the gateway opens no session after 450 s (no launch token)"; docker logs --tail 5 $project-workbench 2>&1; fi
playwright=$(ls -d "$repo"/node_modules/.pnpm/playwright@*/node_modules/playwright 2>/dev/null | sort -V | head -1)
if [ -z "$playwright" ]; then echo "KO: Playwright is not installed in $repo/node_modules (pnpm install)" >&2; exit 1; fi
node "$here/drive.mjs" "$playwright/index.mjs" $project "$root/shots"; driven=$?

[ "$seeded" = 0 ] && [ "$checked" = 0 ] && [ "$connectors" = 0 ] && [ "$driven" = 0 ]
