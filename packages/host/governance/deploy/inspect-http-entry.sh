#!/usr/bin/env bash
# Find the container that publishes HTTP(S) and read its routing configuration.
set -uo pipefail

echo "=== conteneurs et ports publies ==="
docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}'

echo
echo "=== conteneur qui publie 80 ou 443 ==="
for id in $(docker ps -q); do
  binds=$(docker inspect "$id" --format '{{json .HostConfig.PortBindings}}')
  case "$binds" in
    *'"80/tcp"'*|*'"443/tcp"'*)
      docker inspect "$id" --format 'NOM={{.Name}} IMAGE={{.Config.Image}}'
      docker inspect "$id" --format 'CMD={{json .Config.Cmd}} ENTRYPOINT={{json .Config.Entrypoint}}'
      docker inspect "$id" --format 'MOUNTS={{range .Mounts}}{{.Source}}->{{.Destination}};{{end}}'
      docker inspect "$id" --format 'NETS={{range $k,$v := .NetworkSettings.Networks}}{{$k}};{{end}}'
      ;;
  esac
done

echo
echo "=== fichiers de routing visibles sous /data/app ==="
find /data/app -maxdepth 3 -type f \( -name 'traefik*.yml' -o -name 'traefik*.yaml' -o -name 'Caddyfile' -o -name '*.conf' -o -name 'docker-compose.prod.yml' \) 2>/dev/null | head -12
