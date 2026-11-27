#!/usr/bin/env bash
# Mount one MCP connector on the running workbench.
#
#   mount-connector.sh <serverName> <command...> [--env-file <file>] [--cwd <dir>]
#                      [--allow <p1,p2>] [--deny <p1,p2>] [--no-restart]
#   mount-connector.sh <serverName> --preset [--no-restart]
#
# The descriptor lands in /data/mndt/live/connectors/<serverName>.json, the
# composition block is regenerated from every descriptor, and the workbench
# restarts. Secrets belong in the env file named here, which stays protected and
# is read by the generated shell wrapper, never written into the composition.
#
# --allow wraps the server in the read-only proxy (mcp-proxy.mjs): only the
# listed tools are visible and callable; --deny removes tools the allow list
# would otherwise let through. --preset takes command, env file, non-secret
# settings and both lists from the versioned catalog (connectors/catalog.json):
# approvals, office365, qonto, dolibarr, swing, machine.
set -euo pipefail

LIVE=${MNDT_HOME:-/data/mndt/live}
CONNECTORS="$LIVE/connectors"
FRONT=${MNDT_FRONT:-/opt/mndt-front}
# The renderer of this checkout when there is one: an installed copy may predate
# the shared guard (patchfile.py) and append its block after the `[]` dsh writes.
checkout_render="$(cd "$(dirname "$0")" && pwd)/connectors/render-connectors.py"
if [ -z "${RENDER_SCRIPT:-}" ] && [ -f "$checkout_render" ]; then RENDER_SCRIPT=$checkout_render; fi
RENDER="${RENDER_SCRIPT:-/opt/mndt-front/gateway/render-connectors.py}"
CATALOG="${CONNECTOR_CATALOG:-$(dirname "$RENDER")/catalog.json}"
# The renderer writes the composition through the shared guard (patchfile.py).
# A tenant rendered before the guard existed has no copy beside its renderer:
# the one of this checkout serves then.
if [ -z "${MNDT_PATCHFILE:-}" ] && [ ! -f "$(dirname "$RENDER")/patchfile.py" ] && [ -f "$(dirname "$0")/patchfile.py" ]; then
  export MNDT_PATCHFILE="$(cd "$(dirname "$0")" && pwd)/patchfile.py"
fi

usage() { echo "usage: $0 <serverName> (<command...> | --preset) [--env-file <f>] [--cwd <d>] [--allow <p,..>] [--deny <p,..>] [--no-restart] [--no-render]" >&2; exit 1; }
[ $# -ge 2 ] || usage

server=$1
shift
command=()
env_file=""
cwd=""
allow=""
deny=""
preset=0
restart=1
render=1
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) env_file=$2; shift 2 ;;
    --cwd) cwd=$2; shift 2 ;;
    --allow) allow=$2; shift 2 ;;
    --deny) deny=$2; shift 2 ;;
    --preset) preset=1; shift ;;
    --no-restart) restart=0; shift ;;
    # The descriptor only: a caller that rewrites several (seed-team.sh) renders once, after the last.
    --no-render) render=0; restart=0; shift ;;
    *) command+=("$1"); shift ;;
  esac
done
if [ "$preset" = 0 ] && [ ${#command[@]} -eq 0 ]; then usage; fi

mkdir -p "$CONNECTORS"
python3 - "$CONNECTORS/$server.json" "$server" "$preset" "$CATALOG" "$env_file" "$cwd" "$allow" "$deny" "${command[@]}" <<'PY'
import json
import sys

path, server, preset, catalog, env_file, cwd, allow, deny = sys.argv[1:9]
command = sys.argv[9:]


def split(value):
    return [item.strip() for item in value.split(',') if item.strip()]


if preset == '1':
    entries = json.load(open(catalog, encoding='utf-8'))
    if server not in entries or server.startswith('_'):
        sys.exit(f'aucun preset {server} dans {catalog}')
    data = {'serverName': server, **entries[server]}
else:
    data = {'serverName': server, 'command': command}
    if env_file:
        data['envFile'] = env_file
    if cwd:
        data['cwd'] = cwd
    if allow:
        data['allow'] = split(allow)
    if deny:
        data['deny'] = split(deny)
import os
import shutil
import tempfile
text = json.dumps(data, indent=2) + '\n'
previous = open(path, encoding='utf-8').read() if os.path.exists(path) else None
if previous is not None and previous != text:
    # A descriptor that differs (an earlier version's, or edited by hand) is kept
    # beside the new one and named, never replaced in silence.
    kept = f'{path}.avant-{os.getpid()}'
    shutil.copy2(path, kept)
    print('descripteur different remplace, ancien garde dans:', kept)
# Written whole or not at all: a temporary file in the same folder, then renamed.
fd, temporary = tempfile.mkstemp(dir=os.path.dirname(path), prefix=f'.{os.path.basename(path)}.')
try:
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        handle.write(text)
    os.chmod(temporary, 0o644)
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
print('descripteur ecrit:', path)
PY

env_named=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("envFile",""))' "$CONNECTORS/$server.json")
if [ -n "$env_named" ] && [ -f "$CONNECTORS/$(basename "$env_named")" ]; then
  chmod 600 "$CONNECTORS/$(basename "$env_named")"
fi

[ "$render" = 1 ] || exit 0
# A render refused (a patch that does not parse) stops here, said: the workbench
# is never restarted on a patch that does not carry the connector.
python3 "$RENDER" || { echo "rendu refuse: le patch n'a pas ete modifie, le workbench n'est pas redemarre; reparer le patch puis relancer" >&2; exit 1; }
if [ "$restart" = 1 ]; then
  cd "$FRONT"
  docker compose restart workbench
  sleep 40
  docker compose ps workbench
fi
