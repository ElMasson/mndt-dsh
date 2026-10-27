#!/usr/bin/env bash
# Keep only the workbench image that is actually running.
#
#   prune-workbench.sh [--cache]
#
# The server is shared with Tellus, PostgreSQL lives on the same /data volume,
# and a build needs about 2 Go. A previous image is therefore deleted before the
# next one is built, and this script is the one place that decides which image is
# allowed to stay.
#
# It never touches another repository: only tags of `mndt-workbench` are removed,
# and never the image the running container was created from. `--cache` also
# drops build cache older than a day, which is where the 18 Go went last time.
set -euo pipefail

CONTAINER=${CONTAINER:-mndt-front-workbench-1}
REPOSITORY=${REPOSITORY:-mndt-workbench}

running=$(docker inspect "$CONTAINER" --format '{{.Image}}' 2>/dev/null || true)
if [ -z "$running" ]; then
  echo "conteneur $CONTAINER introuvable: rien n a ete supprime" >&2
  exit 1
fi
echo "image en service: $running"

for tag in $(docker images "$REPOSITORY" --format '{{.Tag}}'); do
  id=$(docker inspect "$REPOSITORY:$tag" --format '{{.Id}}' 2>/dev/null || true)
  if [ "$id" = "$running" ]; then
    echo "garde  $REPOSITORY:$tag"
    continue
  fi
  echo "supprime $REPOSITORY:$tag"
  docker rmi "$REPOSITORY:$tag" >/dev/null
done

if [ "${1:-}" = "--cache" ]; then
  echo "cache de build de plus de 24 h:"
  docker builder prune -f --filter until=24h | tail -1
fi

echo "espace restant:"
df -h /data | tail -1
