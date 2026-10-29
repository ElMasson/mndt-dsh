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
