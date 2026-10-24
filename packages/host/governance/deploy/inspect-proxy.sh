#!/usr/bin/env bash
# Read-only inspection of the host's reverse proxy, so a governance route can be
# added without touching the Tellus routing.
set -uo pipefail

echo "=== conteneurs (nom | image | ports) ==="
docker ps --format '{{.Names}} | {{.Image}} | {{.Ports}}' | head -15

echo
echo "=== qui ecoute 80 et 443 ==="
for port in 80 443; do
  ids=$(docker ps -q --filter "publish=${port}")
  for id in $ids; do
    docker inspect "$id" --format '{{.Name}} image={{.Config.Image}} labels={{json .Config.Labels}}' | head -c 600
    echo
  done
done

echo
echo "=== fichiers compose sous /data ==="
find /data -maxdepth 4 -name 'docker-compose*.y*ml' -o -maxdepth 4 -name 'compose*.y*ml' 2>/dev/null | head -10

echo
echo "=== references au domaine Tellus ==="
grep -Rsl 'tellus.duke-analytics.com' /data/app 2>/dev/null | head -5
grep -Rsh 'tellus.duke-analytics.com' /data/app 2>/dev/null | head -6

echo
echo "=== traefik ou caddy ? ==="
docker ps --format '{{.Names}}' | grep -Ei 'traefik|caddy|nginx|proxy' || echo "aucun conteneur nomme proxy"
