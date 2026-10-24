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

## Constat du 24 octobre, contrainte de memoire du serveur

Le serveur a 7 Go de RAM, dont environ 4 Go disponibles. La compilation des
declarations hotes du depot depasse cette enveloppe : sans drapeau, node meurt
en `Ineffective mark-compacts near heap limit` ; avec `--max-old-space-size=6144`,
la compilation tourne plus de vingt minutes en saturant la machine.

Trois issues realistes, a trancher au prochain tour :

1. ajouter un fichier d'echange de 8 Go sous `/data` pour la seule duree du
   build, puis le retirer ;
2. construire l'installation portable sur une machine plus large et ne livrer
   que le resultat (le paquet ne depend plus de l'environnement de build) ;
3. reduire la porte de build aux paquets du produit, si le depot expose une
   portee plus etroite que `--scope artifacts`.

La deuxieme option est la plus sure : elle deplace la contrainte ailleurs sans
toucher au serveur de production.

## Constat du 24 octobre, poste de travail

Deux pistes locales ont echoue avant de produire quoi que ce soit :

- Docker Desktop est installe mais son moteur n'est pas demarre (canal
  `dockerDesktopLinuxEngine` absent), donc pas de construction en conteneur sur
  le poste sans intervention de l'utilisateur ;
- le WSL Ubuntu fournit pnpm mais pas node, et l'installation de node dans
  `/opt` echoue pour permission en utilisateur non root, puis le telechargement
  echoue en root.

Conclusion : la construction doit se faire soit sur une machine Linux de build,
soit apres demarrage explicite de Docker Desktop, soit sur le serveur apres
ajout d'un fichier d'echange. Aucune de ces trois voies n'est ouverte a
l'instant, et rien n'a ete modifie en production.

## Constat du 24 octobre, build Linux obtenu mais entree absente

La construction dans WSL a node 22 a produit une installation portable de 300 Mo,
avec les binaires natifs Linux (koffi compile par prebuild) et un paquet de 56 Mo.
Mais pps/cli/lib n a pas ete produit par la porte --scope artifacts : le
paquet deploye ne contient que README, package.json et node_modules, donc aucune
entree executable. Le conteneur demarre et sort aussitot sur
Cannot find module /app/lib/index.js.

Prochaine etape : ajouter explicitement pnpm --filter @deepseek-ai/dsh bundle
(ou la porte de build qui produit cette lib) avant le deploy, verifier
pps/cli/lib/index.js, puis redeployer.

## Garde-fous

`DSH_PERMISSION_MODE=danger-full-access` est nécessaire au worker du workflow
pour écrire ; il ne doit être accordé qu'au conteneur dédié, monté en lecture
seule sur tout ce qui n'est pas son état. Un refus de ce worker doit rester
visible comme un échec de mission, jamais comme un brief vide.
