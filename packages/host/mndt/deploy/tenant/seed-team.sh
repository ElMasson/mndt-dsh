#!/usr/bin/env bash
# Seed a tenant rendered by create-tenant.sh, once its stack runs: mount the
# approvals and machine connectors and declare the agents of tenant/agents.json. No
# business data. Idempotent.
#
#   seed-team.sh <slug> --owner <email>
#   seed-team.sh <slug> --owner <email> --ceiling <handle> <euros>
#   seed-team.sh <slug> --owner <email> --replace-operator-settings
#
# The connectors' descriptors are rewritten from this version's catalog; one
# that carries a setting the catalog does not (an env key, an env file, added
# by hand) is refused, unless --replace-operator-settings says to drop it.
#
# --ceiling sets one agent's monthly ceiling, as the owner (acceptance step
# R-12: a tiny ceiling after one turn makes the next mention refused; set it
# back to 5 afterwards). It changes a value, never the ceiling check.
set -euo pipefail

[ $# -ge 3 ] || { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
slug=$1; shift
owner=''; ceiling=''; replace_operator=0
while [ $# -gt 0 ]; do
  case $1 in
    --owner) owner=$2; shift 2 ;;
    --replace-operator-settings) replace_operator=1; shift ;;
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
# Replaced atomically (shared/install-file.sh), as create-tenant.sh does.
f="$here/../shared/install-file.sh"; [ -f "$f" ] || { echo "missing $f" >&2; exit 1; }
. "$f"
for file in connectors/render-connectors.py connectors/catalog.json patchfile.py; do
  install_file "$here/../$file" "$app/gateway/$(basename "$file")" || exit 1
done

if [ -z "$ceiling" ]; then
  # The connectors, from the versioned catalog, at this tenant's paths: written
  # again on every run, because a descriptor an earlier version wrote lacks what
  # the catalog now requires (the gateway secret since #56, without which every
  # card is refused with 401 after an update; the absolute commands and the
  # actor's folder since the eighth jump). The workbench is restarted only when
  # a descriptor or the block changed.
  rendered="$data/home/profiles/web/cordis.patch.yml"
  # The descriptors AND the patch they render: a first run that rewrote a
  # descriptor but whose render failed (an unreadable patch, as on 13/11) is
  # rerun once the patch is fixed; the render then changes the patch, and the
  # workbench is restarted even though the descriptors are unchanged.
  # Every connector of the catalog that is mounted, and the two every tenant has
  # (approvals, machine): each descriptor rewritten from this version's catalog
  # first, then the block rendered once. A descriptor an earlier version wrote
  # (another command, another actor path) would make this version's renderer
  # refuse the whole block, so none is left behind before the render.
  catalog_names=$(python3 -c 'import json, sys; print(" ".join(k for k in json.load(open(sys.argv[1])) if not k.startswith("_")))' "$app/gateway/catalog.json")
  connectors=(approvals machine)
  for name in $catalog_names; do
    case " ${connectors[*]} " in *" $name "*) continue ;; esac
    [ -f "$data/connectors/$name.json" ] && connectors+=("$name")
  done
  # A setting added by hand (an env key, an env file the catalog does not name)
  # would vanish in the rewrite, in silence: refused, unless said.
  if [ "$replace_operator" = 0 ]; then
    lost=$(python3 - "$app/gateway/catalog.json" "$data/connectors" "${connectors[@]}" <<'PY'
import json, os, sys
catalog = json.load(open(sys.argv[1]))
for name in sys.argv[3:]:
    path = os.path.join(sys.argv[2], name + '.json')
    if not os.path.isfile(path): continue
    old, preset = json.load(open(path)), catalog.get(name) or {}
    extra = sorted(set((old.get('env') or {})) - set((preset.get('env') or {})))
    env_file = old.get('envFile')
    if env_file and env_file != preset.get('envFile'): extra.append('envFile ' + env_file)
    if extra: print(name + ': ' + ', '.join(extra))
PY
)
    if [ -n "$lost" ]; then
      echo "refused: rewriting these descriptors from the catalog would drop what was set by hand:" >&2
      printf '  %s\n' "$lost" >&2
      echo "nothing was rewritten; keep them in the catalog, or rerun with --replace-operator-settings" >&2
      exit 1
    fi
  fi
  fingerprint() {
    local file
    for file in "$rendered" "${connectors[@]}"; do
      [ "$file" = "$rendered" ] || file="$data/connectors/$file.json"
      if [ -f "$file" ]; then sha256sum < "$file"; else echo absent; fi
    done
  }
  before=$(fingerprint)
  for connector in "${connectors[@]}"; do
    descriptor_before=$( [ -f "$data/connectors/$connector.json" ] && sha256sum < "$data/connectors/$connector.json" || echo absent)
    MNDT_HOME="$data" MNDT_FRONT="$app" RENDER_SCRIPT="$app/gateway/render-connectors.py" \
      CONNECTOR_CATALOG="$app/gateway/catalog.json" \
      bash "$here/../mount-connector.sh" "$connector" --preset --no-render  # its mode is not executable in git
    descriptor_after=$(sha256sum < "$data/connectors/$connector.json")
    [ "$descriptor_after" = "$descriptor_before" ] && echo "$connector: descriptor up to date"
  done
  # One render for them all, through the tenant's own renderer (a refusal stops here, said).
  MNDT_HOME="$data" CONNECTOR_CATALOG="$app/gateway/catalog.json" python3 "$app/gateway/render-connectors.py" \
    || { echo "rendu refuse: le patch n'a pas ete modifie, le workbench n'est pas redemarre; reparer le patch puis relancer" >&2; exit 1; }
  if [ "$(fingerprint)" != "$before" ]; then
    # A restart, not up -d: the container's configuration did not change, so up -d
    # would leave it running without the connector it must now load.
    "${compose[@]}" restart workbench
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
