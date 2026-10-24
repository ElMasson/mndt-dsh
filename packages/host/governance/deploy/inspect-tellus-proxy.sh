#!/usr/bin/env bash
# Focused, read-only inspection of the Tellus reverse proxy container: its labels,
# its mounts and its routing file. No application env or data is printed.
set -uo pipefail

C=tellus-ai-docker-proxy-1

echo "=== image et reseaux ==="
docker inspect "$C" --format 'image={{.Config.Image}}'
docker inspect "$C" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'

echo
echo "=== ports publies ==="
docker inspect "$C" --format '{{json .HostConfig.PortBindings}}'

echo
echo "=== volumes montes ==="
docker inspect "$C" --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} ({{.Type}}){{"\n"}}{{end}}'

echo
echo "=== labels (200 premiers caracteres par label) ==="
docker inspect "$C" --format '{{range $k,$v := .Config.Labels}}{{$k}}={{printf "%.200s" $v}}{{"\n"}}{{end}}' | head -15

echo
echo "=== fichiers de configuration du proxy ==="
for src in $(docker inspect "$C" --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}'); do
  if [ -d "$src" ]; then
    find "$src" -maxdepth 2 -type f \( -name '*.conf' -o -name 'Caddyfile' -o -name '*.yml' -o -name '*.yaml' \) 2>/dev/null | head -8
  elif [ -f "$src" ]; then
    echo "fichier: $src"
  fi
done

echo
echo "=== domaine Tellus dans la config nginx (extrait) ==="
conf=$(find /data -maxdepth 5 -type f -name '*.conf' 2>/dev/null | xargs grep -ls 'tellus.duke-analytics.com' 2>/dev/null | head -1)
if [ -n "$conf" ]; then
  echo "fichier: $conf"
  grep -n -A4 -B2 'server_name' "$conf" | head -30
else
  echo "aucun .conf nginx trouve sous /data"
fi
