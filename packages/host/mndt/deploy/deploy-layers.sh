#!/bin/sh
# Deploy the page layer without building or committing an image.
#
# The workbench and the shells mount /data/mndt/live/layers/<name> over their lib
# directories. This script replaces the contents of those mounts and recreates the
# long-lived containers, so no Docker layer is written.
#
# Usage: bash deploy-layers.sh /root/layer.tar
set -eu

ARCHIVE=${1:-/root/layer.tar}
LAYERS=${LAYERS:-/data/mndt/live/layers}
COMPOSE_DIR=${COMPOSE_DIR:-/opt/mndt-front}

if [ ! -f "$ARCHIVE" ]; then
  echo "archive introuvable: $ARCHIVE" >&2
  exit 2
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
tar xf "$ARCHIVE" -C "$WORK"

for NAME in ui-mndt host-mndt; do
  if [ ! -d "$WORK/$NAME" ]; then
    echo "dossier absent de l archive: $NAME" >&2
    exit 2
  fi
  mkdir -p "$LAYERS/$NAME"
  # The directory itself is the mount point, so only its contents move.
  find "$LAYERS/$NAME" -mindepth 1 -delete
  cp -a "$WORK/$NAME/." "$LAYERS/$NAME/"
  echo "couche remplacee: $LAYERS/$NAME"
done

cd "$COMPOSE_DIR"
docker compose up -d --force-recreate workbench
for ID in $(docker ps -aq --filter 'name=shell-'); do
  docker rm -f "$ID" >/dev/null 2>&1 || true
done

sleep 8
curl -s -m 5 "http://127.0.0.1:${MNDT_WORKBENCH_PORT:-8795}/health" || true
echo ""
if [ -x /root/warm-shells.sh ]; then
  sh /root/warm-shells.sh || echo "prechauffage ignore"
fi
echo "deploiement termine, shells supprimes, ils se recreent a la premiere visite"
