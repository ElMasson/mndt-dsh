#!/usr/bin/env bash
# Create or refresh one tenant of the team workbench (agentic Slack, lot 1).
#
#   create-tenant.sh <slug> <domain> --owner <email> [options]
#   create-tenant.sh datanalysis equipe.datanalysis.re --owner duke@datanalysis.re
#
# Derived from install-front.sh, with nothing of one deployment left in it.
# Every path, name and host of the tenant comes from its slug and its domain:
#   /opt/mndt/<slug>          the compose file and the gateway (APP)
#   /etc/mndt/<slug>          oauth2.cfg and its two secrets (CONF)
#   /data/mndt/<slug>/live    the state, the model environment, the tools (DATA)
# The script is idempotent: an existing secret, state or model.env is kept.
# It never writes an LLM key nor an Entra secret value it was not given: the
# model environment is created empty (mode 600) with the names to fill in.
#
# Options:
#   --owner <email>            the tenant owner (required)
#   --email-domains <d1,d2>    domains allowed to sign in (default: the domain's parent)
#   --entra-tenant <id>        Entra directory (default: DATANALYSIS's)
#   --client-id <id>           Entra application id (default: read from --client-conf)
#   --client-secret-file <f>   Entra client secret, copied once (default: /etc/oauth2-proxy/client_secret)
#   --client-conf <f>          an oauth2-proxy config to read client_id from (default: /etc/oauth2-proxy/governance.cfg)
#   --traefik-network <name>   the docker network Traefik watches (default: traefik)
#   --trusted-proxy <cidr>     where Traefik connects from (default: 172.16.0.0/12)
#   --image <image>            the workbench image (default: mndt-workbench:local)
#   --no-docker                render and install the files, start nothing
# Environment: MNDT_ROOT prefixes every absolute path (tests render into a temporary root).
set -euo pipefail

usage() { sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-1}"; }

[ $# -ge 2 ] || usage
slug=$1; domain=$2; shift 2
[[ $slug =~ ^[a-z0-9][a-z0-9-]{1,31}$ ]] || { echo "the slug is lower case, digits and dashes: $slug" >&2; exit 1; }
[[ $domain =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || { echo "not a domain: $domain" >&2; exit 1; }

owner=''; email_domains=''; entra_tenant='5ed9c3e0-522a-46fa-978a-dd6bc245d710'
client_id=''; client_secret_file=/etc/oauth2-proxy/client_secret; client_conf=/etc/oauth2-proxy/governance.cfg
traefik_network=traefik; trusted_proxy=172.16.0.0/12; image=mndt-workbench:local; docker=1
while [ $# -gt 0 ]; do
  case $1 in
    --owner) owner=$2; shift 2 ;;
    --email-domains) email_domains=$2; shift 2 ;;
    --entra-tenant) entra_tenant=$2; shift 2 ;;
    --client-id) client_id=$2; shift 2 ;;
    --client-secret-file) client_secret_file=$2; shift 2 ;;
    --client-conf) client_conf=$2; shift 2 ;;
    --traefik-network) traefik_network=$2; shift 2 ;;
    --trusted-proxy) trusted_proxy=$2; shift 2 ;;
    --image) image=$2; shift 2 ;;
    --no-docker) docker=0; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done
[[ $owner =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]] || { echo "--owner <email> is required" >&2; exit 1; }
[ -n "$email_domains" ] || email_domains=${domain#*.}

root=${MNDT_ROOT:-}
here=$(cd "$(dirname "$0")" && pwd)
app="/opt/mndt/$slug"; conf="/etc/mndt/$slug"; data="/data/mndt/$slug/live"

# Secrets first: nothing is rendered for a tenant that could not sign in.
if [ -z "$client_id" ]; then
  [ -f "$root$client_conf" ] || { echo "no --client-id and no $client_conf to read it from" >&2; exit 1; }
  client_id=$(grep -E '^client_id' "$root$client_conf" | head -1 | cut -d'"' -f2)
fi
[ -n "$client_id" ] || { echo "no client_id found" >&2; exit 1; }
mkdir -p "$root$conf" "$root$app" "$root$data"/{home,tools,mcp-auth,connectors}
chmod 755 "$root$conf"
if [ ! -f "$root$conf/client_secret" ]; then
  [ -f "$root$client_secret_file" ] || { echo "missing the Entra client secret $client_secret_file" >&2; exit 1; }
  cp "$root$client_secret_file" "$root$conf/client_secret"
fi
[ -f "$root$conf/cookie_secret" ] || openssl rand 32 > "$root$conf/cookie_secret"
chmod 400 "$root$conf/client_secret" "$root$conf/cookie_secret"
# The proxy runs as 65532; only root can hand the secrets over.
if [ "$(id -u)" = 0 ]; then chown 65532:65532 "$root$conf/client_secret" "$root$conf/cookie_secret"; fi

quoted=$(printf '%s' "$email_domains" | awk -F, '{for (i = 1; i <= NF; i++) printf "%s\"%s\"", (i > 1 ? ", " : ""), $i}')
render() {
  sed -e "s|__SLUG__|$slug|g" -e "s|__DOMAIN__|$domain|g" -e "s|__OWNER__|$owner|g" \
      -e "s|__APP__|$app|g" -e "s|__CONF__|$conf|g" -e "s|__DATA__|$data|g" \
      -e "s|__TRAEFIK_NETWORK__|$traefik_network|g" -e "s|__TRUSTED_PROXY__|$trusted_proxy|g" \
      -e "s|__IMAGE__|$image|g" -e "s|__ENTRA_TENANT__|$entra_tenant|g" \
      -e "s|__CLIENT_ID__|$client_id|g" -e "s|__EMAIL_DOMAINS__|$quoted|g" "$1"
}
render "$here/tenant/oauth2.cfg.template" > "$root$conf/oauth2.cfg"
chmod 644 "$root$conf/oauth2.cfg"
render "$here/tenant/docker-compose.yml.template" > "$root$app/docker-compose.yml"
mkdir -p "$root$app/gateway"
cp "$here/gateway/server.mjs" "$root$app/gateway/server.mjs"

# The model environment: names only, values filled in by hand (mode 600).
if [ ! -f "$root$data/model.env" ]; then
  umask 077
  cat > "$root$data/model.env" <<ENV
# LLM routes and prices of tenant $slug. Fill in, then: docker compose up -d workbench
# Scaleway Generative APIs (deepseek-v4.1-flash, glm-5.3):
SCW_SECRET_KEY=
# vLLM Qwen on the private network (http allowed there):
VLLM_BASE_URL=
# The euros per million tokens are not here: $data/prices.json (the adapters
# lane's deploy/llm/prices.json). A model without a price is refused.
ENV
  chmod 600 "$root$data/model.env"
fi
# The price grid of the agents' models, one source: deploy/llm/prices.json.
if [ ! -f "$root$data/prices.json" ] && [ -f "$here/llm/prices.json" ]; then
  cp "$here/llm/prices.json" "$root$data/prices.json"
fi
[ -f "$root$data/prices.json" ] || echo "  no price grid yet: copy deploy/llm/prices.json to $data/prices.json, or every agent turn is refused"
[ -f "$root$data/state.json" ] || printf '{\n  "version": 1,\n  "missions": [],\n  "briefs": [],\n  "memories": [],\n  "approvals": [],\n  "events": [],\n  "mandates": []\n}\n' > "$root$data/state.json"

echo "tenant $slug rendered: https://$domain (owner $owner, sign-in for $email_domains)"
echo "  register the redirect URI https://$domain/oauth2/callback on the Entra application"
echo "  fill in $data/model.env before the first agent turn"
if [ "$docker" = 1 ]; then
  cd "$root$app"
  docker compose up -d
  docker compose ps
fi
