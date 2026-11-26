#!/usr/bin/env bash
# The members' computers under gVisor, proved on a machine that has runsc
# (mndt-repetition): the tenant's own compose, rendered by create-tenant.sh into
# a temporary root, its three services only (the sidecar, the Docker guard, the
# egress proxy), then one computer started, acted on and stopped by the sidecar
# itself. No workbench, no model, nothing of an instance.
#
#   machines-proof.sh [--runtime runsc|runc]
#
# Needs: Docker with runsc registered (`docker info` lists it), the images
# mndt-machines and mndt-pc (MACHINES_IMAGE, PC_IMAGE; default the eighth jump's
# tags, deploy/build-machines.sh), and python3 with PyYAML: the three services
# are created from the rendered compose with plain `docker run` (as up-run.mjs
# does for the rehearsals), so neither the Compose plugin nor Node is needed. The full rehearsal
# (rehearse.sh) runs elsewhere under runc; this proof is the gVisor half.
# Every check prints one OK or KO line, then the total; exit 1 when one is KO.
set -uo pipefail
runtime=runsc
while [ $# -gt 0 ]; do
  case $1 in
    --runtime) runtime=$2; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
here=$(cd "$(dirname "$0")" && pwd)
deploy=$(cd "$here/.." && pwd)
project=mndt-proof
# The images, this proof's own space (its names and labels, never an instance's)
# and its cleanup: the rehearsals' helper, with this proof's runtime.
REHEARSAL_RUNTIME=$runtime
. "$here/machines-rehearsal.sh"
member=proof@datanalysis.re
ok=0; ko=0
pass() { echo "OK  $1  $2"; ok=$((ok + 1)); }
fail() { echo "KO  $1  $2"; ko=$((ko + 1)); }
root=$(mktemp -d "${TMPDIR:-/tmp}/mndt-machines-proof-XXXX")
cleanup() {
  # KEEP=1 leaves the services running for inspection (their logs).
  if [ "${KEEP:-0}" != 1 ]; then
    machines_cleanup
    docker network rm mndt-proof-edge >/dev/null 2>&1
  fi
  echo "TOTAL ok=$ok ko=$ko"
  echo "proof root: $root"
  [ "$ko" = 0 ]
}
trap 'cleanup; exit $?' EXIT

if docker info --format '{{json .Runtimes}}' | grep -q "\"$runtime\""; then pass runtime-registered "Docker knows the runtime $runtime"
else fail runtime-registered "Docker does not list $runtime (docker info): install it first"; exit 1; fi
for wanted in "$machines_image" "$pc_image"; do
  docker image inspect "$wanted" >/dev/null 2>&1 || { fail images "missing $wanted (deploy/build-machines.sh)"; exit 1; }
done

# The tenant's compose, rendered as on the instance, then pointed at this root.
mkdir -p "$root/root"; printf 'secret' > "$root/root/entra_client_secret"
MNDT_ROOT=$root bash "$deploy/create-tenant.sh" datanalysis equipe.datanalysis.re --owner duke@datanalysis.re \
  --client-id 00000000-0000-0000-0000-000000000000 --client-secret-file /root/entra_client_secret \
  --traefik-network mndt-proof-edge --machines-image "$machines_image" --pc-image "$pc_image" --no-docker >/dev/null \
  || { fail render "create-tenant.sh failed"; exit 1; }
sed -e "s#/data/mndt/datanalysis/live#$root/data/mndt/datanalysis/live#g" -e "s#/opt/mndt/datanalysis#$root/opt/mndt/datanalysis#g" \
    -e "s#/etc/mndt/datanalysis#$root/etc/mndt/datanalysis#g" \
    "$root/opt/mndt/datanalysis/docker-compose.yml" > "$root/compose.yml"
machines_rehearsal_compose "$root/compose.yml"
chmod a+r "$root/etc/mndt/datanalysis/machines_token"
# The three services, created from the rendered compose: image, environment,
# volumes, user, read-only root, fixed name, command, networks and aliases.
python3 - "$root/compose.yml" $project <<'UP' || { fail up "the three services did not start"; exit 1; }
import subprocess, sys, yaml
compose, project = sys.argv[1], sys.argv[2]
spec = yaml.safe_load(open(compose))
def docker(*args):
    subprocess.run(['docker', *args], check=True, stdout=subprocess.DEVNULL)
for name, net in (spec.get('networks') or {}).items():
    if (net or {}).get('external'): continue
    if subprocess.run(['docker', 'network', 'inspect', f'{project}_{name}'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
        docker('network', 'create', *(['--internal'] if (net or {}).get('internal') else []), f'{project}_{name}')
for name in ['docker-guard', 'egress', 'machines']:
    service = spec['services'][name]
    nets = service.get('networks') or []
    nets = [(n, {}) for n in nets] if isinstance(nets, list) else [(n, v or {}) for n, v in nets.items()]
    container = service.get('container_name', f'{project}-{name}')
    first, *others = nets
    args = ['create', '--name', container, '--network', f'{project}_{first[0]}', '--network-alias', name]
    args += [a for alias in first[1].get('aliases', []) for a in ('--network-alias', alias)]
    for key, value in (service.get('environment') or {}).items(): args += ['-e', f'{key}={value}']
    for volume in service.get('volumes') or []: args += ['-v', volume]
    if 'user' in service: args += ['--user', str(service['user'])]
    if service.get('read_only'): args += ['--read-only']
    for cap in service.get('cap_drop') or []: args += ['--cap-drop', cap]
    for option in service.get('security_opt') or []: args += ['--security-opt', option]
    entrypoint = service.get('entrypoint') or []
    if entrypoint: args += ['--entrypoint', entrypoint[0]]
    args += ['--restart', 'no', service['image'], *entrypoint[1:], *(service.get('command') or [])]
    subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    docker(*args)
    for other, extra in others:
        docker('network', 'connect', '--alias', name, *[a for alias in extra.get('aliases', []) for a in ('--alias', alias)], f'{project}_{other}', container)
    docker('start', container)
UP
pass up "the sidecar, its Docker guard and the egress proxy run, from the tenant's own compose"

# The sidecar, from a throwaway container on the machines network, with the token.
sidecar() { # <method> <path> [json]
  docker run --rm --network ${project}_machines -v "$root/etc/mndt/datanalysis/machines_token:/token:ro" node:22-bookworm-slim \
    node -e "
const [method, path, body] = process.argv.slice(1)
const token = require('node:fs').readFileSync('/token', 'utf8').trim()
fetch('http://machines-api:8796' + path, { method, headers: { 'x-machine-token': token, 'content-type': 'application/json' }, ...(body ? { body } : {}), signal: AbortSignal.timeout(170000) })
  .then(async r => console.log(r.status + ' ' + (await r.text()).slice(0, 3000)), e => console.log('000 ' + e.message))" "$@"
}
for _ in $(seq 1 30); do [ "$(sidecar GET /pcs | cut -d' ' -f1)" = 200 ] && break; sleep 2; done

started=$(sidecar POST /pcs/start "{\"identity\":\"$member\"}")
pc=$(docker ps --filter "label=mndt.member=$member" --filter "label=mndt.tenant=$machines_space" --format '{{.Names}}' | head -1)
if [[ $started == 200* ]] && [ -n "$pc" ]; then pass pc-start "the member's computer runs: $pc"; else fail pc-start "${started:0:200}"; fi

used=$(docker inspect -f '{{.HostConfig.Runtime}}' "$pc" 2>/dev/null)
kernel=$(docker exec "$pc" uname -r 2>/dev/null)
booted=$(docker exec "$pc" sh -c 'dmesg 2>/dev/null | head -3' 2>/dev/null | tr '\n' ' ')
if [ "$runtime" = runsc ]; then
  # gVisor names its kernel (« 4.19.0-gvisor » on 26/11); dmesg says nothing to uid 1000.
  if [ "$used" = runsc ] && { echo "$kernel" | grep -qi gvisor || echo "$booted" | grep -qi gvisor; }; then pass gvisor "runtime runsc; the computer's kernel is gVisor's: uname -r $kernel"
  else fail gvisor "runtime « $used », uname -r « $kernel », dmesg « ${booted:0:80} »"; fi
else
  [ "$used" = runc ] && pass gvisor "runc, said twice: not a gVisor proof (run with --runtime runsc on a machine that has it)" || fail gvisor "runtime « $used »"
fi

# Through the sidecar (docker exec via the Docker guard): a command as the member, the egress refusals, the public web.
terminal=$(sidecar POST /pcs/act "{\"identity\":\"$member\",\"kind\":\"terminal\",\"timeoutSeconds\":90,\"command\":\"id -u; pwd; test -e /state && echo STATE; test -S /var/run/docker.sock && echo SOCKET; curl -s -o /dev/null -m 15 -w 'meta=%{http_code} ' http://169.254.169.254/; curl -s -o /dev/null -m 15 -w 'scw=%{http_code} ' http://169.254.42.42/conf; curl -s -o /dev/null -m 15 -w 'h100=%{http_code} ' http://51.159.151.86:8000/v1/models; curl -s -o /dev/null -m 15 -w 'guard=%{http_code} ' http://docker-guard:2375/version; curl -s -o /dev/null -m 15 -w 'api=%{http_code} ' http://machines-api:8796/pcs; curl -s -o /dev/null -m 15 -w 'direct=%{http_code} ' --noproxy '*' http://1.1.1.1/; curl -s -o /dev/null -m 30 -w 'web=%{http_code}' https://example.org/\"}")
echo "    $(echo "$terminal" | grep -o '"stdout": *"[^"]*"')"
if [[ $terminal == 200* ]] && echo "$terminal" | grep -q '1000\\n/home/user' && ! echo "$terminal" | grep -qE 'STATE|SOCKET' \
   && echo "$terminal" | grep -q 'meta=403 scw=403 h100=403 guard=403 api=403' && echo "$terminal" | grep -q 'direct=000'; then
  pass pc-isolation "a command runs as 1000 in /home/user; no /state, no socket; refused by the egress proxy (403 each): both metadata services, the H100, the Docker guard, the machine service; no route out without it"
else fail pc-isolation "${terminal:0:300}"; fi
if echo "$terminal" | grep -qE 'web=(200|301|302)'; then pass pc-web "the public web answers through the egress proxy (example.org)"
else echo "NOTE pc-web  the public web did not answer (${terminal:0:120}): this machine may have no way out; not counted"; fi
browser=$(sidecar POST /pcs/act "{\"identity\":\"$member\",\"kind\":\"browser\",\"op\":\"status\"}")
if [[ $browser == 200* ]] && echo "$browser" | grep -qE '"ok": *true'; then pass pc-browser "the browser agent answers (docker exec -i, stdin, through the Docker guard)"
else fail pc-browser "${browser:0:200}"; fi

codes=""
for route in /capture /browsers/start /desktops/start; do codes="$codes $(sidecar POST $route "{\"identity\":\"$member\",\"url\":\"https://example.org\"}" | cut -d' ' -f1)"; done
codes="$codes $(sidecar GET /sessions | cut -d' ' -f1)"
[ "$(echo $codes)" = "404 404 404 404" ] && pass pc-only "capture, session browser and desktop, sessions: 404 (MACHINES_PC_ONLY)" || fail pc-only "codes:$codes"

stopped=$(sidecar POST /pcs/stop "{\"identity\":\"$member\"}")
left=$(docker ps -q --filter "label=mndt.member=$member" | wc -l)
if [[ $stopped == 200* ]] && [ "$left" = 0 ]; then pass pc-stop "stopped on demand: no container left"; else fail pc-stop "${stopped:0:160}; $left left"; fi
