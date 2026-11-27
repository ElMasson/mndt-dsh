#!/usr/bin/env bash
# Build the two images of a team space's computers, from this checkout:
#   mndt-pc        one member's computer (sandbox/Dockerfile.pc), run under gVisor;
#   mndt-machines  the machine service that starts them (sandbox/Dockerfile.machines).
#
#   build-machines.sh [--tag <tag>]
#
# Each is tagged <tag> (default: local, the names create-tenant.sh renders) and
# with the checkout's short commit, so the previous one can be put back by name.
# Both bases are pinned by digest, the computer's packages by a snapshot of
# Debian's archive: a rebuild installs the same things. Nothing is pushed.
set -euo pipefail
tag=local
while [ $# -gt 0 ]; do
  case $1 in
    --tag) tag=$2; shift 2 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done
[[ $tag =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || { echo "not a Docker tag: $tag" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
commit=$(git -C "$here" rev-parse --short HEAD 2>/dev/null || echo unknown)
for image in pc machines; do
  echo "== mndt-$image:$tag (commit $commit)"
  docker build -f "$here/sandbox/Dockerfile.$image" -t "mndt-$image:$tag" -t "mndt-$image:$commit" \
    --label "mndt.commit=$commit" "$here/sandbox"
done
echo "built: mndt-pc:$tag mndt-machines:$tag (also tagged $commit)"
for image in pc machines; do
  docker image inspect -f "mndt-$image:$tag {{.Size}}" "mndt-$image:$tag" | awk '{ printf "  %s: %.0f MB\n", $1, $2 / 1000000 }'
done
