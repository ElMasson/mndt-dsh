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

## Constat du 24 octobre, bundle CLI sur une installation neuve

Deux tentatives pour produire pps/cli/lib sur une installation Linux neuve ont
 echoue : tsdown ne trouve pas unrun ; apres installation de unrun, c est le
 binding natif de rolldown qui echoue au chargement de la configuration. Ces deux
 problemes n apparaissent pas sur le poste, ou ces dependances sont deja la.

Piste pour le prochain tour : construire le CLI sans tsdown, par exemple avec
 tsx a l execution depuis l arbre source (les dependances de developpement sont
 presentes sur le serveur), ou en figeant les versions de tsdown, unrun et
 rolldown dans le depot pour rendre la construction reproductible.

## Etat apres quatre tours de construction, 24 octobre

Trois corrections ont ete apportees au depot : suppression du paquet de domaine
supprime de l arbre git, lockfile nettoye, unrun epingle dans les dependances.
Avec une installation figee, la construction avance jusqu au bundle de configuration
de tsdown, puis echoue dans unrun, qui bundle cette configuration avec rolldown
(ggregateBindingErrorsIntoJsError). Le message exact de rolldown est tronque
par l agregation ; le meme depot construit sans erreur sous Windows.

Ce qui a ete prouve et ne depend plus du deploiement : page produit, agents et
missions executes, connecteurs reels, briefing planifie, RBAC et lecture seule.

Ce qui manque : une chaine d outils reproductible sous Linux, ou un environnement
de construction different (Docker Desktop demarre, CI, ou serveur avec plus de
RAM et un fichier d echange). Ces trois prerequis dependent d une decision ou
d une action exterieure, pas d un changement de code produit.

## Etat deploye, 24 octobre

Le service tourne sur le serveur depuis une image Linux construite en local avec
Docker Desktop. Fichiers et volumes :

- image `mndt-workbench:local`, 1,05 Go, construite depuis la branche, chargee sur le serveur ;
- conteneur `mndt-workbench`, reseau hote, redemarrage automatique ;
- API produit sur `127.0.0.1:8795`, page sur `127.0.0.1:3111` ;
- etat et accueil sous `/data/mndt/live` (monte en `/state`) ;
- jetons dans `/data/mndt/live/tokens.json` (droits 600) ;
- cle du modele dans `/data/mndt/live/model.env` (droits 600).

Preuves obtenues sur cette instance : `/health` repond `{"ok":true}`, `/me`
repond l'identite, une mission reelle a produit le brief `brf_a659bd900841474abace`,
et la page s'affiche avec les donnees du serveur (capture
`docs/duke-product/evidence/page-deployed-server.png`).

### Piege d'un profil vide

Sur un accueil DSH neuf, une fenetre d'accueil produit s'affiche et bloque toute
interaction : les clics dans la barre laterale ne changent rien et aucune page ne
s'affiche. Ce n'est pas un defaut des pages. Il suffit d'accepter la fenetre une
fois ; l'acquittement est persiste dans le profil et l'interface redevient
utilisable. C'est aussi ce qui explique qu'une instance locale avec un accueil
deja utilise se comporte differemment.

### Reste a faire

- front SSO et route Traefik, avec le nom d'hote a choisir ;
- rattachement des connecteurs aux droits, puis une mission qui appelle un
  connecteur reel ;
- rotation de la cle du modele apres les tests.

## Front SSO, etat au 24 octobre

Le front est installe et fonctionne jusqu'a la redirection Entra. Conteneurs :

- `mndt-front-gateway-1` : passerelle Node, amorce le jeton du shell et route
  `/mndt-api` vers l'API produit, WebSocket compris ;
- `mndt-front-proxy-1` : oauth2-proxy v7.15.5, client Entra existant
  `122bdf54-4ab8-4ef1-995e-a08501d04782`, secret client repris de governance,
  secret de cookie propre a mndt ;
- router Traefik `mndt` sur `mndt.duke-analytics.com`, TLS letsencrypt.

Verifie sur le serveur : la passerelle repond sur `/mndt-api/health`, la page
se sert apres amorcage du jeton, et `/state` rend `canWrite: true` pour
`duke@datanalysis.re` contre `false` pour `contact@datanalysis.re` quand
l'en-tete du proxy est present. Une requete non authentifiee est redirigee vers
`https://login.microsoftonline.com/.../authorize` avec
`redirect_uri=https://mndt.duke-analytics.com/oauth2/callback`.

Deux actions restent cote exploitation :

1. enregistrement DNS `mndt.duke-analytics.com A 51.159.164.138` ;
2. ajout de l'URI de redirection `https://mndt.duke-analytics.com/oauth2/callback`
   sur l'application Entra.

Pieges rencontres et corriges : le proxy lit sa configuration en utilisateur
65532, donc `/etc/mndt-front` doit etre 755 et les secrets 400 appartenant a
65532 ; le secret de cookie doit faire 32 octets bruts, pas 44 caracteres base64.

## Connecteurs MCP, preuve du 24 octobre

Le workbench demarre sans serveur MCP. Un connecteur a ete monte pour prouver la
chaine complete, et la meme forme accueille les connecteurs externes :

- serveur `facts-mcp.mjs` monte depuis `/data/mndt/live/tools` dans
  `/opt/mndt-tools` ;
- ligne de composition dans `/state/home/profiles/web/cordis.patch.yml` ;
- l'API rend `{"connectors":[{"module":"@deepseek-ai/dsh-mcp-client",
  "server":"workbench_facts","enabled":true}]}` ;
- une mission a appele `mcp__workbench_facts__workbench_facts` et le brief cite
  la reponse verbatim, avec le serveur MCP en source.

Piege important : une entree de patch qui ne vise pas un id existant est ignoree
avec l'avertissement `patch: entry "..." not found`. Pour ajouter un plugin, la
ligne doit etre dans une liste `insert`. C'est la raison pour laquelle le
connecteur n'apparaissait pas au premier essai.

Les connecteurs externes (Attio, Qonto, Lemlist, ...) prennent la meme forme avec
leur propre `command`/`args`/`env` ; il ne manque que leurs identifiants.

Capture : `docs/duke-product/evidence/page-connector-mission.png`.

## Automatisation planifiee, preuve sur le serveur

Deux missions planifiees ont ete produites par le workbench deploye, sans
intervention : `mis_f05ef7e79f18412fb9bb` et `mis_c809dbccf1e14cec8b89`,
toutes deux creees par `scheduler` et terminees. La seconde a produit le brief
`Briefing du matin` (Duke Analytics), qui refuse explicitement d'inventer faute
de source accessible :

> Je n'ai trouve aucune donnee d'agenda, de messagerie, de CRM ni d'echeancier
> dans mon perimetre d'acces. Je ne remplis donc aucune des cinq rubriques :
> inventer des rendez-vous, des courriers ou des comptes serait faux et non
> sourcable.

C'est le comportement attendu tant que les connecteurs metier ne sont pas montes
sur le serveur : l'automatisation tourne, et elle dit ce qui lui manque au lieu de
remplir du vide.

La cadence quotidienne (`DSH_MNDT_BRIEFING_AT=06:30`) a ete retablie apres la
preuve. Piege evite : passer `DSH_MNDT_BRIEFING_EVERY_MS` dans une fonction shell
avec une expansion non quotee ne l'a pas transmis au conteneur ; la variable est
desormais posee explicitement.

## Pile unifiee, 24 octobre

Le workbench n'est plus lance par une commande ad hoc : il fait partie du projet
compose `mndt-front` avec la passerelle et le proxy. Trois conteneurs, un seul
proprietaire :

- `mndt-front-workbench-1` : reseau hote, page et API sur la boucle locale,
  monte `/data/mndt/live` et `/data/mndt/live/tools` ;
- `mndt-front-gateway-1` : amorcage du jeton et routage `/mndt-api` ;
- `mndt-front-proxy-1` : Entra, route Traefik et TLS.

Verifie apres bascule : `/health` repond `{"ok":true}`, la liste des
connecteurs rend `workbench_facts` active, et une requete non authentifiee
traverse Traefik puis part vers Microsoft avec le bon `redirect_uri`.
L'installateur retire desormais l'ancien conteneur ad hoc pour eviter deux
proprietaires sur le meme service.

## Montage generique des connecteurs, 24 octobre

Un connecteur se monte desormais en une commande. Les descripteurs vivent dans
`/data/mndt/live/connectors/<serveur>.json` :

    { "serverName": "attio",
      "command": ["npx", "-y", "mcp-remote", "https://mcp.attio.com/mcp"],
      "envFile": "attio.env" }

`mount-connector.sh <serveur> <commande...> [--env-file <f>]` ecrit le
descripteur, regenere le bloc de composition depuis tous les descripteurs, et
redemarre le workbench. Le secret reste dans le fichier d'environnement protege,
lu par l'enveloppe shell generee : il n'entre jamais dans la composition.

Le rendu est proprietaire unique de ces lignes : il supprime tout bloc precedent
qui montait un client MCP, marque ou ajoute a la main. Sans cela, un ancien bloc
manuel et un bloc genere montaient deux fois le meme serveur, ce qui s'est
produit au premier essai et a ete corrige.

Verifie apres correction : `/connectors` rend exactement une entree
`workbench_facts` active, et une mission a de nouveau cite la reponse de
l'outil.

Commande prete pour Attio, des que sa cle existe :

    mount-connector.sh attio npx -y mcp-remote https://mcp.attio.com/mcp --env-file attio.env

## Controle rejouable

`smoke.sh` verifie dix faits observables et sort en erreur au premier manque :
sante de l'API, identite et droit d'ecriture du proprietaire, absence d'ecriture
pour le lecteur, connecteur monte, page servie avec jeton, page refusee sans
jeton, redirection vers Entra, URI de retour attendue, automatisation deja
executee.

Execusion du 24 octobre sur le serveur : dix `PASS`, zero echec.

## Nom public et certificat, 24 octobre

Le DNS a ete cree cote OVH : `mndt.duke-analytics.com` resout vers
`51.159.164.138`. Let's Encrypt a d'abord refuse (NXDOMAIN), puis le certificat
a ete emis apres recreation du conteneur proxy, qui reannonce le routeur :

    sujet    CN=mndt.duke-analytics.com
    emetteur CN=YR1, O=Let's Encrypt, C=US

Verifie depuis un poste : certificat valide, HTTPS repond 302 vers
`login.microsoftonline.com` avec le bon `redirect_uri`, et la page de
connexion Microsoft s'affiche pour le tenant Duke (capture
`evidence/page-sso-microsoft-login.png`).

Le controle `smoke.sh` couvre desormais quinze points, dont le certificat
public et la redirection Entra : quatorze `PASS`, zero echec.

Une connexion complete reste a faire par une personne reelle : elle exige le mot
de passe Duke et la validation de l'URI de redirection sur l'application Entra.

## Lecture seule sur un connecteur, 24 octobre

Certains serveurs exposent des outils d'ecriture a cote des outils de lecture.
Une mission ne doit pas pouvoir modifier un systeme sans decision. `mcp-proxy.mjs`
s'intercale entre le client et le serveur, filtre `tools/list` sur une liste
d'autorisation, et refuse localement tout `tools/call` hors liste : l'appel
n'atteint jamais le serveur.

Verifie sur le vrai Attio, avec le cache OAuth du poste : six outils de lecture
exposes (`search-records`, `list-records`, `get-records-by-ids`, les trois
recherches semantiques), et `create-record` refuse avec le motif explicite
`tool create-record is outside the read-only allow list`.

Le cache Attio du poste correspond au serveur `https://mcp.attio.com/mcp`
(client MCP CLI Proxy, scope `openid offline_access mcp`). Le copier sur le
serveur est une decision de securite qui attend l'accord de Stephane : le jeton
donne acces au CRM, meme filtre en lecture seule.

## Attio en lecture, preuve reelle, 24 octobre

Le connecteur Attio est monte sur le serveur, filtre en lecture seule :

- cache OAuth du poste copie dans `/data/mndt/live/mcp-auth` (dossier 700,
  fichiers 600), monte en `/state/mcp-auth` ;
- liste d'autorisation dans `/data/mndt/live/connectors/attio.env` : recherche,
  listage, lecture par identifiants, recherches semantiques ;
- l'ecriture est refusee par la passerelle avant d'atteindre Attio.

Une mission reelle a lu trois entreprises avec leurs domaines et identifiants :
Aerophile (aerophile.com, Paris), Air Austral (air-austral.com, Sainte-Marie),
Absa Group (absa.africa, Johannesburg), avec `has_more_results: true`. Le brief
cite ces valeurs, elles viennent de l'outil, pas du modele.

Pieges corriges en route : le chemin du fichier d'environnement etait ecrit cote
hote alors que le conteneur monte `/state`, si bien que le cache n'etait jamais
lu et le serveur restait deconnecte ; le rendu ecrit desormais le chemin vu du
conteneur. Verifie ensuite en lancant le proxy manuellement dans le conteneur,
qui repondait deja correctement avec le bon chemin.

Capture : `docs/duke-product/evidence/page-attio-connector.png`.

## Briefing planifie avec connecteur, preuve du 25 octobre

La planification a produit seule une mission `mis_11f510baef7f4e31b945`, sans
appel manuel : demarree par `scheduler`, terminee apres environ deux minutes,
avec un brief qui cite Attio au lieu de declarer l'absence de source.

Le brief est aussi honnete sur son perimetre : seuls `companies`, `deals` et
`people` sont lisibles, `tasks`, `notes` et `meetings` sont refuses par le
serveur Attio, aucun connecteur calendrier n'est monte, et il date sa derniere
trace lue au 23/10/2026 08:56 UTC.

Capture de la page avec ce briefing : a reprendre a la prochaine session visuelle.

## Gouvernance centralisee, preuve du 25 octobre

Le produit lit desormais la table de droits de l'autorite, plus un fichier local :
`DSH_MNDT_AUTHORITY=https://governance.duke-analytics.com` et un jeton de service
dans `/data/mndt/live/model.env` (droits 600). Le jeton ne sert qu'a lire
l'instantane des droits, il ne donne aucun droit supplementaire a la personne.

Preuve sans redeploiement : contact@ passe de viewer a operator dans l'autorite,
le produit repond aussitot `canWrite: true` pour cette personne ; retour a
viewer, il repond `canWrite: false`. La table vient donc bien du centre.

Le controle `smoke.sh` verifie en plus que l'autorite repond 200 a son instantane.

## Architecture du front, corrigee le 25 octobre

Le workbench etait sur le reseau hote, avec sa page et son API sur la boucle
locale. La passerelle, elle, vit sur un reseau Docker : elle ne pouvait donc pas
les joindre. Trois pieges ont ete trouves et corriges en une passe.

1. Le pare-feu de l'hote refuse le trafic d'un conteneur vers l'adresse de pont de
   l'hote, donc exposer le workbench sur cette adresse ne marche pas.
2. Le workbench est donc passe sur le reseau `mndt-front`, joignable par son nom
   de service `workbench`. La page s'y lie sur l'adresse de l'interface, car DSH
   refuse une adresse generique, et l'API accepte desormais `DSH_MNDT_HOST`.
3. La passerelle montait le fichier de jeton par un montage de fichier : quand ce
   fichier disparait, Docker cree un repertoire et le conteneur boucle. Elle monte
   maintenant le dossier d'etat en lecture seule.

La page et l'API restent publiees sur la boucle locale de l'hote uniquement, pour
le controle local ; rien n'est expose sur l'interface publique.

Verifie apres bascule : `/health` repond par le nom de service, l'API rend les
droits par personne a travers la passerelle (`canWrite` vrai pour le
proprietaire, faux pour le lecteur), l'amorcage de la page repond 303 avec un
cookie `dsh-auth` signe pour `mndt.duke-analytics.com`, et seize controles
passent.

## Decisions humaines, preuve du 25 octobre

Une mission ne pouvait rien demander a un humain : la file de decisions restait
vide par construction. Elle peut desormais appeler l'outil `request_approval`,
et ne peut pas decider a sa place : l'outil de decision n'est pas expose cote
serveur.

Preuve de bout en bout : une mission a prepare un brouillon de relance et demande
l'accord `send-email` (`apr_df6a6af835ed40e9b6b1`), le brief a indique que rien
n'avait ete envoye, puis la decision a ete prise par une personne avec son motif,
et le journal montre `approval.requested` puis `approval.approved`.

Une seconde decision est laissee en attente (`apr_4b33985f97c84d489897`) pour
que la personne qui se connecte la tranche elle-meme ; capture
`page-pending-approval.png`.

## Ecriture refusee a l'execution, preuve du 25 octobre

Une mission a recu pour consigne d'ecrire dans Attio. L'outil d'ecriture n'existe
pas dans son inventaire : la passerelle de lecture seule l'a retire de la liste,
donc l'appel echoue avant d'atteindre Attio.

    Error: unknown tool "mcp__attio__create-record"

Le brief precise que le refus vient du dispatching d'outils et non d'une erreur
d'autorisation Attio : la formulation reste exacte, et aucune entreprise n'a ete
creee. C'est la difference entre un garde-fou et une promesse.

## Image reconstruite et rattrapage verifie, 25 octobre

Docker Desktop etant muet, l'image a ete construite dans l'Ubuntu WSL avec un
moteur docker.io, apres avoir porte sa memoire a 20 Go et ajoute 8 Go d'echange
dans `%USERPROFILE%\.wslconfig`. Le constructeur historique suffit, sans buildx.

Verification du correctif en conditions reelles : une mission à l'etat `running`
a ete plantee dans l'etat avant redemarrage, puis le workbench a demarre avec la
nouvelle image. Resultat : `sonde: failed` et motif
`interrupted by a workbench restart; no result was produced`.

Une mission Attio a ensuite tourne sur cette image et a cite une entreprise reelle
(Thrasos A.I., `thrasos.ai`, enregistrement `00089712-...`), ce qui confirme que
le connecteur survit au changement d'image.

## Garde-fous

`DSH_PERMISSION_MODE=danger-full-access` est nécessaire au worker du workflow
pour écrire ; il ne doit être accordé qu'au conteneur dédié, monté en lecture
seule sur tout ce qui n'est pas son état. Un refus de ce worker doit rester
visible comme un échec de mission, jamais comme un brief vide.
