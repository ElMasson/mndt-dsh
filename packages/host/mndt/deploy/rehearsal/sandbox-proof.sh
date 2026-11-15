#!/usr/bin/env bash
# The sandbox read allow-list, proved at the mechanism: the image's own
# LocalSandboxProvider (sandbox-local) confines probe.sh exactly as it confines
# an agent's command, with the DSH_SANDBOX_READ_ROOTS the tenant's compose
# template declares, the environment the subprocess layer really hands a command
# (model.env included) and the production HOME. Canaries stand where the
# instance keeps its secrets.
#
# Three runs in the same container:
#   - without the allow-list: every secret canary must be found (the probe can see);
#   - with it, a first session (the owner's DSH session) leaves a secret in its
#     private temp, then a second session (a channel's turn) runs the probe: no
#     LEAK, no CROSS, no TRUNCATED nor TIMEOUT, every DONE, and every witness that
#     works without the list works with it, except the ones named as limits.
#   sandbox-proof.sh <workbench image>
set -u
image=${1:?usage: sandbox-proof.sh <workbench image>}
here=$(cd "$(dirname "$0")" && pwd)
template="$here/../tenant/docker-compose.yml.template"
roots=$(grep -o 'DSH_SANDBOX_READ_ROOTS: "[^"]*"' "$template" | cut -d'"' -f2)
[ -n "$roots" ] || { echo "KO: no DSH_SANDBOX_READ_ROOTS in $template"; exit 1; }
# The probe's tools, read-only in the container; the output stays outside it.
work=$(mktemp -d)
out=$(mktemp)
trap 'rm -rf "$work" "$out"' EXIT
cp "$here/probe.sh" "$here/sandbox-probe.mjs" "$work/"

# model.env as the workbench loads it (env_file): two keys the name filter drops,
# and two credentials under ordinary names, which only the allow-listed
# environment keeps out.
cat > "$work/model.env" <<'ENV'
SCW_GENAPI_KEY=CANARY_SECRET_model_key
VLLM_API_KEY=CANARY_SECRET_vllm_key
DATABASE_URL=postgres://team:CANARY_SECRET_innocuous_url@db:5432/team
QONTO_PASS=CANARY_SECRET_innocuous_pass
ENV

# The secret the first session leaves in its own private temp.
cat > "$work/own-temp.sh" <<'OWN'
echo "CANARY_SECRET_other_session_temp" > "$TMPDIR/note"
echo "OWN-TEMP $TMPDIR"
OWN

# Plant the canaries as the instance holds them, then run the probe. The script
# is a file: no canary sits in a process's command line.
cat > "$work/plant.sh" <<'PLANT'
set -e
mkdir -p /state/connectors /state/channels/chn_probe/files /state/channels/chn_other/files /state/home/sessions/--state-channels-chn_other-files-- \
  /state/tools /state/mcp-auth /run/secrets /run/mndt-launch /opt/mndt-tools /dev/shm /tmp/dsh-subprocess-other /tmp/dsh-run-other
# Secrets, where the instance keeps them: finding one is a LEAK.
echo "CANARY_SECRET_model_env=1" > /state/model.env
echo "{\"grants\":[{\"subject\":\"a@b.c\",\"role\":\"owner\",\"name\":\"CANARY_SECRET_grants\"}]}" > /state/grants.json
echo "{\"CANARY_SECRET_tokens\":{\"user\":\"a@b.c\"}}" > /state/tokens.json
echo "{\"CANARY_SECRET_state\":1}" > /state/state.json
echo "CANARY_SECRET_connector_env=1" > /state/connectors/qonto.env
echo "CANARY_SECRET_transcript" > /state/home/sessions/--state-channels-chn_other-files--/turn.jsonl
echo "CANARY_SECRET_other_channel" > /state/channels/chn_other/files/note.txt
echo "CANARY_SECRET_state_web_token" > /state/web-token
echo "CANARY_SECRET_tools_data" > /state/tools/facts.md
echo "CANARY_SECRET_mcp_auth" > /state/mcp-auth/token.json
# A binary file (SQLite-like, NUL bytes around the canary): searched too.
printf 'SQLite format 3\000\001\002CANARY_SECRET_binary_db\000\003' > /state/sessions.db
echo "CANARY_SECRET_gateway_secret" > /run/secrets/mndt-gateway
echo "CANARY_SECRET_proxy_signature" > /run/secrets/mndt-proxy-signature
echo "CANARY_SECRET_launch_token" > /run/mndt-launch/web-token
echo "token=CANARY_SECRET_launch_log" > /run/mndt-launch/web.log
echo "CANARY_SECRET_root_home" > /root/.canary
echo "CANARY_SECRET_dev_shm" > /dev/shm/canary
# The tools folder is mounted from inside /state: its data is a secret too.
echo "CANARY_SECRET_tools_mount" > /opt/mndt-tools/facts.md
# Another session's command output, spilled by the workbench in the shared /tmp,
# and another session's private temp.
echo "CANARY_SECRET_spill" > /tmp/dsh-subprocess-other/stdout
echo "CANARY_SECRET_other_temp" > /tmp/dsh-run-other/note
# Where reading is allowed: finding this proves the search really read there.
echo "# CANARY_SEARCHED_etc" > /etc/mndt-probe-searched.conf
cp /w/probe.sh /state/channels/chn_probe/files/probe.sh
cp /w/own-temp.sh /state/channels/chn_other/files/own-temp.sh
cd /state/channels/chn_probe/files
echo "=== run without the allow-list"
env -u DSH_SANDBOX_READ_ROOTS node /w/sandbox-probe.mjs /state/channels/chn_probe/files probe.sh
echo "=== the owner's session leaves a secret in its private temp"
PROBE_SESSION=owner-dsh node /w/sandbox-probe.mjs /state/channels/chn_other/files own-temp.sh
echo "=== run with the allow-list"
PROBE_SESSION=turn-chn-probe node /w/sandbox-probe.mjs /state/channels/chn_probe/files probe.sh
PLANT
docker run --rm -v "$work:/w:ro" --env-file "$work/model.env" -e DSH_SANDBOX_READ_ROOTS="$roots" --entrypoint sh "$image" /w/plant.sh > "$out" 2>&1
code=$?
without=$(sed -n '/=== run without/,/=== the owner/p' "$out")
owner=$(sed -n '/=== the owner/,/=== run with the/p' "$out")
with=$(sed -n '/=== run with the allow-list/,$p' "$out")
show='^(RUNNER|ARGV-BYTES|READ|LEAK|SEEN|CROSS|OPEN|DONE|NOREAD|TIMEOUT|TRUNCATED|UNSEEN|WITNESS|SANDBOX-REFUSED|EXIT|STDERR|environment names)'
echo "allow-list: $roots"
echo "--- without:"; echo "$without" | grep -E '^(RUNNER|READ|DONE1|NOREAD|TIMEOUT|TRUNCATED|WITNESS)' | head -40
echo "--- the owner's session:"; echo "$owner" | grep -E '^(RUNNER|OWN-TEMP|EXIT|STDERR|SANDBOX-REFUSED)'
echo "--- with:"; echo "$with" | grep -E "$show" | head -80
ok=0
# Without the list the probe must see every secret: else it proves nothing.
missing=''
for canary in model_env grants tokens state connector_env transcript other_channel state_web_token tools_data mcp_auth binary_db \
              gateway_secret proxy_signature launch_token launch_log root_home dev_shm tools_mount spill other_temp \
              innocuous_url innocuous_pass; do
  echo "$without" | grep -q "CANARY_SECRET_$canary" || missing="$missing $canary"
done
if [ -z "$missing" ]; then echo "OK  probe-sees     without the allow-list every secret canary is found (22, the binary file and the two ordinary names included)"; else echo "KO  probe-sees     without the allow-list, not found:$missing"; ok=1; fi
echo "$without" | grep -q 'CANARY_SECRET_model_key\|CANARY_SECRET_vllm_key' && { echo "KO  name-filter    without the allow-list a *_KEY variable reached the command"; ok=1; }
echo "$owner" | grep -q '^OWN-TEMP ' || { echo "KO  owner-temp     the owner's session did not write in its private temp"; ok=1; }
leaks=$(echo "$with" | grep -cE '^(LEAK|CROSS|OPEN)')
[ "$leaks" = 0 ] && echo "OK  no-leak        with the allow-list: no LEAK, no CROSS, no OPEN (the owner's temp, the spill, /state/tools, /state/mcp-auth included)" || { echo "KO  no-leak        $leaks LEAK/CROSS/OPEN line(s) with the allow-list"; ok=1; }
echo "$with" | grep -q 'CANARY_SECRET_other_session_temp' && { echo "KO  sessions       a turn read the owner's session temp"; ok=1; }
cut=$(echo "$with$without" | grep -cE '^(TIMEOUT|TRUNCATED)')
[ "$cut" = 0 ] && echo "OK  complete       no walk truncated nor timed out" || { echo "KO  complete       $cut walk(s) truncated or timed out: the search proves nothing"; ok=1; }
echo "$with" | grep -q "^SEEN file .*CANARY_SEARCHED_etc" && echo "OK  searched       with the allow-list the probe read /etc, where reading is allowed" || { echo "KO  searched       with the allow-list the probe did not read the /etc canary: the search proves nothing"; ok=1; }
for step in 1 2 3 5 6; do echo "$with" | grep -q "^DONE$step" || { echo "KO  step-$step       no DONE$step with the allow-list"; ok=1; }; done
echo "$with" | grep -q '^DONE1' && echo "$with" | grep -q '^DONE6' && echo "OK  steps          DONE 1, 2, 3, 5, 6 ($(echo "$with" | grep '^DONE1'))"
# The witnesses: the agent's own work must not break. Required ones must work
# with the list; any other one that works without it and not with it is a limit,
# printed, and fails the proof unless named in KNOWN_LIMITS.
required='own-channel-file ls-usr node python3 tmpdir home git-init git-commit git-status git-log dev-stdout process-substitution'
# os-cpus: Node reads /proc/cpuinfo and /proc/stat, and /proc is never readable
# (the other processes' environment holds the model keys): os.cpus() returns an
# empty list under the allow-list (measured 15/11). A tool sizing a worker pool
# on it must fall back to 1.
KNOWN_LIMITS=${KNOWN_LIMITS:-os-cpus}
for name in $required; do
  echo "$with" | grep -q "^WITNESS $name\$" || { echo "KO  witness        $name does not work with the allow-list: $(echo "$with" | grep "^WITNESS-[A-Z]* $name" | head -1)"; ok=1; }
done
for name in $(echo "$without" | sed -n 's/^WITNESS \([a-z0-9-]*\)$/\1/p'); do
  echo "$with" | grep -q "^WITNESS $name\$" && continue
  case " $required " in *" $name "*) continue ;; esac
  case " $KNOWN_LIMITS " in
    *" $name "*) echo "LIMIT witness     $name works without the list, not with it (known): $(echo "$with" | grep "^WITNESS-[A-Z]* $name" | head -1)" ;;
    *) echo "KO  witness        $name works without the list, not with it: $(echo "$with" | grep "^WITNESS-[A-Z]* $name" | head -1)"; ok=1 ;;
  esac
done
absent=$(echo "$with" | sed -n 's/^WITNESS-ABSENT //p' | tr '\n' ' ')
[ -n "$absent" ] && echo "NOTE witness      absent from the image: $absent"
echo "$with" | grep -q '^RUNNER .*landlock' || { echo "KO  runner         not Landlock with the allow-list"; ok=1; }
echo "$with" | grep '^ARGV-BYTES' | head -1
echo "sandbox-proof exit $ok (docker $code)"
exit $ok
