# Authority bundle — installation

This directory is self-contained: one JavaScript file, one systemd unit, one
installer, the nginx and oauth2-proxy configuration. The server needs Node 20+,
nginx and systemd. No git, no pnpm, no build step.

## Install

```bash
sudo ./deploy-authority-bundle.sh
```

The script creates the `dsh` account, `/var/lib/dsh/governance`, `/etc/dsh`,
installs the unit, starts it, checks `/health`, verifies that an anonymous call
is refused with 401, then installs and reloads the nginx site.

## Then, by hand (deliberately not automated)

1. Replace the two placeholder tokens in `/etc/dsh/tokens.json` with real
   secrets, then `systemctl restart dsh-governance-authority`.
2. Put the Entra client secret in `/etc/oauth2-proxy/client_secret` (mode 0600)
   before the first run, or the installer stops at step 3.
3. Bootstrap the first owner:

```bash
curl -sS -X POST http://127.0.0.1:8787/governance/bootstrap \
  -H 'authorization: Bearer <owner-token>' \
  -H 'content-type: application/json' \
  -d '{"user":"stephane","role":"owner"}'
```

## Verify

```bash
curl -s  http://127.0.0.1:8787/health                          # {"ok":true}
curl -is http://127.0.0.1:8787/governance/snapshot | head -1   # 401
sudo journalctl -u dsh-governance-authority -n 20 --no-pager
sudo tail -n 5 /var/lib/dsh/governance/audit.jsonl
```

## Rollback

```bash
sudo systemctl disable --now dsh-governance-authority
sudo rm /etc/systemd/system/dsh-governance-authority.service
sudo systemctl daemon-reload
sudo rm /etc/nginx/conf.d/governance.conf && sudo systemctl reload nginx
```

The state file and the audit trail are kept on purpose: deleting them loses the
grant table and the history of refusals.
