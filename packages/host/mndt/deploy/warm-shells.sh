#!/bin/sh
# Create the shells before a person opens the page.
#
# A recreation of the workbench deletes every shell. The first visitor then pays
# their creation: measured on 1 November 2026, 91 seconds before DOM ready and no
# collaboration space after four minutes. A warm request through the gateway
# creates the shell, so the first real visit behaves like a reload: about 2
# seconds of DOM and 8 seconds to the collaboration space.
#
# Usage: bash warm-shells.sh [email...]
# Default identity: duke@datanalysis.re. Override with WARM_IDENTITIES.
set -eu

GATEWAY=${GATEWAY_CONTAINER:-mndt-front-gateway-1}
HOST_HEADER=${MNDT_HOST:-mndt.duke-analytics.com}
IDENTITIES=${*:-${WARM_IDENTITIES:-duke@datanalysis.re}}

IP=$(docker inspect "$GATEWAY" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
if [ -z "$IP" ]; then
  echo "passerelle introuvable: $GATEWAY" >&2
  exit 2
fi

for EMAIL in $IDENTITIES; do
  START=$(date +%s)
  CODE=000
  for ATTEMPT in 1 2 3 4; do
    CODE=$(curl -s -o /dev/null -m 240 -w '%{http_code}' \
      -H "Host: $HOST_HEADER" \
      -H "x-forwarded-email: $EMAIL" \
      "http://$IP:8080/" || true)
    case "$CODE" in
      2*|3*) break ;;
      *) sleep 10 ;;
    esac
  done
  END=$(date +%s)
  echo "prechauffage $EMAIL: $CODE en $((END - START)) s"
done
