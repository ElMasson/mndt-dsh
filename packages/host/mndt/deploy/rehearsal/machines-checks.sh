#!/usr/bin/env bash
# The members' computers (« Mon ordinateur », eighth jump), checked on a running
# rehearsal stack: the sidecar, the socket proxy, the egress proxy and the
# computers it starts, through the API and the gateway as on the instance.
#
#   machines-checks.sh <project> <owner> <operator> [space]
#
# The space is the rehearsal's own (machines-rehearsal.sh: the project's name by
# default), never an instance's: its computers, networks and egress carry it.
# The stack's override sets MNDT_MACHINE_MAX=2 (the third member is refused),
# MNDT_MACHINE_IDLE_SECONDS=90 (a computer stops by itself) and, on a machine
# without gVisor, MNDT_MACHINE_RUNTIME=runc with MNDT_MACHINE_ALLOW_RUNC=1: then
# pc-runtime says so, and the gVisor proof is machines-proof.sh under runsc.
# Each check prints one OK or KO line; the exit code is 1 when one is KO.
set -uo pipefail
project=${1:?usage: machines-checks.sh <project> <owner> <operator>}
owner=${2:?owner}; operator=${3:?operator}; space=${4:-$project}
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
computer_of() { docker ps --filter "label=mndt.member=$1" --filter "label=mndt.tenant=$space" --format '{{.Names}}' | head -1; }

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
if [ "$runtime" = runsc ] && { echo "$kernel" | grep -qi gvisor || echo "$booted" | grep -qi gvisor; }; then ok pc-runtime "runsc: the computer's kernel is gVisor's (uname -r $kernel)"
elif [ "$runtime" = runc ] && [ "$allowed" = runc/1 ]; then ok pc-runtime "runc, said twice (MNDT_MACHINE_RUNTIME=runc, MNDT_MACHINE_ALLOW_RUNC=1): a rehearsal without gVisor; the gVisor proof is machines-proof.sh under runsc"
else ko pc-runtime "runtime « $runtime », sidecar « $allowed », uname -r « $kernel », dmesg « ${booted:0:60} »"; fi

# 4. Nothing of the space inside, and no way out but the public web through its
# proxy: every address of EGRESS_DENY tried (the instance's public one, the
# H100), the metadata, the guard of the Docker socket and the machine service.
inside=$(docker exec "$pc" sh -c 'test -e /state && echo state; test -S /var/run/docker.sock && echo socket; env | cut -d= -f1 | grep -E "KEY|SECRET|PASSWORD|TOKEN" | grep -vxE "AGENT_TOKEN|DESKTOP_TOKEN"; cat /run/secrets/mndt-machines 2>/dev/null && echo machines-token' 2>&1)
deny=$(docker exec "$space-egress" sh -c 'echo "$EGRESS_DENY"' 2>/dev/null)
public_ip=${deny%%,*}
refusals=""
for target in "http://$public_ip/" http://51.159.151.86:8000/v1/models http://169.254.169.254/latest/meta-data/ http://169.254.42.42/conf \
              http://docker-guard:2375/version http://machines-api:8796/pcs http://workbench:8795/health; do
  refusals="$refusals $(docker exec "$pc" curl -s -o /dev/null -m 15 -w '%{http_code}' "$target" 2>/dev/null)"
done
direct=$(docker exec "$pc" curl -s -o /dev/null -m 10 --noproxy '*' -w '%{http_code}' http://1.1.1.1/ 2>/dev/null)
if [ -z "$inside" ] && [ -n "$public_ip" ] && [ "$(echo $refusals)" = "403 403 403 403 403 403 403" ] && [ "$direct" = 000 ]; then
  ok pc-isolation "no /state, no socket, no key nor the machine token inside; through its proxy, refused (403 each): the instance's public address ($public_ip), the H100, the two metadata services, the Docker guard, the machine service, the API; no route out without the proxy"
else ko pc-isolation "inside « $(echo $inside) »; public $public_ip; refusals:$refusals (7 × 403 expected: public, H100, metadata ×2, guard, machines, API); direct $direct (000 expected)"; fi

# 5. Acting on it goes through the Docker guard: a command (exec) that reaches a
# public page through the egress proxy, and a browser call (exec -i, stdin).
terminal=$(sidecar POST /pcs/act "{\"identity\":\"$owner\",\"kind\":\"terminal\",\"timeoutSeconds\":60,\"command\":\"echo pc-ok; id -u; pwd; curl -s -o /dev/null -m 30 -w web=%{http_code} https://example.org/\"}")
browser=$(sidecar POST /pcs/act "{\"identity\":\"$owner\",\"kind\":\"browser\",\"op\":\"status\"}")
if echo "$terminal" | grep -q '^200 .*pc-ok\\n1000\\n/home/user' && echo "$terminal" | grep -qE 'web=(200|301|302)' && echo "$browser" | grep -qE '^200 .*"ok": *true'; then
  ok pc-act-through-proxy "a command ran as 1000 in /home/user and a public page answered through the egress proxy; the browser agent answered (stdin through docker exec -i): the Docker guard carries both"
else ko pc-act-through-proxy "terminal « ${terminal:0:240} »; browser « ${browser:0:200} »"; fi

# 6. Its space's names and labels, never another space's.
labels=$(docker inspect -f '{{index .Config.Labels "mndt.tenant"}}' "$pc" 2>/dev/null)
networks=$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$pc" 2>/dev/null)
netlabel=$(docker network inspect -f '{{index .Labels "mndt.tenant"}} {{.Internal}}' $networks 2>/dev/null | head -1)
if [ "$labels" = "$space" ] && [[ $pc == "$space"-pc-* ]] && [[ $networks == "$space"-pcnet-* ]] && [ "$netlabel" = "$space true" ]; then
  ok pc-tenant "the computer and its internal network carry mndt.tenant=$space and this space's names ($pc, ${networks% })"
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

# 10. A machine service gone bad gets nothing more from Docker: from its own
# container, with its own Docker client (DOCKER_HOST, the guard), each of these
# is refused, and the workbench still runs.
attempts=""
try() { docker exec $project-machines sh -c "$1" >/dev/null 2>&1 && attempts="$attempts PASSED:$2" || attempts="$attempts refused:$2"; }
try 'docker run -d --rm --privileged --name escape-1 alpine:3.20 true' privileged
try "docker run -d --rm --runtime runsc --read-only --cap-drop ALL -v /:/h --label mndt.tenant=$space --name $space-pc-escape-2 mndt-pc:eighth-jump" bind-root
try "docker rm -f $project-workbench" delete-workbench
try "docker network connect ${project}_front $space-egress" connect-front
try "docker exec $project-gateway id" exec-gateway
try 'docker volume ls' volumes
try 'docker pull alpine:3.20' pull
alive=$(docker inspect -f '{{.State.Running}}' $project-workbench 2>/dev/null)
refusals=$(docker logs $project-docker-guard 2>&1 | grep -c '^docker-guard: refused')
if [[ $attempts != *PASSED* ]] && [ "$alive" = true ] && [ "$refusals" -ge 6 ]; then
  ok guard-refusals "from the machine service's own container, refused by its Docker guard:$attempts; the workbench still runs; $refusals refusal(s) in the guard's log"
else ko guard-refusals "attempts:$attempts; workbench running « $alive »; $refusals refusal(s) logged"; fi

# 9. The Date header reaches the page through the proxy and the gateway (the instance's clock, for the automations' times).
dated=$(curl -s -m 20 -o /dev/null -D - -H "x-forwarded-email: $owner" "$api/automations" | grep -ci '^date: ')
if [ "$dated" = 1 ]; then ok automations-date-header "GET /automations through the gateway carries one Date header"
else ko automations-date-header "$dated Date header(s) on GET /automations"; fi
exit $failed
