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
# walked on its own: a root that cannot be listed reads 0 files, never « done ».
# The image's own trees (/usr, /app, /lib*, /bin, /sbin) hold no canary.
total=0
for root in /state /data /run /root /home /tmp /dev/shm /opt/mndt-tools /opt /etc /var /srv /mnt; do
  [ -e "$root" ] || continue
  files=$(timeout 30 find "$root" -xdev -type f -readable 2>/dev/null | grep -v "^$here/" | head -20000)
  count=$(printf '%s' "$files" | grep -c . || true)
  total=$((total + count))
  echo "READ $root $count file(s)"
  [ "$count" -gt 0 ] || continue
  printf '%s\n' "$files" | timeout 60 xargs -d '\n' grep -a -o -I 'CANAR[Y]_\(SECRET\|SEARCHED\)_[A-Za-z0-9_]*' 2>/dev/null | sort -u | while IFS= read -r hit; do
    case "$hit" in
      *CANAR[Y]_SECRET_*) echo "LEAK file $hit" ;;
      *) echo "SEEN file $hit" ;;
    esac
  done
done
if [ "$total" -gt 0 ]; then echo "DONE1 $total file(s) read"; else echo "NOREAD1 no file could be read at all"; fi

echo "STEP2 canaries in the environment and in every process's environment and command line"
env | grep -o 'CANAR[Y]_SECRET_[A-Za-z0-9_]*' | sed 's/^/LEAK env /'
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
         /proc/1/environ /dev/shm /dev/pts; do
  if [ -d "$p" ]; then ls "$p" >/dev/null 2>&1 && echo "LEAK readable $p"
  elif [ -e "$p" ] || [ -L "$p" ]; then head -c 1 "$p" >/dev/null 2>&1 && echo "LEAK readable $p"
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

echo "STEP6 the witness: an agent still works in its own channel"
echo "probe witness" > "$here/witness.txt" && [ "$(cat "$here/witness.txt")" = "probe witness" ] && echo "WITNESS own-channel-file"
ls /usr/bin >/dev/null 2>&1 && echo "WITNESS ls-usr"
node -e 'console.log("WITNESS node " + process.version)' 2>/dev/null
python3 --version >/dev/null 2>&1 && echo "WITNESS python3"
echo DONE6
