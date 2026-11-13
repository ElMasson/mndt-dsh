#!/usr/bin/env bash
# Check the mounted connectors of a tenant inside its running workbench, the way
# a turn runs them (same row, same proxy, same env file), without any model.
#
#   check-connectors.sh <slug> [--live] [connector...]
#   check-connectors.sh datanalysis
#   check-connectors.sh datanalysis --live office365
#
# For each connector (default: every mounted one): the tools the proxy lets an
# agent see, then one write tool asked for on purpose, which the proxy must
# refuse before it reaches the server. --live adds one real read per connector
# (office365: calendar_upcoming of the owner's mailbox; qonto: get_organization;
# dolibarr: get_status; swing: list_projects) and prints only the size of the
# answer, never its content. No secret is printed: the env file is sourced
# inside the container by the connector's own row.
# Environment: MNDT_ROOT prefixes every absolute path, as in create-tenant.sh;
# MNDT_CHECK_EXEC replaces the `docker compose exec` prefix (tests).
set -euo pipefail

[ $# -ge 1 ] || { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
slug=$1; shift
live=0; names=()
while [ $# -gt 0 ]; do
  case $1 in
    --live) live=1; shift ;;
    *) names+=("$1"); shift ;;
  esac
done
root=${MNDT_ROOT:-}
app="$root/opt/mndt/$slug"; data="$root/data/mndt/$slug/live"
[ -f "$app/docker-compose.yml" ] || { echo "no tenant $slug: run create-tenant.sh first" >&2; exit 1; }
if [ ${#names[@]} -eq 0 ]; then
  for file in "$data"/connectors/*.json; do [ -f "$file" ] && names+=("$(basename "$file" .json)"); done
fi
owner=$(sed -n 's/^ *DSH_MNDT_IDENTITY: *//p' "$app/docker-compose.yml" | head -1)

if [ -n "${MNDT_CHECK_EXEC:-}" ]; then read -ra exec_prefix <<< "$MNDT_CHECK_EXEC"
else exec_prefix=(docker compose -f "$app/docker-compose.yml" exec -T workbench); fi
failed=0
for name in "${names[@]}"; do
  [ -f "$data/connectors/$name.json" ] || { echo "$name: not mounted"; failed=1; continue; }
  # The row the workbench runs, from the tenant's own renderer. The check's actor
  # file stands in for the turn's, so the check never touches a live turn's file.
  script=$(python3 - "$app/gateway/render-connectors.py" "$data/connectors/$name.json" <<'PY'
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('render_connectors', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
data = json.load(open(sys.argv[2], encoding='utf-8'))
env = dict(data.get('env') or {})
if 'MNDT_ACTOR_FILE' in env:
    env['MNDT_ACTOR_FILE'] = '/tmp/mcp-check-actor.json'
data['env'] = env
print(module.script_for(data, data.get('serverName', 'connector')))
PY
)
  options=()
  case $name in
    office365) options+=(--refuse send_mail --actor "$owner" --actor-file /tmp/mcp-check-actor.json); if [ "$live" = 1 ]; then options+=(--call calendar_upcoming); fi ;;
    qonto) options+=(--refuse create_transfer_request); if [ "$live" = 1 ]; then options+=(--call get_organization); fi ;;
    dolibarr) options+=(--refuse dolibarr_raw_api); if [ "$live" = 1 ]; then options+=(--call get_status); fi ;;
    swing) options+=(--refuse create_task); if [ "$live" = 1 ]; then options+=(--call list_projects); fi ;;
    approvals) options+=(--refuse decide_approval) ;;
  esac
  echo "== $name"
  if ! "${exec_prefix[@]}" node /opt/mndt-tools/mcp-check.mjs "${options[@]}" -- sh -lc "$script" | sed 's/^/   /'; then
    failed=1
  fi
done
if [ "$failed" = 0 ]; then echo "all checks passed"; else echo "some checks failed"; exit 1; fi
