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
# MNDT_ROOT prefixes every absolute path, as in create-tenant.sh (tests).
root=${MNDT_ROOT:-}
app="$root/opt/mndt/$slug"; data="$root/data/mndt/$slug/live"
[ -f "$app/docker-compose.yml" ] || { echo "no tenant $slug: run create-tenant.sh first" >&2; exit 1; }
compose=(docker compose -f "$app/docker-compose.yml")

# The connector machinery beside the gateway, refreshed from this checkout as
# install-connectors.sh does: a copy installed before the shared guard
# (patchfile.py) would append its block after the `[]` dsh writes, and the
# workbench would no longer start.
mkdir -p "$app/gateway"
cp "$here/../connectors/render-connectors.py" "$here/../connectors/catalog.json" "$here/../patchfile.py" "$app/gateway/"

if [ -z "$ceiling" ]; then
  # The approvals connector, from the versioned catalog, at this tenant's paths:
  # written again on every run, because a descriptor an earlier version wrote
  # lacks what the catalog now requires (the gateway secret since #56, without
  # which every card is refused with 401 after an update). The workbench is
  # restarted only when the descriptor changed.
  descriptor="$data/connectors/approvals.json"
  fingerprint() { if [ -f "$descriptor" ]; then sha256sum < "$descriptor"; else echo absent; fi; }
  before=$(fingerprint)
  MNDT_HOME="$data" MNDT_FRONT="$app" RENDER_SCRIPT="$app/gateway/render-connectors.py" \
    CONNECTOR_CATALOG="$app/gateway/catalog.json" \
    bash "$here/../mount-connector.sh" approvals --preset --no-restart  # its mode is not executable in git
  if [ "$(fingerprint)" != "$before" ]; then
    # A restart, not up -d: the container's configuration did not change, so up -d
    # would leave it running without the connector it must now load.
    "${compose[@]}" restart workbench
  else
    echo "approvals: descriptor up to date"
  fi
fi

# Always wait for the API before the seed, not only after a restart of ours:
# right after `docker compose up -d` (step 13 of the guide) it is not listening
# yet, and the seed failed with ECONNREFUSED. A refused or failed connection is
# retried, and a probe the API accepts without answering gives up after 5 s;
# only the deadline ends the wait, with a message that says where to look.
wait_secs=${MNDT_API_WAIT_SECONDS:-180}
echo "waiting for the workbench API (up to ${wait_secs} s)"
up=0; waited=0
while [ "$waited" -lt "$wait_secs" ]; do
  if "${compose[@]}" exec -T gateway node -e "fetch('http://workbench:8795/health',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" >/dev/null 2>&1; then up=1; break; fi
  sleep 2; waited=$((waited + 2))
done
[ "$up" = 1 ] || { echo "the workbench API did not answer within ${wait_secs} s: docker compose -f $app/docker-compose.yml logs workbench" >&2; exit 1; }
echo "the workbench API answers (after ${waited} s)"

qwen_model=$(grep -E '^VLLM_QWEN_MODEL=' "$data/model.env" 2>/dev/null | cut -d= -f2- || true)
"${compose[@]}" exec -T \
  -e MNDT_API_URL=http://workbench:8795 -e MNDT_OWNER="$owner" -e MNDT_GATEWAY_SECRET_FILE=/run/secrets/mndt-gateway \
  -e AGENTS_JSON="$(cat "$here/agents.json")" -e VLLM_QWEN_MODEL="$qwen_model" -e CEILING="$ceiling" \
  gateway node --input-type=module - < "$here/seed-team.mjs"
