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
mkdir -p /state/connectors /state/channels/chn_probe/files /state/channels/chn_other/files /state/home/sessions/--state-channels-chn_other-files-- /run/secrets /run/mndt-launch
echo "CANARY_MODEL_ENV=CANARY_model_env" > /state/model.env
echo "{\"grants\":[{\"subject\":\"a@b.c\",\"role\":\"owner\",\"name\":\"CANARY_grants_name\"}]}" > /state/grants.json
echo "{\"CANARY_tokens_value\":{\"user\":\"a@b.c\"}}" > /state/tokens.json
echo "CANARY_CONNECTOR_ENV=CANARY_connector_env" > /state/connectors/qonto.env
echo "CANARY_transcript_of_another_channel" > /state/home/sessions/--state-channels-chn_other-files--/turn.jsonl
echo "CANARY_file_of_another_channel" > /state/channels/chn_other/files/note.txt
echo "CANARY_state_web_token" > /state/web-token
echo "CANARY_gateway_secret" > /run/secrets/mndt-gateway
echo "CANARY_launch_token" > /run/mndt-launch/web-token
echo "CANARY_root_home" > /root/.canary
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
echo "--- without:"; echo "$without" | grep -E '^(RUNNER|LEAK|CROSS|DONE|TIMEOUT|WITNESS|SANDBOX-REFUSED|EXIT)' | sort | uniq -c | sort -rn | head -20
echo "--- with:"; echo "$with" | grep -E '^(RUNNER|LEAK|CROSS|OPEN|DONE|TIMEOUT|WITNESS|SANDBOX-REFUSED|EXIT|STDERR)' | head -40
ok=0
seen=$(echo "$without" | grep -c '^LEAK') ; [ "$seen" -gt 0 ] || { echo "KO  probe-sees     without the allow-list the probe found no canary: it proves nothing"; ok=1; }
[ "$seen" -gt 0 ] && echo "OK  probe-sees     without the allow-list: $seen LEAK line(s), the canaries are findable"
leaks=$(echo "$with" | grep -cE '^(LEAK|CROSS)')
[ "$leaks" = 0 ] && echo "OK  no-leak        with the allow-list: no LEAK, no CROSS" || { echo "KO  no-leak        $leaks LEAK/CROSS line(s) with the allow-list"; ok=1; }
for step in 1 2 3 5 6; do echo "$with" | grep -q "^DONE$step" || { echo "KO  step-$step       no DONE$step with the allow-list"; ok=1; }; done
echo "$with" | grep -q '^DONE1' && echo "$with" | grep -q '^DONE6' && echo "OK  steps          DONE 1, 2, 3, 5, 6"
for witness in own-channel-file ls-usr; do echo "$with" | grep -q "^WITNESS $witness" || { echo "KO  witness        no WITNESS $witness: the allow-list breaks the agent's own work"; ok=1; }; done
echo "$with" | grep -q '^WITNESS own-channel-file' && echo "OK  witness        the agent still writes in its channel and reads /usr"
echo "$with" | grep -q '^RUNNER .*landlock' || { echo "KO  runner         not Landlock with the allow-list"; ok=1; }
echo "sandbox-proof exit $ok (docker $code)"
exit $ok
