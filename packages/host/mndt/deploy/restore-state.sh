#!/bin/sh
# Validate a backup, then restore it into the live workbench when asked.
# Without --apply nothing is written: the command only reports what the backup
# contains, which is the tested path used before an incident.
set -eu

file=${1:?usage: restore-state.sh <backup.json> [--apply]}
apply=no
[ "${2:-}" = "--apply" ] && apply=yes

python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$file"
python3 - "$file" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
print(
    'sauvegarde valide :',
    len(state.get('missions', [])), 'missions,',
    len(state.get('briefs', [])), 'briefs,',
    len(state.get('approvals', [])), 'approbations,',
    len(state.get('mandates', [])), 'mandats,',
    len(state.get('events', [])), 'evenements',
)
PY

if [ "$apply" != yes ]; then
  echo "aucune ecriture. Relancer avec --apply pour restaurer."
  exit 0
fi

live=/data/mndt/live/state.json
if [ -f "$live" ]; then
  cp "$live" "/data/mndt/live/state.pre-restore-$(date -u +%Y%m%dT%H%M%SZ).json"
fi
cp "$file" "$live.part"
mv "$live.part" "$live"
echo "restaure dans $live"
echo "redemarrer le workbench : cd /opt/mndt-front && docker compose up -d --force-recreate workbench"