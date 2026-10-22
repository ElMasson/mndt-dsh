#!/usr/bin/env bash
# Diagnose the two remaining failures: why oauth2-proxy cannot read its config,
# and why Traefik does not register the router.
set -uo pipefail

echo "=== logs du conteneur courant (2 minutes) ==="
docker logs governance-oauth2proxy-1 --since 2m 2>&1 | tail -12

echo
echo "=== montages reellement appliques ==="
docker inspect governance-oauth2proxy-1 --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} ro={{.RW}}{{println}}{{end}}' 2>&1 | head -6
docker inspect governance-oauth2proxy-1 --format 'User={{.Config.User}}' 2>&1

echo
echo "=== contenu vu depuis le conteneur (si joignable) ==="
docker run --rm -v /etc/oauth2-proxy:/etc/oauth2-proxy:ro --user 65532:65532 alpine:3 sh -c 'ls -l /etc/oauth2-proxy 2>&1; head -2 /etc/oauth2-proxy/governance.cfg 2>&1' 2>&1 | head -8

echo
echo "=== labels du conteneur ==="
docker inspect governance-oauth2proxy-1 --format '{{json .Config.Labels}}' 2>&1 | head -c 900

echo
echo "=== reseaux du conteneur ==="
docker inspect governance-oauth2proxy-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}};{{end}}' 2>&1

echo
echo "=== traefik voit-il nos conteneurs ? ==="
docker logs tellus-ai-traefik-1 --since 5m 2>&1 | grep -iE 'governance|error' | tail -8
