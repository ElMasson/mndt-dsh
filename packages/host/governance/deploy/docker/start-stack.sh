#!/usr/bin/env bash
# Bring the stack up and report exactly what Docker says, so a failure is never
# silent: compose validation, pull result, container state and logs.
set -uo pipefail

cd /opt/governance || exit 1

echo "=== validation du fichier ==="
docker compose config >/tmp/compose-rendered.yml 2>/tmp/compose-error.txt
echo "config exit=$?"
head -5 /tmp/compose-error.txt 2>/dev/null

echo
echo "=== demarrage ==="
docker compose up -d --remove-orphans > /tmp/compose-up.log 2>&1
echo "up exit=$?"
tail -12 /tmp/compose-up.log

echo
echo "=== etat ==="
docker compose ps -a

echo
echo "=== logs autorite ==="
docker compose logs --tail 12 authority 2>&1 | tail -12

echo
echo "=== logs oauth2proxy ==="
docker compose logs --tail 12 oauth2proxy 2>&1 | tail -12
