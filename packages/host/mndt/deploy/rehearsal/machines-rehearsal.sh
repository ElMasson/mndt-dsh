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

# The rendered compose, as a rehearsal runs it: two computers at most (the third
# member is refused), idle after 90 s (one stops by itself during the run), and
# under runc only when Docker has no gVisor, said twice as the sidecar requires.
machines_rehearsal_compose() { # <compose file>
  local extra='      MNDT_MACHINE_MAX: "2"\n      MNDT_MACHINE_IDLE_SECONDS: "90"\n      MNDT_MACHINE_REAP_SECONDS: "5"'
  [ "$REHEARSAL_RUNTIME" = runc ] && extra="$extra"'\n      MNDT_MACHINE_ALLOW_RUNC: "1"'
  sed -i -e "s#^      MNDT_MACHINE_RUNTIME: runsc\$#      MNDT_MACHINE_RUNTIME: $REHEARSAL_RUNTIME\n$extra#" "$1"
}

# Both images must be there: the socket proxy refuses every pull, by design.
machines_images_present() {
  local missing=""
  for wanted in "$machines_image" "$pc_image"; do docker image inspect "$wanted" >/dev/null 2>&1 || missing="$missing $wanted"; done
  [ -z "$missing" ] || { echo "KO  machines-images  missing:$missing (deploy/build-machines.sh --tag ...)"; return 1; }
}

# The sidecar, the proxies, the computers and their networks of this rehearsal's
# space (datanalysis), never another container: by name and by label.
machines_cleanup() {
  docker rm -f "$project-machines" "$project-docker-proxy" mndt-datanalysis-egress >/dev/null 2>&1
  for pc in $(docker ps -aq --filter label=mndt.tenant=datanalysis --filter name=mndt-pc-datanalysis-); do docker rm -f "$pc" >/dev/null 2>&1; done
  for net in $(docker network ls -q --filter label=mndt.tenant=datanalysis --filter name=mndt-pc-net-datanalysis-); do docker network rm "$net" >/dev/null 2>&1; done
  docker network rm "${project}_machines" "${project}_docker-proxy-net" "${project}_egress-out" >/dev/null 2>&1
}
