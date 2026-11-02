#!/bin/sh
# Watch the workbench: health, pending approvals and disk. Cron runs it every
# ten minutes; a line lands in watch.log and a non-zero exit marks an anomaly.
set -u

LOG=${MNDT_WATCH_LOG:-/data/mndt/monitor/watch.log}
mkdir -p "$(dirname "$LOG")"

health=$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:8795/health || echo 000)
metrics=$(curl -s -m 10 -H 'x-forwarded-email: duke@datanalysis.re' http://127.0.0.1:8795/metrics || echo '{}')
disk=$(df -P /data | awk 'NR==2 {print $5}' | tr -d '%')

line=$(python3 - "$health" "$disk" "$metrics" <<'PY'
import json, sys
health = sys.argv[1]
disk = int(sys.argv[2]) if sys.argv[2].isdigit() else 0
try:
    metrics = json.loads(sys.argv[3])
except Exception:
    metrics = {}
oldest = metrics.get('oldestApprovalHours', '?')
done = metrics.get('missions', {}).get('done', '?')
state = 'ok'
if health != '200':
    state = 'sante'
elif disk >= 90:
    state = 'disque'
elif isinstance(oldest, (int, float)) and oldest >= 48:
    state = 'approbations'
print(f"{state} sante={health} disque={disk}% en_attente={metrics.get('approvalsPending', '?')} plus_vieille={oldest} terminees={done}")
PY
)

echo "$(date -u +%FT%TZ) $line" >> "$LOG"
case "$line" in
  ok*) exit 0 ;;
  *) exit 1 ;;
esac