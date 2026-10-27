#!/usr/bin/env bash
# One shell per person: a DSH web instance with its own home, sessions and token.
#
#   sandbox-shell.sh <identity> [--replace]
#
# The instance runs the same image as the shared workbench, but mounts its own
# /state volume, seeded once from the shared web profile. No product API port is
# given to it: the page talks to the central API through the gateway, so a person
# cannot read another person's sessions or files.
set -euo pipefail

identity=${1:?identite requise}
replace=${2:-}
image=${SHELL_IMAGE:-mndt-workbench:local}
roots=${SHELL_ROOTS:-/data/mndt/shells}
seed=${SHELL_SEED:-/data/mndt/live/home/profiles/web}
slug=$(printf '%s' "$identity" | tr '@.' '--' | tr 'A-Z' 'a-z')
name="shell-$slug"
home="$roots/$slug"

if [ "$replace" = "--replace" ]; then
  docker rm -f "$name" >/dev/null 2>&1 || true
fi

if docker inspect "$name" >/dev/null 2>&1; then
  echo "instance deja en place: $name"
else
  mkdir -p "$home/home/profiles/web"
  if [ ! -f "$home/home/profiles/web/cordis.patch.yml" ]; then
    cp -r "$seed/." "$home/home/profiles/web/"
    echo "profil web copie pour $identity"
  fi
  docker run -d --name "$name" \
    --network mndt-front_front \
    --restart unless-stopped \
    --read-only \
    --tmpfs /tmp:rw,size=128m \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --memory 768m \
    --cpus 1 \
    -e DSH_HOME=/state/home \
    -e DSH_MNDT_IDENTITY="$identity" \
    -e DSH_MNDT_WEB_TOKEN_FILE=/state/web-token \
    -e PUBLIC_URL=https://mndt.duke-analytics.com/ \
    -e TRUSTED_HOST=mndt.duke-analytics.com \
    -v "$home:/state" \
    --entrypoint sh \
    "$image" /app/workbench-entrypoint.sh >/dev/null
  echo "instance creee: $name"
fi

for _ in $(seq 1 60); do
  if docker exec "$name" test -s /state/web-token 2>/dev/null; then
    echo "jeton pret: $name"
    break
  fi
  sleep 2
done

docker ps --filter "name=^${name}$" --format '{{.Names}} {{.Status}}'
