#!/usr/bin/env bash
# The sandbox read allow-list, proved at the mechanism: the image's own
# LocalSandboxProvider (sandbox-local) confines probe.sh exactly as it confines
# an agent's command, with the DSH_SANDBOX_READ_ROOTS the tenant's compose
# template declares. Canaries stand where the instance keeps its secrets.
#
# Two runs of the same probe in the same container:
#   - without the allow-list: the canaries must be found (the probe can see);
#   - with it: no LEAK, no CROSS, every DONE and the witnesses.
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

# Plant the canaries as the instance holds them, then run the probe twice. The
# script is a file: no canary sits in a process's command line.
cat > "$work/plant.sh" <<'PLANT'
set -e
mkdir -p /state/connectors /state/channels/chn_probe/files /state/channels/chn_other/files /state/home/sessions/--state-channels-chn_other-files-- \
  /run/secrets /run/mndt-launch /opt/mndt-tools /dev/shm
# Secrets, where the instance keeps them: finding one is a LEAK.
echo "CANARY_SECRET_model_env=1" > /state/model.env
echo "{\"grants\":[{\"subject\":\"a@b.c\",\"role\":\"owner\",\"name\":\"CANARY_SECRET_grants\"}]}" > /state/grants.json
echo "{\"CANARY_SECRET_tokens\":{\"user\":\"a@b.c\"}}" > /state/tokens.json
echo "CANARY_SECRET_connector_env=1" > /state/connectors/qonto.env
echo "CANARY_SECRET_transcript" > /state/home/sessions/--state-channels-chn_other-files--/turn.jsonl
echo "CANARY_SECRET_other_channel" > /state/channels/chn_other/files/note.txt
echo "CANARY_SECRET_state_web_token" > /state/web-token
echo "CANARY_SECRET_gateway_secret" > /run/secrets/mndt-gateway
echo "CANARY_SECRET_launch_token" > /run/mndt-launch/web-token
echo "token=CANARY_SECRET_launch_log" > /run/mndt-launch/web.log
echo "CANARY_SECRET_root_home" > /root/.canary
echo "CANARY_SECRET_dev_shm" > /dev/shm/canary
# Where reading is allowed: finding these proves the search really read there.
echo "// CANARY_SEARCHED_tools" > /opt/mndt-tools/tool.mjs
echo "CANARY_SEARCHED_tmp" > /tmp/searched.txt
cp /w/probe.sh /state/channels/chn_probe/files/probe.sh
cd /state/channels/chn_probe/files
echo "=== run without the allow-list"
env -u DSH_SANDBOX_READ_ROOTS node /w/sandbox-probe.mjs /state/channels/chn_probe/files probe.sh
echo "=== run with the allow-list"
node /w/sandbox-probe.mjs /state/channels/chn_probe/files probe.sh
PLANT
docker run --rm -v "$work:/w:ro" -e DSH_SANDBOX_READ_ROOTS="$roots" --entrypoint sh "$image" /w/plant.sh > "$out" 2>&1
code=$?
without=$(sed -n '/=== run without/,/=== run with the/p' "$out")
with=$(sed -n '/=== run with the allow-list/,$p' "$out")
echo "allow-list: $roots"
echo "--- without:"; echo "$without" | grep -E '^(RUNNER|READ|DONE1|NOREAD)' | head -20
echo "--- with:"; echo "$with" | grep -E '^(RUNNER|READ|LEAK|SEEN|CROSS|OPEN|DONE|NOREAD|TIMEOUT|WITNESS|SANDBOX-REFUSED|EXIT|STDERR)' | head -60
ok=0
# Without the list the probe must see every secret of /state and /run: else it proves nothing.
missing=''
for canary in model_env grants tokens connector_env transcript other_channel state_web_token gateway_secret launch_token launch_log root_home; do
  echo "$without" | grep -q "CANARY_SECRET_$canary" || missing="$missing $canary"
done
if [ -z "$missing" ]; then echo "OK  probe-sees     without the allow-list every secret canary is found"; else echo "KO  probe-sees     without the allow-list, not found:$missing"; ok=1; fi
leaks=$(echo "$with" | grep -cE '^(LEAK|CROSS)')
[ "$leaks" = 0 ] && echo "OK  no-leak        with the allow-list: no LEAK, no CROSS" || { echo "KO  no-leak        $leaks LEAK/CROSS line(s) with the allow-list"; ok=1; }
for searched in tools tmp; do
  echo "$with" | grep -q "^SEEN file .*CANARY_SEARCHED_$searched" || { echo "KO  searched       with the allow-list the probe did not read the $searched canary: the search proves nothing"; ok=1; }
done
echo "$with" | grep -q "SEARCHED_tools" && echo "$with" | grep -q "SEARCHED_tmp" && echo "OK  searched       the probe read /opt/mndt-tools and /tmp, where reading is allowed"
for step in 1 2 3 5 6; do echo "$with" | grep -q "^DONE$step" || { echo "KO  step-$step       no DONE$step with the allow-list"; ok=1; }; done
echo "$with" | grep -q '^DONE1' && echo "$with" | grep -q '^DONE6' && echo "OK  steps          DONE 1, 2, 3, 5, 6 ($(echo "$with" | grep '^DONE1'))"
for witness in own-channel-file ls-usr python3; do echo "$with" | grep -q "^WITNESS $witness" || { echo "KO  witness        no WITNESS $witness: the allow-list breaks the agent's own work"; ok=1; }; done
echo "$with" | grep -q '^WITNESS node' || { echo "KO  witness        no WITNESS node"; ok=1; }
echo "$with" | grep -q '^WITNESS own-channel-file' && echo "$with" | grep -q '^WITNESS node' && echo "OK  witness        the agent still writes in its channel, reads /usr, runs node and python3"
echo "$with" | grep -q '^RUNNER .*landlock' || { echo "KO  runner         not Landlock with the allow-list"; ok=1; }
echo "sandbox-proof exit $ok (docker $code)"
exit $ok
