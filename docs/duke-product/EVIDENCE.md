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
| Ecriture refusee a l execution | mission tentant create-record : outil absent de l inventaire, refus unknown tool, brief qui distingue refus de dispatching et autorisation Attio | serveur, 25 octobre |
| Connecteur metier Attio, lecture seule | mission reelle : trois entreprises lues avec domaines et identifiants, ecriture refusee par la passerelle | serveur, capture page-attio-connector.png |

## 4. Automatisations planifiees

| Element | Preuve | Ou |
| --- | --- | --- |
| Briefing planifie local | mission `done`, auteur `scheduler`, brief date | capture `page-scheduled-briefing.png` |
| Briefing planifie serveur | deux missions `scheduler` terminees, brief `Briefing du matin` (Duke Analytics) | etat du serveur, 24 octobre |
| Honnetete du brief | il refuse de remplir les cinq rubriques faute de source | texte du brief, cite dans DEPLOYMENT.md |
| Briefing planifie avec connecteurs | mission mis_11f510baef7f4e31b945, creee par scheduler, terminee seule : brief citant Attio (companies, deals, people), derniere trace lue le 23/10 08:56 UTC, limites declarees | serveur, 25 octobre |

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
| DNS public | resout, certificat Let's Encrypt valide | serveur, 24 octobre |
| URI Entra | enregistree par Stephane le 25 octobre sur l'application `122bdf54-4ab8-4ef1-995e-a08501d04782` | portail Entra |
| Authentification Entra reelle | `[AuthSuccess] Authenticated via OAuth2` pour `duke@datanalysis.re`, id_token present, 25 octobre 08:34:36 | journaux du proxy |
| Chaine dans un navigateur reel | Chrome : 302, autorisation, retour avec code, session posee par la passerelle, 200, aucune boucle, espace de travail ouvert | recette du 25 octobre |
| Connexion complete dans le navigateur de Stephane | page affichee avec son identite apres connexion Entra, 26 octobre, capture page-authenticated-stephane.png | navigateur de Stephane |
| Marque mndt dans le hero | ruban mndt a la place du logo par defaut, capture page-hero-mndt.png | serveur, 26 octobre |
| Carte de premiers pas | quatre gestes avec leur etat reel, bloc equipe, capture page-onboarding-full.png | serveur, 26 octobre |

## 8. Personnel par defaut, partage explicite

| Element | Preuve | Ou |
| --- | --- | --- |
| Mission privee par defaut | mission creee par duke : `visibility=private`, absente de la liste du compte en lecture, lecture directe refusee 403 | verification du 26 octobre |
| Partage explicite | apres `POST /missions/:id/visibility`, la mission devient visible du compte en lecture | verification du 26 octobre |
| Brief herite | le brief produit par une mission privee reste prive, puis suit le partage | code et verification |
| Refus de partage | un lecteur qui tente de partager la mission d autrui recoit 403 | verification du 26 octobre |
| Note personnelle | `scope=user` par defaut, invisible du lecteur, puis partageable | verification du 26 octobre |
| Automatisation d equipe | 17 missions d equipe visibles par le compte en lecture | verification du 26 octobre |
| Page | trois perimetres (tout, mes elements, equipe), etiquettes prive/equipe, boutons de partage | captures page-hybrid-shared.png et page-hybrid-mine.png |

| Autorite centrale branchee | le produit lit la table par /governance/snapshot : duke owner, contact viewer | verification du 26 octobre |
| Changement de role sans redeploiement | contact promu operator puis remis viewer via l autorite, role et canWrite suivis a chaque fois | verification du 26 octobre |
| Ecran des membres | liste lue a l autorite, ajout et retrait reserves a rights.write, lecteur refuse 403 | verification et capture |
| Jetons par personne | mission de controle : 795 en entree, 742 en sortie, 16 512 lus en cache ; agregat par personne et table equipe pour les admins | verification du 26 octobre |
| Connecteur Office365 monte | 4 connecteurs lus par le produit : approvals, attio, office365, workbench_facts | verification du 26 octobre |
| Lecture reelle de la boite | mission DSH : deux derniers courriers avec sujets et expediteurs reels, aucun envoi | verification du 26 octobre |
| Jeton Office365 protege | /data/mndt/live/mcp-auth/office365.json, mode 600, rafraichi a la demande, jamais affiche | verification du 26 octobre |
| Heure du briefing reglable | 06:30 vers 06:15 par l API, fichier sur disque, survit au redemarrage, lecteur 403, heure invalide 400 | verification du 26 octobre |
| Visite guidee | sept etapes, du role a l automatisation, fermeture et memoire cote navigateur | capture page-tour.png |
| Session navigateur isolee | deux identites, deux captures reelles de example.com, conteneurs supprimes | sandbox-browser-duke.png |
| Isolation verifiee | non root, racine en lecture seule, cap-drop ALL, no-new-privileges, 768 Mo, 128 processus, 1 vCPU | docker inspect du 27 octobre |
| Machine branchee au produit | POST /machines/capture par duke : ok, 67 241 octets, 25 secondes ; lecteur 403 ; aucune session restante | machine-capture-duke.png |
| Disque de production assaini | /data de 97 % a 72 %, 26 Go libres, une seule image workbench, Tellus intact | 27 octobre |
| Un shell par personne | duke et smarion : deux instances, deux pages 200, identite correcte a l API centrale | verification du 27 octobre |
| Sessions cloisonnees | partagee 2 elements, duke 0, smarion 0 ; repertoires et jetons distincts | verification du 27 octobre |
| Passerelle par identite | x-forwarded-email vers l instance de la personne, cookie de session propre, reprise si le jeton tourne | verification du 27 octobre |
| Quota par personne et global | deux demandes pour duke : une 200 une 429 ; trois personnes : deux 200 une 429 | verification du 27 octobre |

| Page servie par l instance de duke | identite duke@datanalysis.re, role owner, aucune session locale, donnees produit centrales | page-per-person-shell.png |
| Membres a jour sur cette page | duke owner, contact viewer, smarion operator | page-per-person-shell.png |

| Rotation du jeton de shell | instance de smarion redemarree sans toucher la passerelle, page 200 apres reprise | verification du 27 octobre |

| Image propre construite depuis la source | commit 21106d7, 7 portes sur 7, code de sortie 0, image 88548b6ae295 | 27 octobre |
| Image propre en service | workbench recree sur l image construite, sante ok, machine ok, lecteur 403, shell duke 200, 0 echec | 27 octobre |

| Session navigateur interactive | goto, fill, click, text, screenshot sur httpbin.org ; formulaire envoye avec "Duke Analytics" | browser-form-submitted.png |
| Refus et fermeture | lecteur 403 sur les operations ; stop ne laisse aucun conteneur browser- | 27 octobre |

| Navigation depuis la carte | ouvrir, saisir, cliquer et lire dans la page ; reponse avec "Duke depuis la carte" | browser-card.png |

| Bureau isole, computer use | open, click, type, key, screenshot ; formulaire envoye avec "Duke au bureau" depuis Xvfb | desktop-typed.png, desktop-submitted.png |
| Carte bureau | ouvrir, cliquer, saisir, Entree, fermer, capture affichee dans la page | desktop-card.png |

| Office365, lecture reelle | mission mis_257f0e481daf4937aabc : deux courriers de la boite duke, expediteurs et sujets | brief de la mission, 27 octobre |
| Bureau, capture apres chargement | 16 220 caracteres, formulaire plein ecran, capture non vide | 27 octobre |

| Office365, agenda reel | mission mis_600bad4fbcd848d19c08 : rendez-vous des 28 et 29 octobre, salles Teams | brief de la mission, 27 octobre |

| Rotation des jetons internes | machines, central et shells tournes ; ancienne empreinte differente de la nouvelle ; pages 200 apres reprise | 27 octobre, /data/mndt/rotation |
| Jetons de shell republies | les deux empreintes changent, gateway repond 200 sans redemarrage manuel | 27 octobre |

| Mandat, contresignature | duke ne peut pas signer son propre mandat (403) ; gouvernance le signe (200, active) | mission mnd_2a2537e15ce742ad9aa5, 28 octobre |
| Mandat, application des regles | hors perimetre 403, mission autorisee done, plafond 403, apres retrait 403 | memes appels, journal |
| Journal, acces et export | proprietaire 200 en JSON et CSV, lecteur 403, refus ecrits avec motif | journal 91 lignes, 28 octobre |
| Carte Mandats | liste, etat, plafond, echeance, signataire, formulaire et exports | mandates-card.png |

| Mandat, perimetre de connecteurs | mandat sans attio refuse une mission account-review (403), mandat complet l accepte (done) | 28 octobre, journal |

## 9. Limites connues, dites explicitement

- Le shell reste un espace de travail partage : ses sessions et ses fichiers ne
  sont pas cloisonnes par personne. Le cloisonnement porte sur les donnees du
  produit (missions, briefs, notes), pas sur le shell.
- Un connecteur metier est monte (Attio, lecture seule) avec les outils internes
  d approbation et de faits. Les autres systemes Duke demandent leurs acces.
- L ajout de membres passe par un script serveur, pas par un ecran d admin.
- La reconstruction complete de l image a echoue deux fois par disque hote plein
  (4 Go libres) ; l image en service est construite par couche sur une base
  validee, et la reconstruction depuis la source reste a refaire quand l espace
  le permettra. Le code source, lui, est complet et les paquets se compilent.
- La cle du modele est stockee sur le serveur dans un fichier protege ; elle est
  a faire tourner apres les tests.

## 10. Espace de collaboration, recette du 29 octobre

| Point | Constat mesure | Preuve |
|---|---|---|
| Trois colonnes et fil | canaux a gauche, fil structure au centre, contexte du mandat a droite | collab-demo-duke.png |
| Langage visuel Lovable | fond `rgb(246,244,241)`, texte Inter, titres Space Grotesk, cartes 16 px, boutons 12 px | styles calcules dans le navigateur, collab-acceptance.png |
| Composeur de mission | mission visible 6 s apres le clic, terminee en 22 s, brief consultable | collab-dry-run.png |
| Cartes d approbation decisionnelles | gouvernance decide une demande de duke, compteur de 3 a 2 | collab-approval-decide.png |
| Roles | operateur : boutons grises, opacite 0,4, raison affichee ; lecteur : aucun bouton actif, composeur desactive | collab-demo-smarion.png, collab-viewer.png |
| Confidentialite des briefs | le brief d une mission privee n apparait pas chez les autres, verifie sur trois comptes par `/state` | 29 octobre, requetes API |
| Outils machine en mission | le brief cite `machine_browser_open`, `machine_browser_read`, `machine_close` et le titre « Example Domain » lu | collab-acceptance-machine.png, conteneur `browser-duke-datanalysis-re` |
| Garde-fou des actions sensibles | approbation en attente refusee, approbation accordee qui execute le clic | 28 octobre, chemins inchanges depuis |
| Production | `/health` a 200, racine en 302 vers la connexion Microsoft | 29 octobre, 18 h 55 |
| Deploiement par couches | les fichiers de page viennent d un montage, verifies dans le conteneur par recherche du texte servi | 29 octobre, `grep` dans le conteneur |

Incident du 29 octobre, pour memoire : trois shells de test laisses ouverts, environ
3,4 Go de memoire, et quatre deploiements par commit d image ont sature le disque et le
demon Docker. Le site est reste injoignable une partie de l apres-midi. Retablissement par
arret force des shells, redemarrage du workbench, passage au deploiement par couches
montees et limite memoire des shells ramenee a 1 Go. Etat final a 19 h : charge 2,2,
3,9 Go de memoire disponible, sante workbench a 200, aucun shell actif.
