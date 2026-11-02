#!/bin/sh
# Move journal entries older than a number of days into a yearly archive file.
# The live state keeps its recent history; nothing is deleted.
# Usage: archive-state.sh [--days N] [--dry-run|--apply]
set -eu

LIVE_DIR=${MNDT_LIVE_DIR:-/data/mndt/live}
ARCHIVE_DIR=${MNDT_ARCHIVE_DIR:-/data/mndt/archive}
days=60
apply=no
while [ $# -gt 0 ]; do
  case "$1" in
    --days) days=$2; shift 2 ;;
    --apply) apply=yes; shift ;;
    --dry-run) apply=no; shift ;;
    *) echo "option inconnue: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$ARCHIVE_DIR"
python3 - "$LIVE_DIR/state.json" "$ARCHIVE_DIR" "$days" "$apply" <<'PY'
import json, os, sys
from datetime import datetime, timedelta, timezone

state_path, archive_dir, days, apply = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4] == 'yes'
with open(state_path) as handle:
    state = json.load(handle)
events = state.get('events', [])
cutoff = datetime.now(timezone.utc) - timedelta(days=days)
def at(event):
    try:
        return datetime.fromisoformat(event['at'].replace('Z', '+00:00'))
    except Exception:
        return datetime.now(timezone.utc)
old = [event for event in events if at(event) < cutoff]
recent = [event for event in events if at(event) >= cutoff]
print(f'journal: {len(events)} evenements, {len(old)} anterieurs a {days} jours, {len(recent)} conserves')
if not old:
    print('rien a archiver')
    raise SystemExit(0)
year = cutoff.year
target = os.path.join(archive_dir, f'journal-{year}.jsonl')
print(f'archive: {target}')
if not apply:
    print('simulation: aucune ecriture')
    raise SystemExit(0)
with open(target, 'a') as handle:
    for event in sorted(old, key=lambda row: row.get('at', '')):
        handle.write(json.dumps(event, sort_keys=True) + '\n')
trimmed = dict(state)
trimmed['events'] = recent
temporary = state_path + '.part'
with open(temporary, 'w') as handle:
    json.dump(trimmed, handle)
os.replace(temporary, state_path)
print(f'archive ecrite, etat reduit a {len(recent)} evenements')
PY