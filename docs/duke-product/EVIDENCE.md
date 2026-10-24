# Preuves du produit mndt

Ce document relie chaque exigence de l'objectif a une preuve verifiable : une
commande executee, une reponse observee, une capture, un commit. Une ligne sans
preuve est une ligne ouverte, pas une reussite.

## 1. Base DSH, produit reconstruit

| Element | Preuve | Ou |
| --- | --- | --- |
| Domaine produit (missions, briefs, approbations, memoire) | 24 tests passent | `pnpm vitest run packages/host/mndt/tests` |
| API produit (identite, droits, routes, refus) | tests d'API dont `/state` par personne | `packages/host/mndt/tests/api.host.spec.ts` |
| Page produit | captures locale et serveur | `docs/duke-product/evidence/` |
| Composition | lignes `host-mndt` et `ui-mndt` dans le bundle web | `packages/bundle/web-app/cordis.patch.yml` |

## 2. Agents et missions executes par DSH

| Element | Preuve | Ou |
| --- | --- | --- |
| Mission reelle par l'API | `201`, mission `done`, brief `brf_a659bd900841474abace` | serveur, 24 octobre |
| Mission reelle depuis la page | capture | `evidence/page-briefing-from-ui.png` |
| Mission refusee proprement | brief dit ce qui manque au lieu d'inventer | etat du 24 octobre |
| Echec honnete | premiere mission serveur : cle de modele absente, message exact | journal du 24 octobre |

## 3. Connecteurs MCP reels

| Element | Preuve | Ou |
| --- | --- | --- |
| Connecteur monte | `{"connectors":[{"server":"workbench_facts","enabled":true}]}` | API `/connectors` du serveur |
| Outil appele par une mission | brief citant la reponse verbatim, source = serveur MCP | mission du 24 octobre, capture `page-connector-mission.png` |
| Connecteurs metier externes | **ouvert** : en attente des identifiants (Attio, Qonto, ...) | question posee |

## 4. Automatisations planifiees

| Element | Preuve | Ou |
| --- | --- | --- |
| Briefing planifie local | mission `done`, auteur `scheduler`, brief date | capture `page-scheduled-briefing.png` |
| Briefing planifie serveur | deux missions `scheduler` terminees, brief `Briefing du matin — Duke Analytics` | etat du serveur, 24 octobre |
| Honnetete du brief | il refuse de remplir les cinq rubriques faute de source | texte du brief, cite dans DEPLOYMENT.md |

## 5. Gouvernance RBAC centralisee

| Element | Preuve | Ou |
| --- | --- | --- |
| Autorite de gouvernance | deployee et joignable, SSO Entra devant elle | `governance.duke-analytics.com` |
| Lecture des droits par le produit | `authorityGrants` / `localGrants` | `packages/host/mndt/src/grants.ts` |
| Matrice par personne | `/state` : `canWrite` vrai proprietaire, faux lecteur | serveur, en-tete proxy |
| Approbations avec motif | refus impossible sans motif | capture `page-morning.png` |

## 6. Multi-utilisateurs

| Element | Preuve | Ou |
| --- | --- | --- |
| Identite lue par requete | `/state` rend `you` et `canWrite` distincts | serveur |
| Lecteur en lecture seule | pastille `Read only`, deux boutons desactives | capture `page-read-only-viewer.png` |
| Identite de page par personne | transport HTTP vers `/mndt-api` ajoute cette session | commit `c08597ffee` |

## 7. Deploiement et SSO

| Element | Preuve | Ou |
| --- | --- | --- |
| Image Linux construite | image `mndt-workbench:local`, 1,05 Go, compilateur hote OK | constructions des 24 octobre |
| Pile en production | trois conteneurs du projet `mndt-front` demarres | `docker ps` serveur |
| Sante | `{"ok":true}` | `/health` serveur |
| Page servie | `200` avec cookie, `401` sans | serveur et passerelle |
| Redirection Entra | `302` vers `login.microsoftonline.com` avec `redirect_uri=https://mndt.duke-analytics.com/oauth2/callback` | Traefik, serveur |
| DNS public | **ouvert** : `mndt.duke-analytics.com` ne resout pas encore | action utilisateur |
| URI Entra | **ouvert** : a ajouter sur l'application `122bdf54-4ab8-4ef1-995e-a08501d04782` | action utilisateur |
| Connexion complete | **ouvert** tant que les deux lignes ci-dessus ne sont pas faites | a verifier ensuite |

## 8. Limites connues, dites explicitement

- La page derriere SSO partage le jeton de demarrage du shell ; les actions de
  produit, elles, sont attribuees par personne via `/mndt-api` et l'en-tete du
  proxy. Les fonctions de shell hors produit restent donc mono-jeton.
- Le connecteur monte est un petit serveur de demonstration, pas un systeme Duke.
  Il prouve la chaine ; les connecteurs metier demandent leurs acces.
- Le brief planifie du serveur ne cite aucune source reelle, et le dit.
- La cle du modele est stockee sur le serveur dans un fichier protege ; elle est
  a faire tourner apres les tests.
