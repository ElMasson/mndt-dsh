#!/usr/bin/env bash
# Mount the small facts MCP connector on the running workbench.
#
# It exists to prove the connector path end to end: a mission reaches a real MCP
# tool through a mounted server and the brief quotes its answer. The external
# connectors (Attio, Qonto, ...) take the same shape with their own command, args
# and environment; they only need their credentials.
set -euo pipefail

LIVE=/data/mndt/live
TOOLS="$LIVE/tools"
PATCH="$LIVE/home/profiles/web/cordis.patch.yml"
SRC=${1:-/root/mndt-tools.tar.gz}

mkdir -p "$TOOLS"
if [ -f "$SRC" ]; then
  tar -xzf "$SRC" -C "$TOOLS"
fi
[ -f "$TOOLS/facts-mcp.mjs" ] || { echo "missing $TOOLS/facts-mcp.mjs" >&2; exit 1; }

python3 - "$PATCH" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding='utf-8').read()
marker = '- id: mcp-workbench-facts'
if marker in text:
    text = text[:text.index(marker)].rstrip() + '\n'
if 'insert:' not in text:
    # A bare entry with an unknown id is skipped by the patch layer: adding a
    # plugin requires an insert list.
    text += """- insert:
    - id: mcp-workbench-facts
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: workbench_facts
        transport: stdio
        command: node
        args:
          - /opt/mndt-tools/facts-mcp.mjs
"""
open(path, 'w', encoding='utf-8').write(text)
PY

echo "patch ready:"
tail -12 "$PATCH"
echo "restart the workbench container to mount the connector"
