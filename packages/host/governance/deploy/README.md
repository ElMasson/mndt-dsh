# Deployment checklist for 51.159.164.138.
#
# Files in this directory are templates: copy them to their system paths, fill
# the identifiers, and never commit real secrets.

## Layout on the server

```
/opt/dsh                          checkout of the harness, built
/etc/dsh/tokens.json              token to identity map (root:dsh, 0640)
/etc/dsh/entra.env                CLIENT_SECRET for oauth2-proxy (root:root, 0600)
/etc/oauth2-proxy/governance.cfg  from oauth2-proxy.cfg
/etc/nginx/conf.d/governance.conf from nginx-governance.conf
/var/lib/dsh/governance/rbac.json state, owned by dsh
/var/lib/dsh/governance/audit.jsonl audit, append only
```

## Steps

1. Build on the server: `pnpm install --frozen-lockfile && pnpm run build`.
2. Create the `dsh` user and the two directories:
   `useradd --system --home /var/lib/dsh dsh`,
   `install -d -o dsh -g dsh /var/lib/dsh/governance`.
3. Write `/etc/dsh/tokens.json` (see `tokens.example.json`), mode 0640, owner root:dsh.
4. Install the unit, then `systemctl daemon-reload && systemctl enable --now dsh-governance-authority`.
5. Check the service answers locally: `curl -s http://127.0.0.1:8787/health` returns `{"ok":true}`.
6. Configure oauth2-proxy with the Entra identifiers and the client secret in its environment.
7. Install the nginx server block, obtain the certificate, `nginx -t && systemctl reload nginx`.
8. Verify from a workstation:
   - `curl -s https://governance.duck-analytics.internal/health` returns `{"ok":true}` through the proxy.
   - `curl -s https://governance.duck-analytics.internal/governance/snapshot` without a token returns 401.
   - the same call with `Authorization: Bearer <token>` returns the table.
9. Firewall: expose only 443 (and 80 for the redirect). Port 8787 and 4180 stay on loopback.

## First owner

There is no seeded owner: the table starts empty and refuses every mutation until
one owner exists. Bootstrap from the authority host, with a person's token:

```sh
curl -s -X POST http://127.0.0.1:8787/governance/bootstrap \
  -H "Authorization: Bearer $TOKEN"
```

Then grant the team from the governance page.

## Rotating a token

Replace the entry in `/etc/dsh/tokens.json`, then
`systemctl restart dsh-governance-authority`. Workstations pick up their new token
from their environment on the next start. Removing a token stops reads immediately;
removing a grant stops mutations immediately; revoking the Entra assignment stops
reachability.

## Secrets oauth2-proxy (jamais dans le depot)

Deux fichiers, mode 0600, lisibles par le seul compte du proxy :

```bash
sudo install -d -m 0700 /etc/oauth2-proxy
openssl rand -base64 32 | sudo tee /etc/oauth2-proxy/cookie_secret >/dev/null
printf %s "<client-secret-entra>" | sudo tee /etc/oauth2-proxy/client_secret >/dev/null
sudo chmod 0600 /etc/oauth2-proxy/cookie_secret /etc/oauth2-proxy/client_secret
```

La configuration y fait reference par `@/etc/oauth2-proxy/...` : sans le
`cookie_secret`, oauth2-proxy refuse de demarrer, et c est la premiere cause
de panne silencieuse d un deploiement SSO.
