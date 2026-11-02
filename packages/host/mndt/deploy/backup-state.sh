#!/bin/sh
# Back up the live workbench state and its automation registry.
# Each copy is validated as JSON before it replaces the previous one, and copies
# older than fourteen days are removed. Cron redirects the output to backup.log.
set -eu

BACKUP_DIR=${MNDT_BACKUP_DIR:-/data/mndt/backups}
LIVE_DIR=${MNDT_LIVE_DIR:-/data/mndt/live}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

mkdir -p "$BACKUP_DIR"
echo "$(date -u +%FT%TZ) debut"
for name in state.json automations.json; do
  source_file="$LIVE_DIR/$name"
  [ -f "$source_file" ] || continue
  target="$BACKUP_DIR/${name%.json}-$STAMP.json"
  cp "$source_file" "$target.part"
  if python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$target.part"; then
    mv "$target.part" "$target"
    echo "$(date -u +%FT%TZ) ok $target $(wc -c < "$target") octets"
  else
    rm -f "$target.part"
    echo "$(date -u +%FT%TZ) invalide $source_file" >&2
    exit 1
  fi
done
find "$BACKUP_DIR" -name 'state-*.json' -type f -mtime +14 -delete
find "$BACKUP_DIR" -name 'automations-*.json' -type f -mtime +14 -delete
echo "$(date -u +%FT%TZ) fin"