#!/usr/bin/env bash
# Seed a tenant rendered by create-tenant.sh, once its stack runs: mount the
# approvals connector and declare the agents of tenant/agents.json. No
# business data. Idempotent.
#
#   seed-team.sh <slug> --owner <email>
#   seed-team.sh <slug> --owner <email> --ceiling <handle> <euros>
#
# --ceiling sets one agent's monthly ceiling, as the owner (acceptance step
# R-12: a tiny ceiling after one turn makes the next mention refused; set it
# back to 5 afterwards). It changes a value, never the ceiling check.
set -euo pipefail

[ $# -ge 3 ] || { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
slug=$1; shift
owner=''; ceiling=''
while [ $# -gt 0 ]; do
  case $1 in
    --owner) owner=$2; shift 2 ;;
    --ceiling) ceiling="$2=$3"; shift 3 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done
[[ $owner =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]] || { echo "--owner <email> is required" >&2; exit 1; }

here=$(cd "$(dirname "$0")" && pwd)
app="/opt/mndt/$slug"; data="/data/mndt/$slug/live"
[ -f "$app/docker-compose.yml" ] || { echo "no tenant $slug: run create-tenant.sh first" >&2; exit 1; }
compose=(docker compose -f "$app/docker-compose.yml")

if [ -z "$ceiling" ] && [ ! -f "$data/connectors/approvals.json" ]; then
  # The approvals connector, from the versioned catalog, at this tenant's paths.
  MNDT_HOME="$data" MNDT_FRONT="$app" RENDER_SCRIPT="$app/gateway/render-connectors.py" \
    CONNECTOR_CATALOG="$app/gateway/catalog.json" \
    "$here/../mount-connector.sh" approvals --preset --no-restart
  "${compose[@]}" up -d workbench
  echo "waiting for the workbench API"
  for _ in $(seq 1 60); do
    "${compose[@]}" exec -T gateway node -e "fetch('http://workbench:8795/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" && break
    sleep 2
  done
fi

qwen_model=$(grep -E '^VLLM_QWEN_MODEL=' "$data/model.env" 2>/dev/null | cut -d= -f2- || true)
"${compose[@]}" exec -T \
  -e MNDT_API_URL=http://workbench:8795 -e MNDT_OWNER="$owner" \
  -e AGENTS_JSON="$(cat "$here/agents.json")" -e VLLM_QWEN_MODEL="$qwen_model" -e CEILING="$ceiling" \
  gateway node --input-type=module - < "$here/seed-team.mjs"
