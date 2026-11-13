#!/usr/bin/env bash
# Install and mount the read-only connectors of a tenant rendered by
# create-tenant.sh (agentic Slack, lot 1): approvals, office365, qonto,
# dolibarr, swing. Idempotent: run it again once a missing secret is in place.
#
#   install-connectors.sh <slug> [--dolibarr-src <dir>] [--swing-src <dir>] [--image <image>] [--no-restart] [--no-docker]
#   install-connectors.sh datanalysis
#
# Code, into /data/mndt/<slug>/live/tools (mounted read-only as /opt/mndt-tools):
#   dolibarr-mcp/src   the dolibarr_mcp package (*.py only), copied from
#                      --dolibarr-src (default /opt/src/dolibarr-mcp, holding src/dolibarr_mcp)
#   dolibarr-mcp/site  its dependencies, connectors/runtime/dolibarr.requirements.txt
#   swing/src/mcp      Swing's mcp/__init__.py and mcp/swing_mcp.py, copied from
#                      --swing-src (default /opt/src/swing, a checkout of the Swing repository)
#   swing/site         its dependencies, connectors/runtime/swing.requirements.txt
#   qonto/node_modules mcp-remote, pinned by connectors/runtime/qonto.package-lock.json
# Dependencies are installed in throw-away containers (pip in python:3.11, the
# workbench's Python minor version; npm ci in the workbench image), then
# imported once in the workbench image. A copied source keeps its *.py files
# only: no .env, no cache, no secret travels with it.
#
# Secrets, never read aloud: /data/mndt/<slug>/live/connectors/<name>.env, mode
# 600, written by the operator; the Qonto OAuth cache in
# /data/mndt/<slug>/live/mcp-auth. A connector whose secrets are not all there
# is not mounted, and the line says which names are missing. Only names are
# checked, never values.
#
# Then each ready connector is mounted with mount-connector.sh --preset (the
# versioned catalog, so the allow and deny lists are the catalog's), the
# workbench restarts once, and the agents of tenant/agents.json get the
# connectors they ask for among those now mounted (never one removed).
# --no-restart installs and mounts, and leaves the workbench as it is (the
# stack is not up yet). --no-docker copies and mounts only (tests): no install,
# no restart.
# Environment: MNDT_ROOT prefixes every absolute path, as in create-tenant.sh.
set -euo pipefail

usage() { sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-1}"; }
[ $# -ge 1 ] || usage
case $1 in -h|--help) usage 0 ;; esac
slug=$1; shift
dolibarr_src=/opt/src/dolibarr-mcp; swing_src=/opt/src/swing; image=mndt-workbench:local; docker=1; restart=1
python_image='python:3.11-slim-bookworm@sha256:a83ba18aef0f865b1a4a611c2cf460fe446f2795673bbb9fe43be570439e3b39'
while [ $# -gt 0 ]; do
  case $1 in
    --dolibarr-src) dolibarr_src=$2; shift 2 ;;
    --swing-src) swing_src=$2; shift 2 ;;
    --image) image=$2; shift 2 ;;
    --python-image) python_image=$2; shift 2 ;;
    --no-docker) docker=0; shift ;;
    --no-restart) restart=0; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

root=${MNDT_ROOT:-}
here=$(cd "$(dirname "$0")" && pwd)
deploy=$(cd "$here/.." && pwd)
app="$root/opt/mndt/$slug"; data="$root/data/mndt/$slug/live"
tools="$data/tools"; connectors="$data/connectors"; auth="$data/mcp-auth"
shown="/data/mndt/$slug/live"  # the path the operator knows, without the test root
[ -f "$app/docker-compose.yml" ] || { echo "no tenant $slug: run create-tenant.sh first" >&2; exit 1; }
compose=(docker compose -f "$app/docker-compose.yml")
umask 022

# ---- 1. The connector machinery, refreshed from this checkout.
cp "$deploy/connectors/render-connectors.py" "$deploy/connectors/catalog.json" "$deploy/patchfile.py" "$app/gateway/"
for tool in approvals-mcp.mjs mcp-proxy.mjs office365-mcp.mjs mcp-check.mjs; do
  cp "$deploy/connectors/$tool" "$tools/$tool"
done
mkdir -p "$connectors" "$auth"
chmod 700 "$connectors" "$auth"

# ---- 2. Code: copy the *.py files of one package directory, nothing else.
# $1 source package dir, $2 destination package dir.
copy_package() {
  rm -rf "$2.new"
  mkdir -p "$2.new"
  find "$1" -maxdepth 1 -type f -name '*.py' -exec cp {} "$2.new/" \;
  rm -rf "$2"
  mv "$2.new" "$2"
}
# $1 file list. @returns one digest of their contents, for the line printed.
digest() { cat "$@" | sha256sum | cut -c1-12; }

dolibarr_pkg=''
for candidate in "$dolibarr_src/src/dolibarr_mcp" "$dolibarr_src/dolibarr_mcp" "$dolibarr_src"; do
  if [ -f "$candidate/dolibarr_mcp_server.py" ]; then dolibarr_pkg=$candidate; break; fi
done
mkdir -p "$tools/dolibarr-mcp/src"
if [ -n "$dolibarr_pkg" ]; then
  copy_package "$dolibarr_pkg" "$tools/dolibarr-mcp/src/dolibarr_mcp"
  echo "dolibarr: code copied from $dolibarr_src ($(ls "$tools/dolibarr-mcp/src/dolibarr_mcp" | wc -l) files, sha256 $(digest "$tools"/dolibarr-mcp/src/dolibarr_mcp/*.py))"
elif [ -f "$tools/dolibarr-mcp/src/dolibarr_mcp/dolibarr_mcp_server.py" ]; then
  echo "dolibarr: no source in $dolibarr_src, the installed code is kept"
else
  echo "dolibarr: no source in $dolibarr_src (dolibarr_mcp_server.py not found): copy it first" >&2; exit 1
fi
cp "$deploy/connectors/runtime/dolibarr.requirements.txt" "$tools/dolibarr-mcp/requirements.txt"

mkdir -p "$tools/swing/src"
if [ -f "$swing_src/mcp/swing_mcp.py" ]; then
  rm -rf "$tools/swing/src/mcp.new"
  mkdir -p "$tools/swing/src/mcp.new"
  cp "$swing_src/mcp/swing_mcp.py" "$tools/swing/src/mcp.new/"
  if [ -f "$swing_src/mcp/__init__.py" ]; then cp "$swing_src/mcp/__init__.py" "$tools/swing/src/mcp.new/"; else : > "$tools/swing/src/mcp.new/__init__.py"; fi
  rm -rf "$tools/swing/src/mcp"
  mv "$tools/swing/src/mcp.new" "$tools/swing/src/mcp"
  echo "swing: code copied from $swing_src (sha256 $(digest "$tools/swing/src/mcp/swing_mcp.py"))"
elif [ -f "$tools/swing/src/mcp/swing_mcp.py" ]; then
  echo "swing: no source in $swing_src, the installed code is kept"
else
  echo "swing: no source in $swing_src (mcp/swing_mcp.py not found): copy it first" >&2; exit 1
fi
cp "$deploy/connectors/runtime/swing.requirements.txt" "$tools/swing/requirements.txt"

mkdir -p "$tools/qonto"
cp "$deploy/connectors/runtime/qonto.package.json" "$tools/qonto/package.json"
cp "$deploy/connectors/runtime/qonto.package-lock.json" "$tools/qonto/package-lock.json"

# ---- 3. Dependencies, in throw-away containers; skipped when already in place.
# $1 directory under tools, $2 what was installed from, $3 the command. A stamp
# records what the directory was installed from: same inputs, no reinstall.
install_once() {
  local dir=$1 stamp_value=$2; shift 2
  local stamp="$tools/$dir/.installed"
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$stamp_value" ]; then
    echo "$dir: dependencies already installed"
    return
  fi
  "$@"
  printf '%s' "$stamp_value" > "$stamp"
  echo "$dir: dependencies installed"
}
if [ "$docker" = 1 ]; then
  pip_into() {  # $1 directory under tools
    rm -rf "$tools/$1/site"
    docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$tools/$1:/work" "$python_image" \
      pip install --quiet --no-cache-dir --disable-pip-version-check --root-user-action=ignore \
      --target /work/site -r /work/requirements.txt
  }
  install_once dolibarr-mcp "$python_image $(digest "$tools/dolibarr-mcp/requirements.txt")" pip_into dolibarr-mcp
  install_once swing "$python_image $(digest "$tools/swing/requirements.txt")" pip_into swing
  npm_qonto() {
    rm -rf "$tools/qonto/node_modules"
    docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e NPM_CONFIG_UPDATE_NOTIFIER=false -v "$tools/qonto:/work" -w /work --entrypoint npm "$image" \
      ci --ignore-scripts --no-audit --no-fund --omit=dev --loglevel=error
  }
  install_once qonto "$image $(digest "$tools/qonto/package-lock.json")" npm_qonto
  # One import of each server in the workbench image, as the workbench runs it.
  docker run --rm --entrypoint sh -v "$tools:/opt/mndt-tools:ro" "$image" -c '
    set -e
    imports() {  # $1 connector, $2 module
      cd "/opt/mndt-tools/$1"
      if out=$(PYTHONSAFEPATH=1 PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="/opt/mndt-tools/$1/src:/opt/mndt-tools/$1/site" \
          python3 -c "import $2" 2>&1); then
        echo "$1: imports in the workbench image ($(python3 -V))"
      else
        echo "$1: does NOT import in the workbench image:" >&2; echo "$out" | tail -5 >&2; exit 1
      fi
    }
    imports dolibarr-mcp dolibarr_mcp.dolibarr_mcp_server
    imports swing mcp.swing_mcp
    test -f /opt/mndt-tools/qonto/node_modules/mcp-remote/dist/proxy.js && echo "qonto: mcp-remote $(node -p "require(\"/opt/mndt-tools/qonto/node_modules/mcp-remote/package.json\").version") in place"
  '
else
  echo "dependencies: not installed (--no-docker)"
fi
chmod -R go-w "$tools"

# ---- 4. Which connectors are ready: secrets by name only, never by value.
# $1 env file name, then the names it must define ("A|B" = one of them).
missing_names() {
  local file="$connectors/$1"; shift
  if [ ! -f "$file" ]; then echo "no $(basename "$file") in $shown/connectors"; return; fi
  chmod 600 "$file"
  local absent=() alternatives found name
  for alternatives in "$@"; do
    found=0
    for name in ${alternatives//|/ }; do
      if grep -qE "^(export +)?$name=.+" "$file"; then found=1; fi
    done
    [ "$found" = 1 ] || absent+=("${alternatives//|/ or }")
  done
  [ ${#absent[@]} -eq 0 ] || echo "missing in $(basename "$file"): ${absent[*]}"
}
qonto_url=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["qonto"]["command"][-1])' "$deploy/connectors/catalog.json")
remote_version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["dependencies"]["mcp-remote"])' "$deploy/connectors/runtime/qonto.package.json")
qonto_tokens="mcp-remote-$remote_version/$(printf '%s' "$qonto_url" | md5sum | cut -d' ' -f1)_tokens.json"
if [ -d "$auth/mcp-remote-$remote_version" ]; then
  chmod 700 "$auth/mcp-remote-$remote_version"
  find "$auth/mcp-remote-$remote_version" -type f -exec chmod 600 {} +
fi

ready=(approvals)
report() {  # $1 connector, $2 the reason it waits ('' = ready)
  if [ -z "$2" ]; then ready+=("$1"); echo "$1: ready"; else echo "$1: not mounted, $2"; fi
}
report office365 "$(missing_names office365.env OFFICE365_TENANT_ID OFFICE365_CLIENT_ID 'OFFICE365_CLIENT_SECRET|OFFICE365_CLIENT_SECRET_FILE')"
if [ -f "$auth/$qonto_tokens" ]; then report qonto ''; else report qonto "no OAuth cache $shown/mcp-auth/$qonto_tokens (OAuth on the workstation, then copy)"; fi
report dolibarr "$(missing_names dolibarr.env DOLIBARR_URL DOLIBARR_API_KEY)"
report swing "$(missing_names swing.env SWING_API_URL 'SWING_PASSWORD|SWING_TOKEN')"

# ---- 5. Mount the ready ones from the catalog, restart once, give the agents theirs.
for name in "${ready[@]}"; do
  MNDT_HOME="$data" MNDT_FRONT="$app" RENDER_SCRIPT="$app/gateway/render-connectors.py" \
    CONNECTOR_CATALOG="$app/gateway/catalog.json" \
    bash "$deploy/mount-connector.sh" "$name" --preset --no-restart >/dev/null
done
MNDT_HOME="$data" python3 "$app/gateway/render-connectors.py"
if [ "$docker" = 0 ] || [ "$restart" = 0 ]; then exit 0; fi

"${compose[@]}" restart workbench >/dev/null 2>&1
echo "waiting for the workbench API"
up=0
for _ in $(seq 1 60); do
  if "${compose[@]}" exec -T gateway node -e "fetch('http://workbench:8795/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then up=1; break; fi
  sleep 2
done
[ "$up" = 1 ] || { echo "the workbench API did not answer after its restart: docker compose -f $app/docker-compose.yml logs workbench" >&2; exit 1; }
owner=$(sed -n 's/^ *DSH_MNDT_IDENTITY: *//p' "$app/docker-compose.yml" | head -1)
"${compose[@]}" exec -T \
  -e MNDT_API_URL=http://workbench:8795 -e MNDT_OWNER="$owner" -e AGENTS_JSON="$(cat "$here/agents.json")" \
  gateway node --input-type=module - < "$deploy/connectors/attach-agent-connectors.mjs"
