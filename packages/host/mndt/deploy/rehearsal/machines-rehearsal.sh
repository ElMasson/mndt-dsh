# Sourced by rehearse.sh and rehearse-update.sh: the members' computers in a
# rehearsal (eighth jump). Their two images (build-machines.sh), the settings a
# rehearsal gives the sidecar, and what the cleanup takes away.
#   MACHINES_IMAGE, PC_IMAGE   the images (default: the eighth jump's tags)
#   REHEARSAL_RUNTIME          runsc (a machine with gVisor) or runc (default:
#                              runsc when Docker knows it, else runc, said twice)
machines_image=${MACHINES_IMAGE:-mndt-machines:eighth-jump}
pc_image=${PC_IMAGE:-mndt-pc:eighth-jump}
if [ -z "${REHEARSAL_RUNTIME:-}" ]; then
  if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"runsc"'; then REHEARSAL_RUNTIME=runsc; else REHEARSAL_RUNTIME=runc; fi
fi

# The rehearsal's space: its own name (the project's), never the tenant's slug.
# The computers, their networks, the egress proxy and their labels are renamed
# to it in the rendered compose, so that no rehearsal script can stop or remove
# an instance's computers or its egress by a fixed name, even on its host.
machines_space=${MACHINES_SPACE:-$project}

# The rendered compose, as a rehearsal runs it: this space's names, two
# computers at most (the third member is refused), idle after 90 s (one stops
# by itself during the run), and under runc only when Docker has no gVisor,
# said twice as the sidecar requires.
machines_rehearsal_compose() { # <compose file>
  local extra='      MNDT_MACHINE_MAX: "2"\n      MNDT_MACHINE_IDLE_SECONDS: "90"\n      MNDT_MACHINE_REAP_SECONDS: "5"' guard=''
  [ "$REHEARSAL_RUNTIME" = runc ] && extra="$extra"'\n      MNDT_MACHINE_ALLOW_RUNC: "1"' && guard='\n      MNDT_GUARD_ALLOW_RUNC: "1"'
  sed -i -e "s#^      MNDT_MACHINE_RUNTIME: runsc\$#      MNDT_MACHINE_RUNTIME: $REHEARSAL_RUNTIME\n$extra#" \
    -e "s#^      PC_TENANT: .*#      PC_TENANT: $machines_space#" \
    -e "s#^      PC_PREFIX: .*#      PC_PREFIX: $machines_space-pc-#" \
    -e "s#^      PC_NET_PREFIX: .*#      PC_NET_PREFIX: $machines_space-pcnet-#" \
    -e "s#^      EGRESS_PROXY: .*#      EGRESS_PROXY: $machines_space-egress#" \
    -e "s#^    container_name: mndt-.*-egress\$#    container_name: $machines_space-egress#" \
    -e "s#^      MNDT_GUARD_SPACE: .*#      MNDT_GUARD_SPACE: $machines_space$guard#" \
    -e "s#^      MNDT_GUARD_PC_PREFIX: .*#      MNDT_GUARD_PC_PREFIX: $machines_space-pc-#" \
    -e "s#^      MNDT_GUARD_NET_PREFIX: .*#      MNDT_GUARD_NET_PREFIX: $machines_space-pcnet-#" \
    -e "s#^      MNDT_GUARD_EGRESS: .*#      MNDT_GUARD_EGRESS: $machines_space-egress#" "$1"
}

# Both images must be there: the socket proxy refuses every pull, by design.
machines_images_present() {
  local missing=""
  for wanted in "$machines_image" "$pc_image"; do docker image inspect "$wanted" >/dev/null 2>&1 || missing="$missing $wanted"; done
  [ -z "$missing" ] || { echo "KO  machines-images  missing:$missing (deploy/build-machines.sh --tag ...)"; return 1; }
}

# The sidecar, the proxies, the computers and their networks of this
# rehearsal's own space, never another container: by its name and its label.
machines_cleanup() {
  docker rm -f "$project-machines" "$project-docker-guard" "$machines_space-egress" >/dev/null 2>&1
  for pc in $(docker ps -aq --filter "label=mndt.tenant=$machines_space" --filter "name=$machines_space-pc-"); do docker rm -f "$pc" >/dev/null 2>&1; done
  for net in $(docker network ls -q --filter "label=mndt.tenant=$machines_space" --filter "name=$machines_space-pcnet-"); do docker network rm "$net" >/dev/null 2>&1; done
  docker network rm "${project}_machines" "${project}_docker-guard-net" "${project}_egress-out" >/dev/null 2>&1
}

# A connector reads neither the machine service's token nor, unless it is
# approvals or machine, the gateway's secret: each connector's script as the
# workbench renders it (its Landlock grants), its command replaced by reading
# both files, run inside the running workbench. The workbench itself reads both
# (the witness: otherwise a refusal would prove nothing).
connector_secrets_check() { # <data dir> <workbench container>
  local data=$1 container=$2 line verdict="" ok=1 others=0 server script
  local witness; witness=$(docker exec "$container" sh -c 'test -r /run/secrets/mndt-machines && test -r /run/secrets/mndt-gateway && echo readable')
  while IFS=$'\t' read -r server script; do
    [ -z "$server" ] && continue
    line=$(docker exec "$container" sh -c "$script" 2>&1 | tr '\n' ' ')
    verdict="$verdict $server: ${line% };"
    case $server in
      approvals|machine) [[ $line == *"refused /run/secrets/mndt-machines"*"read /run/secrets/mndt-gateway"* ]] || ok=0 ;;
      *) others=$((others + 1)); [[ $line == *"refused /run/secrets/mndt-machines"*"refused /run/secrets/mndt-gateway"* ]] || ok=0 ;;
    esac
  done < <(python3 - "$data/home/profiles/web/cordis.patch.yml" <<'PY'
import sys, yaml
probe = "sh -c 'for f in /run/secrets/mndt-machines /run/secrets/mndt-gateway; do if cat \"$f\" >/dev/null 2>&1; then echo \"read $f\"; else echo \"refused $f\"; fi; done'"
for block in yaml.safe_load(open(sys.argv[1])) or []:
    for row in block.get('insert') or []:
        config = row.get('config') or {}
        script = (config.get('args') or ['', ''])[1]
        if 'exec "$@" ' not in script: continue
        print(config.get('serverName', '?') + '\t' + script[:script.index('exec "$@" ') + len('exec "$@" ')] + probe)
PY
)
  if [ "$witness" = readable ] && [ "$ok" = 1 ] && [ "$others" -ge 1 ] && [[ $verdict == *approvals:* ]] && [[ $verdict == *machine:* ]]; then
    echo "OK  connector-no-secrets  the workbench reads both; under each connector's Landlock grants:$verdict"
  else
    echo "KO  connector-no-secrets  workbench « ${witness:-not readable} »;$verdict (the others must read neither; approvals and machine the gateway's secret only)"
    return 1
  fi
}
