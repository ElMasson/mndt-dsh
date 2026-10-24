# Déploiement du workbench mndt sur Scaleway

État au 24 octobre 2026 : le chemin de livraison est identifié, la première
tentative a révélé deux incompatibilités réelles. Rien n'est en service.

## Ce que la tentative a appris

1. `pnpm deploy --filter @deepseek-ai/dsh --prod` produit une installation
   portable de 479 Mo (43 Mo compressée) qui contient bien le bundle web, le
   plugin hôte et la page. Sur Windows, cet install fonctionne.
2. Cette installation **ne peut pas tourner sur le serveur** : elle a été
   construite sous Windows, donc `koffi` et les aides de sous-processus sont des
   binaires Windows, et le serveur est en Linux.
3. Le serveur a **node 18.19.1**, trop ancien pour le runtime DSH, mais il a
   **docker 29.3.0** : la cible naturelle est un conteneur node 22.

## Chemin retenu

Le paquet doit être construit sur Linux, pas depuis Windows. La procédure, à
exécuter sur le serveur :

    docker run --rm -v /opt/mndt-build:/src -w /src node:22-bookworm \
      bash -lc "corepack enable && pnpm install --frozen-lockfile && pnpm build"

puis remplacer `pnpm build` par la commande de build du dépôt
(`tsx scripts/build.ts` avec la portée artefacts) et un `pnpm deploy --prod`
pour la sortie portable. Le service tourne ensuite dans un conteneur node 22
avec deux montages :

    /opt/mndt-dsh          l'installation portable
    /var/lib/dsh/mndt      l'état du produit et son home DSH

## Ce qui reste à faire, dans l'ordre

1. Construire l'install portable sous Linux (conteneur node 22).
2. Lancer le conteneur, lié à `127.0.0.1:3111` et `127.0.0.1:8795`, vérifier
   `/health`, la page servie, puis une mission réelle.
3. Ajouter le front SSO : deuxième instance oauth2-proxy calquée sur celle de la
   gouvernance, routeur Traefik pour `mndt.duke-analytics.com`, enregistrement
   DNS A vers 51.159.164.138.
4. Vérifier les deux chemins : navigateur derrière Entra, machine avec jeton.

## Constat du 24 octobre, après la tentative depuis Windows

Transporter une archive du source depuis Windows s'est révélé peu fiable :
l'archive produite était incomplète, puis la compression complète a dépassé
vingt minutes sans aboutir. Le chemin robuste est donc de cloner la branche sur
le serveur et de construire là, dans le conteneur node 22, sans transfert
d'archive. Le serveur dispose de docker et du réseau nécessaire pour
l'installation des dépendances.

## Garde-fous

`DSH_PERMISSION_MODE=danger-full-access` est nécessaire au worker du workflow
pour écrire ; il ne doit être accordé qu'au conteneur dédié, monté en lecture
seule sur tout ce qui n'est pas son état. Un refus de ce worker doit rester
visible comme un échec de mission, jamais comme un brief vide.
