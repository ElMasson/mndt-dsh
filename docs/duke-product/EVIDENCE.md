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
| Outils bureau en mission | le brief cite `machine_desktop_open`, `machine_desktop_screenshot`, `machine_close` et la page « Microsoft, Sign in » capturee en 1280x800 | collab-acceptance-desktop.png, conteneur `desktop-duke-datanalysis-re` |
| Presence des agents | `scheduler` apparait dans la liste des agents avec l etat « agent, disponible » et son brief de briefing est rendu en titres et tableaux | collab-agent-presence.png |
| Garde-fou des actions sensibles | approbation en attente refusee, approbation accordee qui execute le clic | 28 octobre, chemins inchanges depuis |
| Production | `/health` a 200, racine en 302 vers la connexion Microsoft | 29 octobre, 18 h 55 |
| Deploiement par couches | les fichiers de page viennent d un montage, verifies dans le conteneur par recherche du texte servi | 29 octobre, `grep` dans le conteneur |

Incident du 29 octobre, pour memoire : trois shells de test laisses ouverts, environ
3,4 Go de memoire, et quatre deploiements par commit d image ont sature le disque et le
demon Docker. Le site est reste injoignable une partie de l apres-midi. Retablissement par
arret force des shells, redemarrage du workbench, passage au deploiement par couches
montees et limite memoire des shells ramenee a 1 Go. Etat final a 19 h : charge 2,2,
3,9 Go de memoire disponible, sante workbench a 200, aucun shell actif.

## 11. Manques v1 combles le 31 octobre

| Livraison | Constat mesure | Preuve |
|---|---|---|
| Vue Activite | liste du journal groupee par jour, filtre Tout, Humains, Agents, Moi, export CSV telechargeable | collab-activity.png, 46 lignes au total, 9 lignes avec le filtre Agents, CSV recu avec entete heure, acteur, action, objet, detail |
| Recherche globale | Ctrl K ouvre la palette, 4 resultats pour marketing, Entree ouvre le canal du mandat avec son panneau, une recherche example.com ouvre le brief de la mission | collab-search.png, verification navigateur du 31 octobre |
| Non-lus | badge bleu sur les canaux non consultes, efface a l ouverture | collab-unread.png, badge 2 puis 9+ avant lecture, disparition apres ouverture |
| Bandeau de mandat | sous l en-tete du canal, les faits lisibles sans cliquer : qui donne, a qui, jusqu a quand, combien, quel perimetre | collab-mandate-band.png |
| Identite des connecteurs | une mission lancee par gouvernance cree une approbation demandee par gouvernance, plus par la personne configuree dans l environnement | mission mis_792714d20d9f4cd689e1, approbation apr_b7613eff766a4c97882a, requestedBy gouvernance@datanalysis.re |

Le connecteur approvals lit desormais le fichier d acteur publie par le runner
(`/state/mission-actor.json`), avec repli sur MNDT_ACTOR pour les appels hors mission.
Deploiement du connecteur : copie du fichier dans `/data/mndt/live/tools/`, ajout de
`MNDT_ACTOR_FILE=/state/mission-actor.json` dans `connectors/approvals.env`, puis
`docker compose up -d --force-recreate workbench`. Sans cette recreation, le processus
MCP garde l ancien code et l ancienne identite.

## 12. Recette autonome du 1er novembre, trois identites

Suite executee par `docs/duke-product/acceptance/mndt-suite.mjs`, resultat archive dans
`docs/duke-product/acceptance/suite-2026-11-01.json`. Chaque identite ouvre la page,
mesure, puis ferme son contexte.

| Mesure | duke, owner | gouvernance, admin | smarion, operator |
|---|---|---|---|
| Page chargee | oui | oui | oui |
| Fond | rgb(246, 244, 241) | rgb(246, 244, 241) | rgb(246, 244, 241) |
| Police des titres | Space Grotesk | Space Grotesk | Space Grotesk |
| Canaux | 5 | 5 | 5 |
| Personnes au panneau | 5 | 5 | 5 |
| Agents au panneau | 1 | 1 | 1 |
| Lignes d activite | 23 | 23 | 23 |
| Lignes humaines | 14 | 14 | 14 |
| Resultats de recherche | 2 | 2 | 2 |
| Bandeau de mandat | oui | oui | oui |
| Panneau de contexte | oui | oui | oui |

Garde de la boite aux lettres, meme recette : une mission de gouvernance demandant la
lecture d un mail repond que la boite appartient a duke et refuse l acces, sans rien lire ;
une mission de duke lit le dernier mail et en cite l objet. Preuve : deux missions creees
le 1er novembre a 00 h 19, briefs correspondants, connecteur office365 garde par
`OFFICE365_OWNER` et par le fichier d acteur de mission.

Etat du serveur apres nettoyage : charge 6,1 juste apres l arret des trois shells, sante
workbench a 200, aucun shell actif, espace disque inchange a 3,8 Go libres. Les scripts de
sonde de `/root` sont retires, le script de deploiement `/root/deploy-layers.sh` est
restaure depuis le depot.

## 13. Filtres d activite et segregation par API, 1er novembre

Vue Activite, filtre par canal : 23 lignes au total, 4 lignes quand on choisit le canal du
mandat Reporting marketing, et le bouton « Tout marquer comme lu » fait passer les badges
de non-lus de 2 a 0. Preuve : collab-activity-filters.png, verification navigateur du
1er novembre a 01 h 12.

Suite d API en lecture seule, `docs/duke-product/acceptance/api-suite.py`, resultat archive
dans `docs/duke-product/acceptance/api-suite-2026-11-01.json`.

| Identite | Role | Ecriture | Admin | Missions | Briefs | Approbations | Mandats |
|---|---|---|---|---|---|---|---|
| duke | owner | oui | oui | 6 | 6 | 2 | 2 |
| gouvernance | admin | oui | oui | 3 | 3 | 2 | 2 |
| smarion | operator | oui | non | 4 | 4 | 2 | 2 |

Controles de segregation, tous vrais a l execution : les 3 missions privees de duke ne sont
pas visibles par smarion, la mission privee de smarion n est pas visible par duke, et les
3 missions d equipe sont visibles par les trois identites. Aucune ecriture dans cette suite,
seulement des lectures.

## 14. Passe mobile, 1er novembre a 01 h 50

Fenetre de 390 sur 844, ouverte en desktop puis redimensionnee pour eviter le parcours de
connexion. Mesures : largeur du document 390 pour une fenetre de 390, donc aucun debordement
horizontal ; barre de canaux en ligne de 45 px de haut au dessus du fil ; composeur visible ;
bandeau de mandat visible sur le canal du mandat ; 23 lignes dans la vue Activite.

Deux reserves honnetes : la barre laterale du shell DSH reste fixe a gauche et rogne le
premier bouton de canal quand la barre est defilee, et le controle automatique de visibilite
du fil a renvoye faux alors que les cartes sont bien rendues sur la capture, donc je retiens
la capture, pas ce controle. Preuves : collab-mobile.png et collab-mobile-activity.png.

## 15. Latence percue, jeu de demonstration nettoye, sauvegarde, 1er novembre a 02 h 10

**Latence.** Mesuree au navigateur, du debut de navigation jusqu a l espace de collaboration
visible, apres recreation du workbench.

| Moment | DOM pret | Espace visible | Conclusion |
|---|---|---|---|
| Premier chargement apres recreation | 91 s | non atteint en 252 s | le premier visiteur paie la creation du shell |
| Rechargement a chaud | 2,0 s | 7,8 s | usage normal |

Le premier chargement est donc lent, et il n est pas acceptable pour une recette avec des
personnes. Ce n est pas la page mais la creation du conteneur de shell. La parade retenue :
ouvrir la page une fois par personne avant une demonstration ou une recette, puis verifier
que le rechargement est sous dix secondes. C est ecrit dans le runbook de deploiement.

**Jeu de demonstration.** L etat contenait trois briefings identiques du scheduler et deux
missions de test. Nettoye : 4 missions, 4 briefs, 2 approbations, 2 mandats. Le canal equipe
montre maintenant un briefing de l agent, une mission navigateur de duke, une approbation
actionnable demandee par gouvernance et une approbation volontairement bloquee pour duke.
Preuve : collab-demo-clean.png, 19 posts, 3 missions et 3 briefs dans le panneau.

**Sauvegarde.** Copie manuelle avant modification :
`/data/mndt/backups/state-20261101T010230Z.json`, 71 346 octets, lisible. La procedure de
restauration est dans `DEPLOY-LAYERS.md`.

## 16. Focus clavier et ouverture directe sur le brief, 1er novembre a 02 h 25

**Focus clavier.** En tabulant depuis l exterieur jusqu a la zone de collaboration, le
premier controle atteint est le bouton de recherche, avec un contour mesure a 2 px, plein,
couleur rgb(52, 69, 209). Le style est desormais explicite pour tous les boutons, champs,
listes et zones de texte de la page.

**Ouverture directe.** Un clic sur une ligne d activite de type mission ouvre le canal, ouvre
le brief de la mission et fait defiler la carte au centre de la fenetre. Mesure : un brief
ouvert, carte a 194 px du haut dans une fenetre de 1000 px, donc visible sans chercher.
Preuve : collab-a11y-focus.png.

**Etat de chargement.** L ecran d attente porte maintenant un role `status` et une annonce
polie, pour qu un lecteur d ecran signale l attente au lieu de rester muet.

## 17. Demarrage a froid corrige par prechauffage, 1er novembre a 02 h 50

Le demarrage lent n etait pas la page : c est la creation du shell, faite au premier
visiteur. Un script de prechauffage la declenche maintenant pendant le deploiement.

| Mesure | Avant prechauffage | Apres prechauffage |
|---|---|---|
| Creation du shell (cote serveur) | payee par le premier visiteur | 138 s pendant le deploiement |
| DOM pret, premiere visite navigateur | 91 s | 2,2 s |
| Espace de collaboration visible | non atteint en 252 s | 6,9 s |

Le script `warm-shells.sh` interroge la passerelle avec l en-tete de duke et compte un 302
comme un succes, avec quatre tentatives. Il est appele par `deploy-layers.sh` juste apres le
controle de sante. Deux executions independantes ont donne 137 s et 138 s de creation, puis
2,2 s et 6,9 s pour la premiere visite reelle.

Reserve : le prechauffage ne couvre par defaut que duke. Pour une recette avec plusieurs
personnes, passer les trois identites a `warm-shells.sh` avant d ouvrir les navigateurs.

## 18. Recette finale sur le jeu nettoye, 1er novembre a 03 h 15

Suite navigateur et suite API reexecutees apres le nettoyage et le prechauffage. Resultats
archives dans `acceptance/mndt-suite-final.json` et `acceptance/api-suite-final.json`.

| Mesure | duke | gouvernance | smarion |
|---|---|---|---|
| Page chargee | oui | oui | oui |
| Canaux | 5 | 5 | 5 |
| Personnes et agents au panneau | 5 et 1 | 5 et 1 | 5 et 1 |
| Lignes d activite | 14 | 14 | 14 |
| Lignes humaines | 11 | 11 | 11 |
| Resultats de recherche | 2 | 2 | 2 |
| Bandeau de mandat et panneau de contexte | oui | oui | oui |

Suite API : duke owner, gouvernance admin, smarion operator sans droit admin ; 3 missions
pour duke, 1 pour gouvernance, 2 pour smarion ; 2 approbations et 2 mandats. Les trois
controles de segregation sont vrais : les missions privees de duke restent invisibles a
smarion, celle de smarion reste invisible a duke, et la mission d equipe du scheduler est
visible par les trois identites.

Limite de cette preuve : ce sont des controles automatises, pas des personnes. La recette
humaine est preparee, avec un parcours court de quinze minutes et les resultats partiels du
30 octobre, mais elle n a pas encore ete jouee sur cet etat.

## 19. Mobile sans barre rognee, 1er novembre a 03 h 30

La reserve du tour precedent est levee. Sous 820 px, la liste des canaux disparait au profit
d un selecteur dans l en-tete, accompagne d un bouton Activite et du bouton Rafraichir.
Mesure a 390 sur 844 : largeur du document 390, aucun debordement, liste des canaux masquee,
barre mobile visible, choix d un canal met a jour le titre et le bandeau, bouton Activite
ouvre la vue avec 14 lignes. Preuves : collab-mobile-select.png et collab-mobile-activity.png.

## 20. Panne simulee et reprise, 1er novembre a 04 h 00

Panne simulee en bloquant l appel `/state` dans le navigateur. La page affiche un message en
francais, « L espace n a pas repondu. Verifiez la connexion, puis reessayez. », avec un bouton
Reessayer. Une fois l appel retabli, un clic sur Reessayer recharge l espace complet, 5 cartes
affichees. Aucune page blanche, aucune erreur technique brute affichee.

Mesure : erreur affichee oui, message francais oui, reprise apres clic oui, 5 cartes apres
reprise. Le texte brut « Failed to fetch » a ete remplace par ce message apres une premiere
execution qui l affichait.

## 21. Verification finale de l etat en production, 1er novembre a 04 h 12

Dernier passage des trois suites, sur l etat exactement servi par
https://mndt.duke-analytics.com apres la livraison de la gestion d erreur. Archives :
`acceptance/mndt-suite-final.json`, `acceptance/mobile-final.json`,
`acceptance/api-suite-final.json`.

Suite navigateur, trois identites : page chargee, 5 canaux, 5 personnes et 1 agent au
panneau, 14 lignes d activite dont 11 humaines, 2 resultats de recherche, bandeau de mandat
et panneau de contexte visibles. Identique pour duke, gouvernance et smarion.

Suite mobile a 390 : aucun debordement, canaux masques, barre mobile visible, choix d un
canal met a jour le titre et le bandeau, vue Activite ouverte avec 14 lignes.

Suite API : duke owner, gouvernance admin, smarion operator sans droit admin ; 3 missions
pour duke, 1 pour gouvernance, 2 pour smarion ; 2 approbations, 2 mandats ; les trois
controles de segregation sont vrais.

Ce que ces preuves ne disent pas : elles sont automatisees, pas humaines. La recette avec
des personnes reste a jouer sur cet etat, avec le parcours court de `USER-TESTS.md`. Les
resultats partiels du 30 octobre sont dans `USER-TESTS-RESULTS.md`.

## 22. Limites connues a la fin de la nuit

1. Le prechauffage des shells ne couvre par defaut que duke. Pour trois personnes, lancer
   `sh warm-shells.sh` avec les trois identites avant la session.
2. La recherche porte sur l etat charge en memoire. Au dela de quelques milliers d objets,
   il faudra un index serveur.
3. Le shell DSH garde sa barre laterale fixe, qui reduit la largeur utile sur mobile ; la
   page s y adapte, mais l espace restant est etroit.
4. Aucune notification hors de la page : pas de mail, pas de push. C est volontaire dans
   cette version.

## 23. Retrait de la page en doublon, 1er novembre a 17 h 05

`MndtPage.tsx` n etait plus monte nulle part : `index.ts` enregistre `CollabPage` sur le slot
principal, et la seule reference restante etait son export public. Les types qu il portait
sont deplaces dans `face.ts`, puis la page et ses deux composants internes, `Onboarding.tsx`
et `GuidedTour.tsx`, sont supprimes.

Suppression nette : 52 Ko de source en moins (page 43 Ko, accompagnement 9 Ko), aucune
dependance restante, `tsc` et le lint passent, build client OK. Verification navigateur
apres deploiement : 5 canaux, barre mobile masquee sur desktop, 6 cartes affichees. Le
comportement de production est identique, avec une seule page a maintenir.

Commande de verification des references restantes : `rg -n "MndtPage" packages` ne doit plus
rien retourner.
