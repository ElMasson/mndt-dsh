# Governance stack — installation on the Scaleway host

Runs the authority and its Entra SSO front in one small Docker project, next to
the existing Tellus stack. Nothing in the Tellus compose project or its Traefik
files is modified: this project only joins the `tellus-ai_default` network and
announces itself to Traefik by labels.

## Prerequisites

- DNS: `A governance.duke-analytics.com -> 51.159.164.138` (Let's Encrypt uses
  the HTTP challenge, so the record must resolve before the first start).
- The Entra application registration: tenant id, client id, client secret.
- The authority bundle already at `/opt/dsh-governance/governance-authority.mjs`.

## Install

```bash
sudo install -d -m 0755 /opt/governance /opt/dsh-governance
sudo install -d -m 0700 /etc/oauth2-proxy
sudo install -m 0644 docker-compose.yml /opt/governance/docker-compose.yml
sudo install -m 0644 oauth2-proxy.cfg /opt/governance/oauth2.cfg
sudo install -m 0644 governance-authority.mjs /opt/dsh-governance/

# The two secrets, mode 0600, never in the repository.
sudo openssl rand 32 > /etc/oauth2-proxy/cookie_secret
printf '%s' '<client-secret-entra>' | sudo tee /etc/oauth2-proxy/client_secret >/dev/null
sudo chmod 0600 /etc/oauth2-proxy/cookie_secret /etc/oauth2-proxy/client_secret

# One authority only: the host service would share the same state file.
sudo systemctl disable --now dsh-governance-authority

cd /opt/governance
sudo docker compose up -d
sudo docker compose ps
```

## Verify

```bash
# The proxy answers, the authority is reachable inside the project.
sudo docker compose logs --tail 20 authority
sudo docker compose logs --tail 20 oauth2proxy

# Without a session: a redirect to Microsoft, not a page.
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://governance.duke-analytics.com/

# With a browser session: the governance page, reading the real Host data.
```

## Rollback

```bash
cd /opt/governance
sudo docker compose down
sudo systemctl enable --now dsh-governance-authority   # back to loopback only
```

The state file and the audit trail live on the host under
`/var/lib/dsh/governance` and survive the container lifecycle.

## Notes

- `allowed_groups` is deliberately absent for now: the filter is the email
  domain. Adding a group means putting its **object id** (a GUID) in the
  configuration, not its display name.
- The client secret expires on the date chosen at creation; renew it in Entra
  and re-run `docker compose up -d` after replacing the file.

## Ajouter un membre (mode equipe)

L autorite porte une seule table pour toute l equipe. Chaque personne recoit un
jeton qui la nomme, et ses ecritures sont attribuees a son adresse dans
`audit.jsonl`.

    ssh -i ~/.ssh/tellus/tellus-root root@51.159.164.138
    /opt/governance/add-member.sh prenom@datanalysis.re viewer

Le script reutilise le jeton existant s il y en a un, sinon il en cree un et
l affiche **une seule fois** : un jeton deja emis n est jamais reaffiche, un
secret ne doit pas repasser par un journal ou une conversation.

Cote poste de travail, deux variables suffisent :

    DSH_GOVERNANCE_AUTHORITY=https://governance.duke-analytics.com
    DSH_GOVERNANCE_TOKEN=<le jeton remis a la personne>

Lance alors `dsh web`. La page Gouvernance affiche l identite resolue par
l autorite, la provenance de la table (live ou cache) et la table partagee.

## Deux chemins d acces, un seul service

    navigateur, aucun identifiant   -> oauth2-proxy -> Entra -> autorite
    navigateur, session Entra       -> oauth2-proxy -> autorite (x-forwarded-email)
    machine, Authorization: Bearer  -> autorite directement (routeur Traefik dedie)

Le routeur `governance-token` de Traefik utilise `HeaderRegexp`, pas `Header` :
`Header` compare la valeur exacte et ne matcherait jamais un jeton. Il porte une
priorite superieure au routeur SSO, donc un appel machine ne passe jamais par la
redirection de connexion.

## Renouveler un jeton expose

    /opt/governance/rotate-token.sh prenom@datanalysis.re

Le nouveau jeton est ecrit dans `/etc/dsh/tokens.json` (0640, root:dsh) et jamais
affiche. L autorite redemarre pour le prendre en compte.
