#!/usr/bin/env bash
# Mount one MCP connector on the running workbench.
#
#   mount-connector.sh <serverName> <command...> [--env-file <file>] [--cwd <dir>]
#
# The descriptor lands in /data/mndt/live/connectors/<serverName>.json, the
# composition block is regenerated from every descriptor, and the workbench
# restarts. Secrets belong in the env file named here, which stays protected and
# is read by the generated shell wrapper, never written into the composition.
set -euo pipefail

LIVE=${MNDT_HOME:-/data/mndt/live}
CONNECTORS="$LIVE/connectors"
FRONT=/opt/mndt-front
RENDER="${RENDER_SCRIPT:-/opt/mndt-front/gateway/render-connectors.py}"

[ $# -ge 2 ] || { echo "usage: $0 <serverName> <command...> [--env-file <file>] [--cwd <dir>]" >&2; exit 1; }

server=$1
shift
command=()
env_file=""
cwd=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) env_file=$2; shift 2 ;;
    --cwd) cwd=$2; shift 2 ;;
    *) command+=("$1"); shift ;;
  esac
done

mkdir -p "$CONNECTORS"
python3 - "$CONNECTORS/$server.json" "$server" "$env_file" "$cwd" "${command[@]}" <<'PY'
import json
import sys

path, server, env_file, cwd = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
command = sys.argv[5:]
data = {'serverName': server, 'command': command}
if env_file:
    data['envFile'] = env_file
if cwd:
    data['cwd'] = cwd
with open(path, 'w', encoding='utf-8') as handle:
    json.dump(data, handle, indent=2)
    handle.write('\n')
print('descripteur ecrit:', path)
PY

if [ -f "$env_file" ]; then
  chmod 600 "$CONNECTORS/$(basename "$env_file")"
fi

python3 "$RENDER"
cd "$FRONT"
docker compose restart workbench
sleep 40
docker compose ps workbench
