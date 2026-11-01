# Déployer une couche sans reconstruire l image

## Pourquoi

Chaque déploiement de la page a jusqu ici été fait par `docker cp` puis `docker commit`.
Un commit écrit une couche complète de `/app`, plusieurs centaines de mégaoctets, et le
serveur a fini par saturer son disque et son démon Docker. Le 29 octobre, la charge est
montée à 276 avec 96 processus bloqués en attente d entrée-sortie, et le serveur a cessé
de répondre pendant plusieurs dizaines de minutes. La cause première est la charge
co-hébergée, mais nos commits répétés ont aggravé la pression.

## La règle

Une image ne contient plus le code de la page. Elle contient le socle. Le code vari­able
est monté depuis `/data/mndt/live/layers` en lecture seule, dans le workbench et dans
chaque shell.

Deux dossiers :

```
/data/mndt/live/layers/ui-mndt    -> /app/packages/client/ui-mndt/lib
/data/mndt/live/layers/host-mndt  -> /app/packages/host/mndt/lib
```

## Ce qu il faut monter

Dans `docker-compose.yml`, service `workbench`, volumes :

```yaml
      - /data/mndt/live/layers/ui-mndt:/app/packages/client/ui-mndt/lib:ro
      - /data/mndt/live/layers/host-mndt:/app/packages/host/mndt/lib:ro
```

Dans `machines-sidecar.py`, création du shell, ajouter les deux mêmes montages en lecture
seule, avec des constantes `LAYERS_ROOT` et `LAYERS_ROOT_HOST`, comme pour
`SHELLS_TOOLS_HOST` et `LIVE_CONNECTORS`.

## Déployer

1. Construire localement : client `tsdown`, hôte `tsdown`.
2. Copier un tar contenant `ui-mndt/` et `host-mndt/` sur le serveur, dans `/root/layer.tar`.
3. Extraire dans un dossier de travail, puis remplacer le contenu des deux dossiers de
   couches, sans supprimer le dossier lui-même, qui est le point de montage.
4. Recréer le workbench et supprimer les shells, qui se recréent à la première visite.

Aucune image n est reconstruite, aucun commit n est écrit. Le déploiement tient en moins
d une minute et n ajoute pas de couche disque.

## Après un incident de charge

1. Vérifier la santé publique `https://mndt.duke-analytics.com/health` et
   `http://127.0.0.1:8795/health` avant toute action.
2. Ne pas lancer de commande Docker lourde tant que la charge est au dessus de 40.
3. Si le workbench est arrêté, `docker compose up -d workbench` suffit, sans reconstruction.
4. Ne jamais supprimer une image utilisée par un conteneur en cours. Les anciennes étiquettes
   `mndt-workbench:collab*` et `mndt-workbench:demo*` peuvent être retirées après la
   bascule, jamais avant.

## Verifier un déploiement

1. `curl -s http://127.0.0.1:8795/health` répond `{"ok":true}`.
2. La page réelle montre le composeur et les cartes.
3. Le journal du shell ne contient plus `Cannot find module`.
4. La séparation des identités est vérifiée par l API `/state` avec deux en-têtes
   `x-forwarded-email` différents : le brief d une mission privée d une personne ne doit
   jamais apparaître chez une autre.

---

# Mettre à jour un connecteur MCP

Un connecteur est un petit serveur Node qui tourne dans le workbench. Il ne fait pas partie
de la couche `ui-mndt` ni de `host-mndt`, et il n est pas relu quand la couche change : il
faut recopier le fichier puis recréer le workbench, sinon le processus garde l ancien code.

## Fichiers et emplacements

| Connecteur | Script dans le depot | Copie sur le serveur | Variables |
|---|---|---|---|
| approvals | `packages/host/mndt/deploy/connectors/approvals-mcp.mjs` | `/data/mndt/live/tools/approvals-mcp.mjs` | `MNDT_API`, `MNDT_ACTOR`, `MNDT_ACTOR_FILE` |
| office365 | `packages/host/mndt/deploy/connectors/office365-mcp.mjs` | `/data/mndt/live/connectors/office365-mcp.mjs` | `OFFICE365_TOKEN_FILE`, `MNDT_ACTOR_FILE`, `OFFICE365_OWNER` |
| facts | `packages/host/mndt/deploy/connectors/facts-mcp.mjs` | `/data/mndt/live/tools/facts-mcp.mjs` | aucune |

Les variables vivent dans `/data/mndt/live/connectors/<nom>.env`, en mode 600.

## Procedure

1. Copier le script depuis le depot vers l emplacement du tableau.
2. Completer le fichier d environnement si une variable nouvelle apparait. Exemple pour
   l identite par mission :
   `MNDT_ACTOR_FILE=/state/mission-actor.json`, et `OFFICE365_OWNER=duke@datanalysis.re`
   pour la garde de la boite.
3. Verifier la syntaxe : `node --check <chemin>`.
4. Recreer le workbench : `cd /opt/mndt-front && docker compose up -d --force-recreate workbench`.
5. Attendre `curl -s http://127.0.0.1:8795/health` -> `{"ok":true}`.

## Verifier l identite par mission

1. Lancer une mission avec l en-tete d une autre personne :
   `POST /missions` avec `x-forwarded-email: gouvernance@datanalysis.re`, demande d une
   approbation de type publish.
2. Lire `/approvals?state=all` : le champ `requestedBy` doit porter l identite de la mission,
   pas celle de l environnement.
3. Pour la boite : une mission d une personne autre que le proprietaire doit recevoir un
   refus explicite, sans lecture. Une mission du proprietaire lit normalement.

Sans l etape 4, le processus MCP reste celui d avant et les tests semblent sans effet. C est
le piege principal de cette procedure.

---

# Sauvegarder et restaurer l etat

L etat vit dans `/data/mndt/live/state.json` : missions, briefs, approbations, mandats,
membres, journal. Une modification manuelle se fait toujours apres une copie.

## Sauvegarder

```sh
mkdir -p /data/mndt/backups
cp /data/mndt/live/state.json /data/mndt/backups/state-$(date -u +%Y%m%dT%H%M%SZ).json
ls -l /data/mndt/backups
```

## Restaurer

```sh
cp /data/mndt/backups/state-20261101T010230Z.json /data/mndt/live/state.json
cd /opt/mndt-front && docker compose up -d --force-recreate workbench
curl -s http://127.0.0.1:8795/health
```

Puis verifier avec `/state` et trois en-tetes differents que les missions privees sont
toujours invisibles aux autres. Une restauration sans recreation du workbench laisse le
processus en memoire sur l ancien etat.

## Prechauffer apres un deploiement

La recreation du workbench supprime les shells. Le premier visiteur paie leur creation :
mesure du 1er novembre, 91 secondes avant le DOM pret et plus de quatre minutes sans espace
visible sur un premier chargement, contre 2 secondes et 7,8 secondes a chaud. Avant une
demonstration ou une recette, ouvrir la page une fois par personne, attendre l espace de
collaboration, puis verifier qu un rechargement passe sous dix secondes. Un premier
chargement lent n est pas une panne du produit, c est le shell qui se cree.
