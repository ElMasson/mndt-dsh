#!/usr/bin/env bash
# A `docker` for the rehearsal, put first on PATH while seed-team.sh runs: it
# turns the two Compose calls seed-team.sh makes into plain docker calls on the
# rehearsal's containers (<project>-<service>), and passes everything else to
# the real docker. Needed where the Compose plugin is not installed; the script
# under test stays the production one.
#   docker compose -f <file> restart <service>
#   docker compose -f <file> exec -T [-e K=V]... <service> <command...>
set -euo pipefail
real=${REHEARSAL_DOCKER:-/usr/bin/docker}
project=${REHEARSAL_PROJECT:?REHEARSAL_PROJECT names the rehearsal containers}
if [ "${1:-}" != compose ]; then exec "$real" "$@"; fi
shift
while [ $# -gt 0 ]; do
  case $1 in
    -f|-p) shift 2 ;;
    restart) exec "$real" restart "$project-$2" ;;
    exec)
      shift
      envs=()
      while [ $# -gt 0 ]; do
        case $1 in
          -T) shift ;;
          -e) envs+=(-e "$2"); shift 2 ;;
          *) break ;;
        esac
      done
      service=$1; shift
      exec "$real" exec -i "${envs[@]}" "$project-$service" "$@" ;;
    *) echo "compose-shim: unsupported compose call: $*" >&2; exit 2 ;;
  esac
done
