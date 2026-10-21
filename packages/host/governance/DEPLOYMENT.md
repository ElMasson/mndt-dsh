# Deploying governed DSH for a team

This is the operator guide for the governance plugin: a central RBAC authority that
authenticates callers, and workstations that keep executing locally in each person's
own browser and on their own machine.

## The two modes

| Mode | Who decides | Where the table lives | Use it when |
|---|---|---|---|
| Solo | the local gateway | `~/.dsh/governance/rbac.json` on that machine | one person, a pilot, an air-gapped machine |
| Team | the central authority | the authority's state file, cached read-only on each workstation | several people who must share one truth |

Team mode is the default recommendation for a team, because a file that lives on a
machine belongs to whoever can write that file. Only the authority turns a token into
an identity.

## Prerequisites

- Node 22 or newer, `pnpm`, and a built DSH checkout.
- For team mode: one always-reachable host for the authority and a TLS terminator in
  front of it. The authority itself speaks plain HTTP on loopback and is not meant to
  be exposed directly.

## Mode A, local first

1. Build the workspace once: `pnpm install && pnpm run build`.
2. Start DSH on the machine: `dsh web`. It binds loopback only.
3. Open `http://127.0.0.1:3080` in that machine's browser.
4. Bootstrap the first owner from the governance page, or through the local file:
   set `DSH_GOVERNANCE_HOME` to choose where `rbac.json` lives.

Nothing inbound is opened. This mode is the safest thing to put in someone's hands
today, and the fastest to try.

## Mode B, team

### 1. Provision the authority

Create a token file, one entry per person. Treat it as a secret store, not as config
to commit:

```json
{
  "TOKEN_FOR_STEPHANE": { "user": "stephane" },
  "TOKEN_FOR_SARA": { "user": "sara" }
}
```

Start it:

```sh
DSH_GOVERNANCE_TOKENS_FILE=/etc/dsh/tokens.json \
DSH_GOVERNANCE_STATE=/var/lib/dsh/governance/rbac.json \
DSH_GOVERNANCE_AUDIT=/var/lib/dsh/governance/audit.jsonl \
DSH_GOVERNANCE_PORT=8787 \
DSH_GOVERNANCE_HOST=127.0.0.1 \
pnpm exec tsx packages/host/governance/scripts/serve-authority.ts
```

Keep `DSH_GOVERNANCE_HOST` on loopback and let the proxy reach it. Bind `0.0.0.0`
only if the proxy runs on another host and the network between them is trusted or
encrypted.

### 2. Terminate TLS and authenticate users

Put a reverse proxy in front, with SSO on the proxy side. Example shape, to adapt to
your identity provider:

```nginx
server {
  listen 443 ssl;
  server_name governance.example.internal;

  ssl_certificate     /etc/ssl/governance.crt;
  ssl_certificate_key /etc/ssl/governance.key;

  location / {
    # The proxy authenticates the person, then injects the bearer token that
    # the authority maps to that person. The token never reaches the browser.
    auth_request /sso/verify;
    proxy_set_header Authorization "Bearer $sso_authority_token";
    proxy_pass http://127.0.0.1:8787;
  }

  location = /sso/verify { internal; proxy_pass http://sso/verify; }
}
```

The important property: the browser never holds the authority token. It holds a
session cookie with the proxy; the proxy holds the mapping.

### 2 bis. Microsoft Entra ID, concretely

Entra authenticates the person at the proxy. The authority token stays a separate
secret, held per person in a password manager and exported on their machine, so the
browser never carries it and the proxy never needs a token lookup table.

**App registration (Entra portal):**

1. Entra ID, App registrations, New registration, name `dsh-governance`.
2. Redirect URI, Web: `https://governance.example.internal/oauth2/callback`.
3. Certificates and secrets, new client secret, copy the value once.
4. API permissions: `openid`, `profile`, `email`, `User.Read`, then grant admin consent.
5. Token configuration: add the optional claim `email` so the identity is readable.
6. Enterprise application, Properties, set "Assignment required" to Yes and assign the team group.

**oauth2-proxy in front of the authority:**

```sh
oauth2-proxy \
  --provider=oidc \
  --oidc-issuer-url=https://login.microsoftonline.com/<TENANT_ID>/v2.0 \
  --client-id=<CLIENT_ID> \
  --client-secret=<CLIENT_SECRET> \
  --redirect-url=https://governance.example.internal/oauth2/callback \
  --email-domain=duke-analytics.com \
  --cookie-secure=true \
  --upstream=http://127.0.0.1:8787 \
  --http-address=127.0.0.1:4180
```

**nginx in front of oauth2-proxy:**

```nginx
server {
  listen 443 ssl;
  server_name governance.example.internal;
  ssl_certificate     /etc/ssl/governance.crt;
  ssl_certificate_key /etc/ssl/governance.key;

  location / {
    auth_request /oauth2/auth;
    error_page 401 = /oauth2/sign_in;
    auth_request_set $user $upstream_http_x_auth_request_email;
    proxy_set_header X-Auth-Request-Email $user;
    proxy_set_header Authorization $http_authorization;
    proxy_pass http://127.0.0.1:4180;
  }

  location /oauth2/ { proxy_pass http://127.0.0.1:4180; }
}
```

**What each piece proves, and what it does not:**

- Entra proves the person reached the service. The proxy refuses anyone outside the
  assigned group.
- The authority token proves the identity to the authority. It is issued per person,
  stored in their password manager, and exported as `DSH_GOVERNANCE_TOKEN`.
- Neither replaces the other. Revoking access in Entra stops reachability; removing
  the token entry stops identity; removing the grant stops rights. Three separate
  levers, and an operator should know which one they are pulling.

### 3. Point workstations at the authority

On each machine, export two variables before starting DSH:

```sh
DSH_GOVERNANCE_AUTHORITY=https://governance.example.internal
DSH_GOVERNANCE_TOKEN=<that person's token>
```

With them set, the local gateway stops deciding: it asks the authority, shows the
answer, and caches the table. Without them, the machine stays in solo mode.

### 4. Offline behaviour

If the authority cannot be reached, the last known table is served and flagged stale
through `tableState()`. A stale table is never presented as live, and a refusal
(expired token, for example) never overwrites the cache.

## Operations

- **Rotate a token:** replace the entry in the token file and restart the authority.
  Workstations pick up the new token from their environment on next start.
- **Revoke a person:** remove the token entry and their grant. Removing a grant takes
  effect immediately for mutations; removing the token stops reads too.
- **Audit:** every mutation appends one JSONL line with the authenticated user, the
  action, the subject, and the decision. Ship that file like any other audit log.
- **Back up:** the state file is the truth in team mode. Back it up with the audit
  file; workstations only hold a cache.
- **Health:** `GET /health` answers without a token so a probe can watch the process.

## What this deployment does not solve yet

State these to the team, because they are real:

1. **One surface is not wired.** Rights, agents, sharing, and connectors read live
   data (connectors are the MCP client entries the Loader actually mounted). The
   workflows tab has no catalog at this seam: `ctx.workflowEngine` exposes `start()`
   only, so it says so on screen instead of inventing a list.
2. **The Remote boundary does not authenticate the calling agent.** The authority
   authenticates the caller instead, which is why mutations must go through it in team
   mode. Solo mode trusts the machine.
3. **Plugin supply chain.** Pin the bundle you distribute. Do not let a production
   workstation install arbitrary plugins from the market.
4. **Sandbox and credentials** stay per machine: `packages/sandbox` and
   `packages/credentials`. Do not put secrets in shared config.

## Automations

An automation is a prompt owned by one person, stored on their workstation
(`automations.json` next to the RBAC table). Nobody else can list, modify or run it:
the Host filters by owner and refuses a foreign id.

Execution goes through the only real path the harness exposes:

1. `ctx.agents.create({ sessionId })` creates the agent that owns the run.
2. `ctx.workflowEngine.start({ script, meta, parent })` runs `agent(prompt)` with that
   agent as parent.
3. The agent is disposed on every path, including when the script throws.

A scheduled run is a timer on the workstation: if the machine is asleep, the run does
not happen and the next tick does not replay it. Say that to the team rather than
letting them believe the schedule is guaranteed.

## Pinning the distribution

The team must run the artifacts that were verified, not whatever a rebuild happens
to produce. Pin them once, then verify on each workstation before handing it over:

```sh
node packages/host/governance/scripts/distribution.mjs --write   # after a verified build
node packages/host/governance/scripts/distribution.mjs --check   # exit 1 on any drift
```

The lock records both package versions and the SHA-256 of the five shipped files
(host entry, both generated Typert faces, client entry, browser bundle). A rebuilt
bundle that differs from the pin fails the check instead of reaching a machine.
`distribution.lock.json` belongs in the distributed artifact set.

## Verification before handing it over

```sh
pnpm exec tsc -b tsconfig.host.json          # host types
pnpm exec tsc -b tsconfig.client.json        # client types
pnpm exec vitest run packages/host/governance/tests --pool=threads
pnpm exec vitest run packages/client/ui-governance/tests --pool=threads
```

The host suite covers the authority (authentication, decisions, audit, HTTP adapter),
the durable storage, and the offline cache. The client suite covers the rules and a
real jsdom render of the page, including the refusal path.
