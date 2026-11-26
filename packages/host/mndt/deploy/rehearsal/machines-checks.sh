#!/usr/bin/env bash
# The members' computers (« Mon ordinateur », eighth jump), checked on a running
# rehearsal stack: the sidecar, the socket proxy, the egress proxy and the
# computers it starts, through the API and the gateway as on the instance.
#
#   machines-checks.sh <project> <owner> <operator>
#
# The stack's override sets MNDT_MACHINE_MAX=2 (the third member is refused),
# MNDT_MACHINE_IDLE_SECONDS=90 (a computer stops by itself) and, on a machine
# without gVisor, MNDT_MACHINE_RUNTIME=runc with MNDT_MACHINE_ALLOW_RUNC=1: then
# pc-runtime says so, and the gVisor proof is machines-proof.sh under runsc.
# Each check prints one OK or KO line; the exit code is 1 when one is KO.
set -uo pipefail
project=${1:?usage: machines-checks.sh <project> <owner> <operator>}
owner=${2:?owner}; operator=${3:?operator}
third=tiers@datanalysis.re
api=http://127.0.0.1:18080/mndt-api
failed=0
ok() { echo "OK  $1  $2"; }
ko() { echo "KO  $1  $2"; failed=1; }
as() { curl -s -m 120 -H "x-forwarded-email: $1" -H 'content-type: application/json' "${@:2}"; }
# The sidecar itself, from the workbench (the one container beside the API on the
# machines network), with the token the API reads: what no agent can do.
sidecar() { # <method> <path> [json]
  docker exec -i $project-workbench node --input-type=module -e "
const token = (await import('node:fs')).readFileSync('/run/secrets/mndt-machines', 'utf8').trim()
const [method, path, body] = process.argv.slice(1)
const answer = await fetch('http://machines-api:8796' + path, { method, headers: { 'x-machine-token': token, 'content-type': 'application/json' }, ...(body ? { body } : {}), signal: AbortSignal.timeout(150000) })
console.log(answer.status + ' ' + (await answer.text()).slice(0, 2000))" "$@"
}
computer_of() { docker ps --filter "label=mndt.member=$1" --filter label=mndt.tenant=datanalysis --format '{{.Names}}' | head -1; }

# 1. A team space serves the computers only: the older surfaces answer 404.
codes=""
for route in 'POST /capture' 'POST /browsers/start' 'POST /browsers/stop' 'POST /desktops/start' 'POST /desktops/stop' 'GET /sessions' 'GET /shells/ensure?identity=duke@datanalysis.re'; do
  set -- $route
  body=''; [ "$1" = POST ] && body='{"identity":"duke@datanalysis.re","url":"https://example.org"}'
  codes="$codes $(sidecar "$1" "$2" "$body" | cut -d' ' -f1)"
done
pcs=$(sidecar GET /pcs | cut -d' ' -f1)
if [ "$(echo $codes)" = "404 404 404 404 404 404 404" ] && [ "$pcs" = 200 ]; then
  ok machines-pc-only "capture, session browsers and desktops, shells, sessions: 404 each; the computers answer ($pcs)"
else ko machines-pc-only "older surfaces:$codes; /pcs $pcs"; fi

# 2. The owner's computer, started through the gateway and the API, as the page does.
started=$(as $owner -X POST "$api/me/machine/start" -d '{}')
pc=$(computer_of $owner)
if echo "$started" | grep -q '"state":"running"' && [ -n "$pc" ]; then ok pc-start "the owner's computer runs ($pc), started through the gateway and the API"
else ko pc-start "answer ${started:0:200}; container « $pc »"; fi

# 3. Its runtime: gVisor, or runc said twice (a rehearsal without runsc).
runtime=$(docker inspect -f '{{.HostConfig.Runtime}}' "$pc" 2>/dev/null)
kernel=$(docker exec "$pc" uname -r 2>/dev/null)
booted=$(docker exec "$pc" sh -c 'dmesg 2>/dev/null | head -3' 2>/dev/null | tr '\n' ' ')
allowed=$(docker exec $project-machines sh -c 'echo "$MNDT_MACHINE_RUNTIME/$MNDT_MACHINE_ALLOW_RUNC"' 2>/dev/null)
if [ "$runtime" = runsc ] && echo "$booted" | grep -qi gvisor; then ok pc-runtime "runsc: the computer's kernel is gVisor's (uname -r $kernel; dmesg « ${booted:0:60} »)"
elif [ "$runtime" = runc ] && [ "$allowed" = runc/1 ]; then ok pc-runtime "runc, said twice (MNDT_MACHINE_RUNTIME=runc, MNDT_MACHINE_ALLOW_RUNC=1): a rehearsal without gVisor; the gVisor proof is machines-proof.sh under runsc"
else ko pc-runtime "runtime « $runtime », sidecar « $allowed », uname -r « $kernel », dmesg « ${booted:0:60} »"; fi

# 4. Nothing of the space inside, and no way out but the public web through its proxy.
inside=$(docker exec "$pc" sh -c 'test -e /state && echo state; test -S /var/run/docker.sock && echo socket; env | cut -d= -f1 | grep -E "KEY|SECRET|PASSWORD|TOKEN" | grep -vxE "AGENT_TOKEN|DESKTOP_TOKEN"; cat /run/secrets/mndt-machines 2>/dev/null && echo machines-token' 2>&1)
host_ip=$(hostname -I 2>/dev/null | awk '{ print $1 }')
metadata=$(docker exec "$pc" curl -s -o /dev/null -m 15 -w '%{http_code}' http://169.254.169.254/latest/meta-data/ 2>/dev/null)
hosted=$(docker exec "$pc" curl -s -o /dev/null -m 15 -w '%{http_code}' "http://$host_ip:18080/" 2>/dev/null)
workbench=$(docker exec "$pc" curl -s -o /dev/null -m 15 -w '%{http_code}' http://workbench:8795/health 2>/dev/null)
direct=$(docker exec "$pc" curl -s -o /dev/null -m 10 --noproxy '*' -w '%{http_code}' http://1.1.1.1/ 2>/dev/null)
if [ -z "$inside" ] && [ "$metadata" = 403 ] && [ "$hosted" = 403 ] && [ "$workbench" = 403 ] && [ "$direct" = 000 ]; then
  ok pc-isolation "no /state, no socket, no key nor the machine token inside; through its proxy the metadata, this host ($host_ip) and the API are refused (403 each); no route out without the proxy"
else ko pc-isolation "inside « $(echo $inside) »; metadata $metadata, host $hosted, API $workbench (403 each expected); direct $direct (000 expected)"; fi

# 5. Acting on it goes through the socket proxy: a command (exec) and a browser call (exec -i, stdin).
terminal=$(sidecar POST /pcs/act "{\"identity\":\"$owner\",\"kind\":\"terminal\",\"command\":\"echo pc-ok; id -u; pwd\"}")
browser=$(sidecar POST /pcs/act "{\"identity\":\"$owner\",\"kind\":\"browser\",\"op\":\"status\"}")
if echo "$terminal" | grep -q '^200 .*pc-ok\\n1000\\n/home/user' && echo "$browser" | grep -qE '^200 .*"ok": *true'; then
  ok pc-act-through-proxy "a command ran as 1000 in /home/user, and the browser agent answered (stdin through docker exec -i): the socket proxy carries both"
else ko pc-act-through-proxy "terminal « ${terminal:0:200} »; browser « ${browser:0:200} »"; fi

# 6. Its space's names and labels, never another space's.
labels=$(docker inspect -f '{{index .Config.Labels "mndt.tenant"}}' "$pc" 2>/dev/null)
networks=$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$pc" 2>/dev/null)
netlabel=$(docker network inspect -f '{{index .Labels "mndt.tenant"}} {{.Internal}}' $networks 2>/dev/null | head -1)
if [ "$labels" = datanalysis ] && [[ $pc == mndt-pc-datanalysis-* ]] && [[ $networks == mndt-pc-net-datanalysis-* ]] && [ "$netlabel" = 'datanalysis true' ]; then
  ok pc-tenant "the computer and its internal network carry mndt.tenant=datanalysis and this space's names ($pc, ${networks% })"
else ko pc-tenant "container « $pc » label « $labels »; networks « $networks » « $netlabel »"; fi

# 7. Two at most here: a second member starts, a third is refused, without a queue.
second=$(as $operator -X POST "$api/me/machine/start" -d '{}')
refused=$(sidecar POST /pcs/start "{\"identity\":\"$third\"}")
if echo "$second" | grep -q '"state":"running"' && echo "$refused" | grep -q '^409 .*"busy": *true'; then ok pc-busy "the second member's computer starts; the third is refused (409, busy), no queue"
else ko pc-busy "second « ${second:0:160} »; third « ${refused:0:160} »"; fi
as $operator -X POST "$api/me/machine/stop" -d '{}' >/dev/null

# 8. Idle for its time (90 s here), it stops by itself; its files stay.
docker exec "$pc" sh -c 'echo kept > /home/user/witness.txt' 2>/dev/null
stopped=0
for _ in $(seq 1 40); do
  [ -z "$(computer_of $owner)" ] && { stopped=1; break; }
  sleep 5
done
state=$(as $owner "$api/me/machine")
users=$(docker exec $project-machines sh -c 'cat /users/*/witness.txt 2>/dev/null' 2>/dev/null)
if [ "$stopped" = 1 ] && echo "$state" | grep -q '"state":"stopped"' && [ "$users" = kept ]; then ok pc-idle "idle past its time, the computer stopped by itself; the member's files stay"
else ko pc-idle "stopped $stopped; state « ${state:0:160} »; files « $users »"; fi

# 9. The Date header reaches the page through the proxy and the gateway (the instance's clock, for the automations' times).
dated=$(curl -s -m 20 -o /dev/null -D - -H "x-forwarded-email: $owner" "$api/automations" | grep -ci '^date: ')
if [ "$dated" = 1 ]; then ok automations-date-header "GET /automations through the gateway carries one Date header"
else ko automations-date-header "$dated Date header(s) on GET /automations"; fi
exit $failed
