# The sandbox probe of the rehearsal, run by a real agent turn through the
# engine's bash tool, inside the sandbox, in its channel's folder. It carries no
# canary itself: it looks for the pattern CANAR[Y]_ (a regex that never matches
# its own text). Each step ends with DONE<n>; the rehearsal fails on any LEAK,
# OPEN or CROSS line, and on any missing DONE or WITNESS line.
set +e
here=$(pwd)

echo "STEP1 canaries in every place this command can read, one root at a time"
# Two kinds of canaries, planted at run time: CANAR[Y]_SECRET_* where the instance
# keeps its secrets (finding one is a LEAK), CANAR[Y]_SEARCHED_* where reading is
# allowed (finding one proves the search really read there: SEEN). Each root is
# walked on its own, nested mounts included (/run/secrets, /state/mcp-auth): no
# -xdev. What counts is what grep really OPENED, never what find listed (access(2)
# ignores Landlock). Binary files are searched too (SQLite). A walk cut short by a
# limit or a timeout says so (TRUNCATED, TIMEOUT): the proof fails on it.
# The image's own trees (/usr, /app, /lib*, /bin, /sbin) hold no canary.
LIMIT=200000
list=$(mktemp)
raw=$(mktemp)
total=0
for root in /state /data /run /root /home /tmp /dev/shm /opt /etc /var /srv /mnt /media; do
  [ -e "$root" ] || continue
  timeout 60 find "$root" -type f > "$raw" 2>/dev/null
  [ $? = 124 ] && echo "TIMEOUT find $root"
  grep -v -e "^$here/" -e "^$list\$" -e "^$raw\$" "$raw" > "$list"
  listed=$(wc -l < "$list")
  if [ "$listed" -gt "$LIMIT" ]; then echo "TRUNCATED $root $listed file(s) listed, more than $LIMIT"; continue; fi
  # grep -c prints one line per file it opened, unreadable ones none.
  counts=$(timeout 120 xargs -d '\n' -r grep -a -c -H 'CANAR[Y]_\(SECRET\|SEARCHED\)_' < "$list" 2>/dev/null)
  [ $? = 124 ] && echo "TIMEOUT grep $root"
  opened=$(printf '%s' "$counts" | grep -c . || true)
  total=$((total + opened))
  echo "READ $root listed $listed opened $opened"
  printf '%s\n' "$counts" | grep -a -v ':0$' | sed 's/:[0-9]*$//' | grep . | while IFS= read -r file; do
    grep -a -o 'CANAR[Y]_\(SECRET\|SEARCHED\)_[A-Za-z0-9_]*' "$file" 2>/dev/null | sort -u | while IFS= read -r hit; do
      case "$hit" in
        *CANAR[Y]_SECRET_*) echo "LEAK file $file $hit" ;;
        *) echo "SEEN file $file $hit" ;;
      esac
    done
  done
done
rm -f "$list" "$raw"
if [ "$total" -gt 0 ]; then echo "DONE1 $total file(s) opened"; else echo "NOREAD1 no file could be opened at all"; fi

echo "STEP2 canaries in the environment and in every process's environment and command line"
env | grep -o 'CANAR[Y]_SECRET_[A-Za-z0-9_]*' | sed 's/^/LEAK env /'
echo "environment names: $(env | cut -d= -f1 | sort | tr '\n' ' ')"
for f in /proc/[0-9]*/environ /proc/[0-9]*/cmdline; do
  timeout 2 tr '\0' '\n' < "$f" 2>/dev/null | grep -o 'CANAR[Y]_SECRET_[A-Za-z0-9_]*' | sed "s#^#LEAK $f #"
done
# Secrets by name in any process's environment (a model key, any secret): the
# name only, never the value, which this output would carry to the logs.
for f in /proc/[0-9]*/environ; do
  timeout 2 tr '\0' '\n' < "$f" 2>/dev/null | grep -E -o '^(SCW_GENAPI_KEY|VLLM_API_KEY|[A-Z_]*SECRET[A-Z_]*|CANAR[Y]_SECRET_[A-Z_]*)=' | sed "s#^#LEAK $f #"
done
echo "inherited file descriptors: $(ls -l /proc/self/fd 2>/dev/null | tail -n +2 | awk '{print $NF}' | tr '\n' ' ')"
echo DONE2

echo "STEP3 secrets by their paths"
for p in /run/mndt-launch/web-token /run/mndt-launch/web.log /state/web-token /run/secrets/mndt-gateway /run/secrets/mndt-proxy-signature \
         /state/grants.json /state/tokens.json /state/model.env /state/state.json /state/connectors /state/home/sessions /root \
         /state/tools/facts.md /opt/mndt-tools/facts.md /state/mcp-auth /tmp/dsh-subprocess-other/stdout /tmp/dsh-run-other/note \
         /proc/1/environ /dev/shm /dev/pts; do
  if [ -d "$p" ]; then ls "$p" >/dev/null 2>&1 && echo "LEAK readable $p"
  elif [ -e "$p" ] || [ -L "$p" ]; then head -c 1 "$p" >/dev/null 2>&1 && echo "LEAK readable $p"
  else
    # Absent, or its folder unreadable: said, never skipped in silence.
    echo "UNSEEN $p"
  fi
done
echo DONE3

echo "STEP4 internal ports without credentials"
timeout 60 node -e '
const urls = []
for (const base of ["http://127.0.0.1:3111", "http://workbench:3111", "http://127.0.0.1:8795", "http://workbench:8795"]) {
  for (const path of ["/", "/api/session", "/mndt-api/me", "/me", "/state", "/approvals", "/channels", "/agents", "/team/index.html"]) urls.push(base + path)
}
const run = async () => {
  for (const url of urls) {
    try {
      const answer = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: "manual" })
      const text = await answer.text()
      // A static team-page file holds no data; anything else must be refused.
      const fine = [401, 403, 404].includes(answer.status) || (url.endsWith("/team/index.html") && answer.status === 200 && !/CANAR[Y]_/.test(text))
      if (!fine) console.log(`OPEN ${url} ${answer.status}`)
    } catch (error) { /* refused or unreachable: closed */ }
  }
}
run().then(() => { console.log("ports checked") })
'
echo DONE4

echo "STEP5 other channels and a link out of this one"
for d in /state/channels/*/files; do
  [ "$d" = "$here" ] && continue
  ls "$d" >/dev/null 2>&1 && echo "CROSS readable $d"
  ( : > "$d/written-by-another-channel" ) 2>/dev/null && echo "CROSS writable $d"
done
ln -sf /state/web-token "$here/link-to-token" 2>/dev/null
head -c 1 "$here/link-to-token" >/dev/null 2>&1 && echo "CROSS through a link to /state/web-token"
rm -f "$here/link-to-token"
echo DONE5

echo "STEP6 the witnesses: an agent still works in its own channel"
# Each one prints WITNESS <name> when it works, WITNESS-KO <name> otherwise: the
# proof compares the series with and without the allow-list.
w() {
  name=$1; shift
  if ! command -v "$1" >/dev/null 2>&1; then echo "WITNESS-ABSENT $name"; return; fi
  if out=$("$@" 2>&1); then echo "WITNESS $name"; else echo "WITNESS-KO $name $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)"; fi
}
w own-channel-file sh -c 'echo "probe witness" > witness.txt && [ "$(cat witness.txt)" = "probe witness" ]'
w ls-usr ls /usr/bin
w node node -e 'process.exit(0)'
w python3 python3 --version
w tmpdir sh -c 'echo t > "${TMPDIR:-/tmp}/probe-witness" && cat "${TMPDIR:-/tmp}/probe-witness"'
w home sh -c 'echo h > "$HOME/.probe-witness" && cat "$HOME/.probe-witness"'
w git-init sh -c 'rm -rf witness-repo && git init -q witness-repo'
w git-commit sh -c 'cd witness-repo && echo x > f && git add f && git -c user.name=p -c user.email=p@p commit -qm w'
w git-status sh -c 'cd witness-repo && git status --short'
w git-log sh -c 'cd witness-repo && git log --oneline -1'
w curl curl --version
w npm npm --version
w npm-cache sh -c 'command -v npm >/dev/null || exit 0; npm config get cache && npm ls -g --depth=0'
w pip python3 -m pip --version
w dev-stdout sh -c 'echo x > /dev/stdout'
w process-substitution bash -c 'cat <(true)'
w os-cpus node -e 'if (require("os").cpus().length < 1) process.exit(1)'
rm -rf witness-repo witness.txt
echo DONE6
