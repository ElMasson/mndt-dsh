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
state_saved=$(mktemp); cp "$data/state.json" "$state_saved"
# What the restore must give back: the content, the owner and the mode.
state_was="$(stat -c '%u:%g %a' "$data/state.json") $(sha256sum < "$data/state.json" | cut -c1-16)"
# state.json belongs to the workbench's user, not to the one running this
# script (a write from here is « Permission denied », 23/11): it is changed
# from a throwaway container of the same image, as root on the data folder,
# and keeps its owner and mode. Usage: state_py [args] <<'PY' ... PY
image=$(docker inspect -f '{{.Config.Image}}' $project-workbench)
state_py() {
  docker run --rm -i --user 0 --network none -v "$data:/state" -v "$state_saved:/saved:ro" \
    --entrypoint python3 "$image" - /state/state.json "$@"
}
# The role file and the state are put back as they were, whatever happens.
# The state is put back with the workbench stopped, for the same reason as in 7.
restore() {
  cp "$saved" "$data/grants.json"
  docker stop $project-workbench >/dev/null
  state_py <<'PY'
import os, shutil, sys
path = sys.argv[1]; st = os.stat(path)
shutil.copyfile("/saved", path); os.chown(path, st.st_uid, st.st_gid); os.chmod(path, st.st_mode & 0o777)
PY
  docker start $project-workbench >/dev/null
  for _ in $(seq 1 90); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$base/health")" = 200 ] && break; sleep 2; done
  state_is="$(stat -c '%u:%g %a' "$data/state.json") $(sha256sum < "$data/state.json" | cut -c1-16)"
  if [ "$state_is" = "$state_was" ]; then echo "OK  state-restored  state.json back as it was: owner:group mode sha $state_is"
  else echo "KO  state-restored  state.json was « $state_was », is « $state_is »"; fi
  rm -f "$saved" "$state_saved"
}
trap restore EXIT
check() { if [ "$2" = 1 ]; then echo "OK  $1  $3"; else echo "KO  $1  $3"; ko=$((ko + 1)); fi; }
# GET as a person; extra headers as forged by a browser. Prints "<status> <body>".
get() { local who=$1 path=$2; shift 2; curl -s -w '\n%{http_code}' -H "x-forwarded-email: $who" "$@" "$base$path" | { body=$(cat); echo "$(echo "$body" | tail -1) $(echo "$body" | sed '$d' | tr -d '\n')"; }; }
status() { get "$@" | cut -d' ' -f1; }
grants() { printf '%s\n' "$1" > "$data/grants.json"; }
# What the workbench said: dsh writes to its web log (DSH_MNDT_WEB_LOG on a team
# tenant, /state/web.log otherwise), not to the container's output.
# Never « … | grep -q » here: under pipefail, grep -q closes the pipe at its
# first match and a producer still writing gets SIGPIPE, so the pipeline fails
# although the line was found (mandate-self-retired, 23/11). Count instead, or
# give grep the text without a pipe (<<<).
workbench_log() {
  docker exec $project-workbench sh -c 'cat "${DSH_MNDT_WEB_LOG:-/state/web.log}" 2>/dev/null'
  docker logs $project-workbench 2>&1
}
set_aside_lines() { workbench_log | grep -c "is set aside and grants nothing" ; }

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
check grants-skipped-owner "$(grep -q '"grantsSkipped":\[{"row":3' <<<"$me_owner" && echo 1)" "owner /me: $(echo "$me_owner" | grep -o '"grantsSkipped":[^]]*]' | head -1)"
check grants-skipped-viewer "$(grep -vq grantsSkipped <<<"$me_viewer" && echo 1)" "viewer /me without grantsSkipped"

# 2. The owner's own row set aside: no role, but the gateway's owner still sees why.
grants "{ \"grants\": [ { \"subject\": \"$owner\", \"role\": \"ownr\" }, { \"subject\": \"$viewer\", \"role\": \"viewer\" } ] }"
me_owner=$(get $owner /me)
check grants-owner-row "$(grep -q '"shell":true' <<<"$me_owner" && grep -q '"grantsSkipped"' <<<"$me_owner" && [ "$(status $owner /channels)" = 403 ] && echo 1)" "owner /me: shell and grantsSkipped, /channels $(status $owner /channels)"

# 3. A broken file: 503 everywhere, the reason told to the owner only.
printf '{ "grants": [ ' > "$data/grants.json"
c_owner=$(status $owner /channels); c_viewer=$(status $viewer /channels)
me_owner=$(get $owner /me); me_viewer=$(get $viewer /me)
check grants-broken "$([ "$c_owner" = 503 ] && [ "$c_viewer" = 503 ] && grep -q '"grantsError"' <<<"$me_owner" && grep -vq grantsError <<<"$me_viewer" && echo 1)" "/channels $c_owner/$c_viewer, the reason in the owner's /me only"

# 4. Every row invalid: 403 everywhere but /me and /org.
grants "{ \"grants\": [ { \"subject\": \"$owner\", \"role\": \"boss\" }, { \"role\": \"viewer\" } ] }"
codes="$(status $viewer /me) $(status $viewer /org) $(status $viewer /channels) $(status $owner /state) $(status $viewer /metrics)"
check grants-all-invalid "$([ "$codes" = '200 200 403 403 403' ] && echo 1)" "/me /org /channels /state /metrics: $codes"

# 5. Headers a browser forges: no shell, no thread.
grants "{ \"grants\": [ $base_rows ] }"
forged=$(get $viewer /me -H 'x-mndt-shell: 1')
check forged-shell "$(grep -q '"shell":false' <<<"$forged" && echo 1)" "viewer /me with x-mndt-shell: 1: $(echo "$forged" | grep -o '"shell":[a-z]*')"
card=$(curl -s -X POST -H "x-forwarded-email: $owner" -H 'x-mndt-run: trn_forged' -H 'content-type: application/json' \
  --data '{"kind":"publish","title":"Carte forgee","payload":{}}' "$base/approvals")
check forged-run "$(grep -q '"approval"' <<<"$card" && grep -vq 'requestedByAgent' <<<"$card" && grep -vq '"channelId"' <<<"$card" && echo 1)" "a card with a forged x-mndt-run names no agent, no thread"

# 6. /metrics, read by a viewer and by the owner: the owner's private card of
# step 5 (outside any channel) is counted and dated for the owner, not for the
# viewer, who must not learn of it.
m_owner=$(get $owner /metrics); m_viewer=$(get $viewer /metrics)
pending_owner=$(echo "$m_owner" | grep -o '"approvalsPending":[0-9]*' | cut -d: -f2)
pending_viewer=$(echo "$m_viewer" | grep -o '"approvalsPending":[0-9]*' | cut -d: -f2)
last_owner=$(echo "$m_owner" | grep -o '"lastEventAt":[^,}]*' | cut -d: -f2-)
last_viewer=$(echo "$m_viewer" | grep -o '"lastEventAt":[^,}]*' | cut -d: -f2-)
check metrics-reader "$(grep -q '^200 ' <<<"$m_owner" && grep -q '^200 ' <<<"$m_viewer" && [ "${pending_owner:-0}" -gt "${pending_viewer:-0}" ] && [ "$last_owner" != "$last_viewer" ] && echo 1)" \
  "approvalsPending owner $pending_owner / viewer $pending_viewer, lastEventAt owner $last_owner / viewer $last_viewer"

# 7. A mandate to oneself in other capitals, loaded at start: retired, no crash.
# The workbench is stopped first: running, it keeps the state in memory and may
# write it back over an edit made beside it.
docker stop $project-workbench >/dev/null
state_py "$owner" <<'PY'
import json, os, sys
path, owner = sys.argv[1], sys.argv[2]
st = os.stat(path)
state = json.load(open(path, encoding="utf-8"))
state.setdefault("mandates", []).insert(0, {"id": "mnd_rehearsal_self", "delegant": owner.upper(), "delegataire": owner,
  "purpose": "p", "connectors": ["office365"], "missionKinds": ["briefing"], "dailyCap": 1, "expiresOn": "2099-01-01",
  "state": "active", "createdAt": "2026-11-15T00:00:00Z"})
json.dump(state, open(path, "w", encoding="utf-8"))
os.chown(path, st.st_uid, st.st_gid); os.chmod(path, st.st_mode & 0o777)
print("mandate written")
PY
docker start $project-workbench >/dev/null
# The workbench's own API, not only the gateway: /mandates answers once it loaded the state.
for _ in $(seq 1 90); do [ "$(status $owner /mandates)" = 200 ] && break; sleep 2; done
mandates=$(get $owner /mandates)
check mandate-self-retired "$(grep -q '"id":"mnd_rehearsal_self"[^}]*"state":"retired"' <<<"$mandates" && [ "$(workbench_log | grep -c 'mnd_rehearsal_self retired on load')" -gt 0 ] && echo 1)" \
  "$(echo "$mandates" | grep -o '"id":"mnd_rehearsal_self"[^}]*"state":"[a-z]*"' | grep -o '"state":"[a-z]*"' | head -1), said in the log"

echo "grants-checks exit $ko"
exit $ko
