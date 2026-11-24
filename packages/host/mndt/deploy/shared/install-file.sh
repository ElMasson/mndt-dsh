# shellcheck shell=bash
# One rule for every file a tenant script puts where a container reads it (the
# tools folder, the gateway's code and its connector machinery): written beside
# the old one, then renamed over it, so a server started meanwhile, a gateway
# restarting, or a check running never reads a half-written file (cp rewrote
# the file in place). Mode 0644 unless told otherwise, owned by root when run
# as root (the workbench and the gateway run as root and mount these folders
# read-only).
#
#   . "<deploy>/shared/install-file.sh"
#   install_file <source> <destination file> [mode]
#
# Returns 1 on failure, with the .tmp removed and the old file whole; the
# caller decides whether to stop (`install_file … || exit 1`).
install_file() {
  local src=$1 dst=$2 mode=${3:-0644}
  local tmp="$dst.tmp.$$"
  if install -m "$mode" "$src" "$tmp" && { [ "$(id -u)" != 0 ] || chown 0:0 "$tmp"; } && mv -f "$tmp" "$dst"; then
    return 0
  fi
  rm -f "$tmp"
  echo "could not install $dst: left as it was" >&2
  return 1
}
