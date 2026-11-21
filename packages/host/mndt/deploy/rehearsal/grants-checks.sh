#!/usr/bin/env bash
# The role file row by row (#75), on the running rehearsal stack, through the
# gateway and the signing proxy as a browser reaches them:
#   grants-checks.sh <data folder> <compose project> <owner> <viewer>
# Rewrites grants.json and state.json for each case, restores grants.json at
# the end. Prints one OK/KO line per check; exits with the number of KO.
set -uo pipefail
data=${1:?data folder}; project=${2:?project}; owner=${3:?owner}; viewer=${4:?viewer}
base=http://127.0.0.1:18080/mndt-api
ko=0
saved=$(mktemp); cp "$data/grants.json" "$saved"
trap 'cp "$saved" "$data/grants.json"; rm -f "$saved"' EXIT
check() { if [ "$2" = 1 ]; then echo "OK  $1  $3"; else echo "KO  $1  $3"; ko=$((ko + 1)); fi; }
# GET as a person; extra headers as forged by a browser. Prints "<status> <body>".
get() { local who=$1 path=$2; shift 2; curl -s -w '\n%{http_code}' -H "x-forwarded-email: $who" "$@" "$base$path" | { body=$(cat); echo "$(echo "$body" | tail -1) $(echo "$body" | sed '$d' | tr -d '\n')"; }; }
status() { get "$@" | cut -d' ' -f1; }
grants() { printf '%s\n' "$1" > "$data/grants.json"; }
set_aside_lines() { docker logs $project-workbench 2>&1 | grep -c "is set aside and grants nothing" ; }

base_rows="{ \"subject\": \"$owner\", \"role\": \"owner\" }, { \"subject\": \"$viewer\", \"role\": \"viewer\" }"

# 1. A mistyped role: the row is set aside, the others are served, said once.
before=$(set_aside_lines)
grants "{ \"grants\": [ $base_rows, { \"subject\": \"typo@datanalysis.re\", \"role\": \"viewr\" } ] }"
v=$(status $viewer /channels); o=$(status $owner /channels)
for _ in 1 2 3; do status $viewer /channels >/dev/null; done
me_owner=$(get $owner /me); me_viewer=$(get $viewer /me)
after=$(set_aside_lines)
check grants-typo "$([ "$v" = 200 ] && [ "$o" = 200 ] && echo 1)" "a « viewr » row: viewer $v, owner $o"
check grants-said-once "$([ $((after - before)) = 1 ] && echo 1)" "$((after - before)) log line(s) for 5 requests"
check grants-skipped-owner "$(echo "$me_owner" | grep -q '"grantsSkipped":\[{"row":3' && echo 1)" "owner /me: $(echo "$me_owner" | grep -o '"grantsSkipped":[^]]*]' | head -1)"
check grants-skipped-viewer "$(echo "$me_viewer" | grep -vq grantsSkipped && echo 1)" "viewer /me without grantsSkipped"

# 2. The owner's own row set aside: no role, but the gateway's owner still sees why.
grants "{ \"grants\": [ { \"subject\": \"$owner\", \"role\": \"ownr\" }, { \"subject\": \"$viewer\", \"role\": \"viewer\" } ] }"
me_owner=$(get $owner /me)
check grants-owner-row "$(echo "$me_owner" | grep -q '"shell":true' && echo "$me_owner" | grep -q '"grantsSkipped"' && [ "$(status $owner /channels)" = 403 ] && echo 1)" "owner /me: shell and grantsSkipped, /channels $(status $owner /channels)"

# 3. A broken file: 503 everywhere, the reason told to the owner only.
printf '{ "grants": [ ' > "$data/grants.json"
c_owner=$(status $owner /channels); c_viewer=$(status $viewer /channels)
me_owner=$(get $owner /me); me_viewer=$(get $viewer /me)
check grants-broken "$([ "$c_owner" = 503 ] && [ "$c_viewer" = 503 ] && echo "$me_owner" | grep -q '"grantsError"' && echo "$me_viewer" | grep -vq grantsError && echo 1)" "/channels $c_owner/$c_viewer, the reason in the owner's /me only"

# 4. Every row invalid: 403 everywhere but /me and /org.
grants "{ \"grants\": [ { \"subject\": \"$owner\", \"role\": \"boss\" }, { \"role\": \"viewer\" } ] }"
codes="$(status $viewer /me) $(status $viewer /org) $(status $viewer /channels) $(status $owner /state) $(status $viewer /metrics)"
check grants-all-invalid "$([ "$codes" = '200 200 403 403 403' ] && echo 1)" "/me /org /channels /state /metrics: $codes"

# 5. Headers a browser forges: no shell, no thread.
grants "{ \"grants\": [ $base_rows ] }"
forged=$(get $viewer /me -H 'x-mndt-shell: 1')
check forged-shell "$(echo "$forged" | grep -q '"shell":false' && echo 1)" "viewer /me with x-mndt-shell: 1: $(echo "$forged" | grep -o '"shell":[a-z]*')"
card=$(curl -s -X POST -H "x-forwarded-email: $owner" -H 'x-mndt-run: trn_forged' -H 'content-type: application/json' \
  --data '{"kind":"publish","title":"Carte forgee","payload":{}}' "$base/approvals")
check forged-run "$(echo "$card" | grep -q '"approval"' && echo "$card" | grep -vq 'requestedByAgent' && echo "$card" | grep -vq '"channelId"' && echo 1)" "a card with a forged x-mndt-run names no agent, no thread"

# 6. /metrics, read by a viewer and by the owner.
m_owner=$(get $owner /metrics); m_viewer=$(get $viewer /metrics)
check metrics-reader "$(echo "$m_owner" | grep -q '^200 ' && echo "$m_viewer" | grep -q '^200 ' && echo 1)" "owner: $(echo "$m_owner" | grep -o '"approvalsPending":[0-9]*'), viewer: $(echo "$m_viewer" | grep -o '"approvalsPending":[0-9]*,"oldest[^,]*,"activeMandates":[0-9]*')"

# 7. A mandate to oneself in other capitals, loaded at start: retired, no crash.
python3 - "$data/state.json" "$owner" <<'PY'
import json, sys
path, owner = sys.argv[1], sys.argv[2]
state = json.load(open(path, encoding="utf-8"))
state.setdefault("mandates", []).insert(0, {"id": "mnd_rehearsal_self", "delegant": owner.upper(), "delegataire": owner,
  "purpose": "p", "connectors": ["office365"], "missionKinds": ["briefing"], "dailyCap": 1, "expiresOn": "2099-01-01",
  "state": "active", "createdAt": "2026-11-15T00:00:00Z"})
json.dump(state, open(path, "w", encoding="utf-8"))
PY
docker restart $project-workbench >/dev/null
for _ in $(seq 1 90); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$base/health")" = 200 ] && break; sleep 2; done
mandates=$(get $owner /mandates)
check mandate-self-retired "$(echo "$mandates" | grep -q '"id":"mnd_rehearsal_self"[^}]*"state":"retired"' && docker logs $project-workbench 2>&1 | grep -q 'mnd_rehearsal_self retired on load' && echo 1)" \
  "$(echo "$mandates" | grep -o '"id":"mnd_rehearsal_self"[^}]*"state":"[a-z]*"' | grep -o '"state":"[a-z]*"' | head -1), said in the log"

echo "grants-checks exit $ko"
exit $ko
