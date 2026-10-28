# mndt, espace de collaboration

Specification UI et UX, version 1, 28 octobre 2026.

Ce document definit l interface cible de mndt. Il ne decrit pas une messagerie. Il decrit
un espace de travail ou des humains et des agents IA collaborent dans un cadre explicite,
le mandat, et ou chaque action laisse une trace.

La reference de structure est Slack, parce que tout le monde sait s y reperer en dix
secondes : un rail a gauche, une liste de canaux, un fil central, un panneau de contexte,
un composeur en bas. La reference de contenu n est pas Slack. Un canal n est pas une
conversation de bavardage, c est un cadre de travail avec des regles, des participants,
des limites et des decisions.

---

## 1. Le probleme que l interface doit resoudre

Aujourd hui, mndt montre une page unique, "This morning", qui empile des cartes : premiers
pas, decisions en attente, missions, briefs produits, membres, briefing automatique,
jetons consommes. C est lisible, mais ce n est pas un espace de travail. On ne voit pas
"qui travaille avec qui, sous quel mandat, sur quoi, et ou en est la decision".

Trois entites portent tout le produit :

1. **Le mandat.** Un cadre signe entre un mandant et un delegataire, humain ou agent. Il
   dit qui agit pour qui, sur quel perimetre, avec quelles limites, jusqu a quand, et ce
   qui exige une decision humaine. Un mandat a un etat : propose, actif, retire, expire.
2. **La mission.** Une unite de travail demandee dans le cadre d un mandat, ou hors
   mandat pour un travail strictement personnel. Elle produit un brief, des sources, des
   jetons consommes, et parfois une demande d approbation.
3. **L approbation.** Une decision qu un humain doit prendre avant que quelque chose
   sorte du batiment : envoyer, publier, depenser, supprimer. Elle n appartient jamais au
   delegataire, meme quand le delegataire est un agent.

L interface doit rendre ces trois entites visibles a tout moment, et rendre les agents
aussi presents que les humains, sans les confondre.

---

## 2. Ce que l on reprend de Slack, et ce que l on ne reprend pas

| Element Slack | Repris | Adaptation mndt |
|---|---|---|
| Rail des espaces de travail | oui | Un seul espace, mndt. Le rail accueille l identite, les statuts et les acces rapides. |
| Liste de canaux | oui | Canaux d equipe, canaux de mandat, canaux de dossier, canal systeme. |
| Fil central | oui | Fil d activite structure, pas de messages libres melanges. |
| Composeur | oui | Il ne "discute" pas, il lance une mission ou publie une note dans le cadre. |
| Thread | oui | Discussion attachee a une mission ou a une approbation, pas a un message isole. |
| Panneau de contexte | oui | Details du mandat, des participants, des limites, des missions liees. |
| Presence | oui | Disponible, en mission, hors ligne, pour les humains et pour les agents. |
| Mentions | oui | Une mention d agent cree une mission. Une mention d humain notifie. |
| Reactions | non | Un signet et un accusé de lecture suffisent. Les reactions sont du bruit. |
| Messages directs | non | On ne parle pas en prive a un agent. Toute action d agent passe par un canal et un cadre. |
| Appels et huddles | non | Hors perimetre. |
| Canaux libres crees par n importe qui | non | Un canal se cree depuis un mandat ou un dossier, avec une regle d acces. |

La difference structurante : dans Slack, un canal est un flux de messages. Dans mndt, un
canal est un **perimetre de responsabilite**. Chaque post a un type, un auteur, un cadre,
et souvent une consequence.

---

## 3. Modele d information

### 3.1 Espace

Un seul espace par organisation, ici Duke Analytics. Il porte le nom, le logo, les
membres, les roles et les politiques globales.

### 3.2 Canal

Un canal a un type, un nom, une visibilite, des participants et un cadre.

| Type | Nom affiche | Cree par | Contenu typique |
|---|---|---|---|
| `team` | Equipe | owner | Annonces, activite generale, decisions d organisation |
| `mandate` | Mandat NOM | creation du mandat | Missions du mandat, decisions, journal du mandat |
| `client` | Dossier CLIENT | owner ou admin | Missions, briefs, rendez-vous, pieces jointes |
| `system` | Systeme | produit | Briefing automatique, refus, expirations, erreurs |

Regles : un canal `mandate` est cree et archive avec le mandat. Un canal `client` se cree
a la main. Un canal `system` n est jamais ecrit par un humain. Un canal prive n apparait
qu a ses participants.

### 3.3 Post

Un post est une entree du fil. Il est immuable, horodate, attribue a un acteur, et
rattache a un cadre.

| Type de post | Auteur | Rendu |
|---|---|---|
| `note` | humain | Texte court, avec mention et piece jointe possibles |
| `mission` | humain | Carte de lancement : demande, mandat, perimetre, bouton "Ouvrir" |
| `agent-reply` | agent | Reponse de mission : brief en markdown, sources, jetons, bouton "Voir le brief" |
| `event` | systeme | Ligne discrete : mission lancee, terminee, refusee, mandat signe, mandat retire |
| `approval` | agent ou systeme | Carte decisionnelle : titre, nature, montant ou cible, boutons Approuver et Refuser |
| `brief` | agent | Artefact deplie : titre, resume, sections, sources, telechargement |
| `evidence` | agent ou humain | Capture, journal, preuve rattachee a une mission |
| `mandate-update` | systeme | Changement d etat du mandat, avec motif et auteur |

Chaque post porte des metadonnees invisibles : identifiant, canal, mission, mandat,
visibilite, jetons, duree.

### 3.4 Thread

Un thread est attache a un post structurant, une mission ou une approbation. Il sert a
discuter de la decision, jamais a relancer une conversation infinie. Le thread d une
approbation contient le motif de refus et les echanges qui ont mene a la decision. Le
thread se ferme quand la decision est prise, et reste consultable.

### 3.5 Membre

Un membre est un humain ou un agent.

Humain : nom, adresse, role global (viewer, operator, admin, owner), mandats dont il est
mandant ou delegataire, presence.

Agent : nom, type, modele, mandats dont il est delegataire, presence, mission en cours,
jetons consommes du jour, limites. Un agent n a pas d adresse mail, ne recoit pas de
notification et ne possede pas de mot de passe.

### 3.6 Presence

| Etat | Humain | Agent |
|---|---|---|
| `available` | connecte, disponible | pret, peut recevoir une mission |
| `working` | en reunion ou en focus | execute une mission, avec le libelle de la mission |
| `away` | inactif depuis plus de quinze minutes | en attente d une approbation pour continuer |
| `offline` | deconnecte | arrete, mandat expire ou quota atteint |

La presence est informative. Elle ne bloque rien, sauf un agent hors ligne qui ne peut pas
recevoir de mission.

---

## 4. Anatomie de l ecran

```
+------+----------------+--------------------------------------------+-------------------+
| rail | liste canaux   | en-tete du canal                           | contexte          |
| 68px | 264px          | 56px                                       | 320px             |
|      |                |                                            |                   |
| logo | Equipe         | # Mandat ACME     3 membres   mandat actif | Mandat            |
| +    | Mandats        |--------------------------------------------| Mandant           |
| act. |  ACME          | fil d activite                             | Delegataire       |
| mand |  EXCO          |                                            | Perimetre         |
| regl | Dossiers       |  post  post  post  post                    | Limites           |
|      |  Duke          |                                            | Echeance          |
|      | Systeme        |                                            | Missions liees    |
|      |                |--------------------------------------------| Approbations      |
|      |                | composeur                                  | Journal           |
+------+----------------+--------------------------------------------+-------------------+
```

Largeurs : rail 68 px fixe, liste 264 px redimensionnable de 220 a 320, contexte 320 px
repliable, fil central elastique avec largeur de lecture maximale 760 px.

Hauteur d en-tete : 56 px. Le fil et le contexte sont les seules zones qui defilent
independamment. Le composeur colle au bas de la colonne centrale.

### 4.1 Rail

En haut le symbole mndt. Puis : bouton composer, Activite avec badge, Mandats, Reglages.
En bas : avatar de la personne avec son role, et un bouton de repli du rail.

### 4.2 Liste des canaux

Groupes repliables : Equipe, Mandats, Dossiers, Systeme. Chaque ligne montre le nom, un
badge d etat pour les mandats (propose, actif, expire), et un compteur de non-lus. Un
bouton "+" en tete de groupe cree un canal quand le role le permet. Une recherche locale
filtre la liste.

### 4.3 En-tete du canal

Nom du canal, sujet sur une ligne, avatars des participants, etat du mandat, boutons :
Membres, Approbations en attente, Plus (renommer, archiver, exporter le journal). Pour un
canal systeme, pas de composeur et un libelle explicite.

### 4.4 Fil

Ordre chronologique inverse ou direct, au choix memorise. Les posts d evenement sont
compacts sur une ligne, les posts de mission et d approbation sont des cartes, les briefs
sont replies par defaut avec un apercu de trois lignes. Les separateurs de jour sont
discrets.

### 4.5 Composeur

Une zone de saisie, trois modes explicites :

1. **Note** : publie une note dans le canal, avec mention possible.
2. **Mission** : ouvre un panneau de lancement (type de mission, mandat, consigne,
   visibilite privee ou equipe, pieces jointes). Le bouton "Lancer" cree la mission.
3. **Approbation** : jamais creee par un composeur humain, elle vient du travail de
   l agent ou d une politique.

Le composeur rappelle au-dessus de lui le cadre courant : "Vous ecrivez dans Mandat ACME,
en tant que delegataire, limite 3 missions par jour, echeance 30 novembre".

### 4.6 Panneau de contexte

Il change selon le canal.

Pour un mandat : parties, perimetre, connecteurs autorises, limites (missions par jour,
visibilite par defaut, depenses), echeance, etat, historique des signatures, missions
liees, approbations en attente, bouton Retirer pour l owner ou l admin.

Pour un dossier : clients, contacts, missions, briefs recents, echeances.

Pour un canal systeme : filtres par type d evenement et export du journal.

---

## 5. Les cartes, en detail

### 5.1 Carte de mission

```
+--------------------------------------------------------------+
| Mission  briefing        mandat ACME        privee           |
| Prepare le briefing du jour, agenda et courriers en attente   |
| lancee par duke@datanalysis.re il y a 12 min   en cours      |
| progression : 2 etapes sur 4   jetons 1 240                  |
| [Voir le direct]  [Ouvrir le brief]                           |
+--------------------------------------------------------------+
```

En cours : barre de progression discrete et bouton "Voir le direct" qui ouvre le journal
de la mission. Terminee : bouton "Ouvrir le brief". Echouee : motif exact, jamais une
excuse generique, et bouton "Relancer".

### 5.2 Carte d approbation

```
+--------------------------------------------------------------+
| Approbation requise                          spend           |
| Relance commerciale aupres d EXCO ANIS                        |
| Montant 0 EUR   cible courriel brouillon   mandat ACME        |
| demandee par l agent briefing il y a 4 min                    |
| [Approuver]  [Refuser]   motif obligatoire pour un refus      |
+--------------------------------------------------------------+
```

Les boutons ne sont actifs que pour un owner ou un admin, et jamais pour le delegataire de
la demande, meme si ce delegataire est owner par ailleurs. Un refus exige un motif. La
decision ecrit un post `event` dans le canal et une ligne dans le journal du mandat.

### 5.3 Carte de brief

Titre, resume en trois lignes, sections repliables, sources listees avec liens, jetons,
duree, bouton "Telecharger en markdown". Un brief ne se modifie pas. Une correction est un
nouveau brief lie.

### 5.4 Post d evenement

Une seule ligne, grise, avec icone et heure. Exemples : "Mandat ACME signe par
gouverneur@datanalysis.re", "Mission refusee, limite de 3 missions par jour atteinte",
"Mandat EXCO expire le 15 novembre".

---

## 6. Presence des agents et collaboration mixte

Chaque agent apparait comme un membre a part entiere, avec un avatar carre, un nom, et son
etat. Trois regles :

1. Un agent ne parle jamais sans mission. Son post est toujours la reponse a une mission,
   avec le brief et ses sources.
2. Un agent peut demander une approbation et attendre. La carte d approbation dit
   explicitement qu il est bloque en attente.
3. Un agent ne peut pas etre mentionne dans un canal ou il n a pas de mandat. La mention
   propose alors de creer un mandat, elle ne cree pas la mission.

Un humain peut demander a un agent de continuer une mission existante, par une note dans
le thread de la mission. Cela cree un suivi, pas une nouvelle conversation.

---

## 7. Activite et notifications

Une vue "Activite", accessible depuis le rail, agrege : approbations en attente, missions
echouees, mandats qui expirent dans sept jours, mentions, briefs recus. Elle se filtre par
type et par canal. Elle est la seule source de badges de non-lus avec la liste des canaux.

Pas de notification par mail dans cette version. Le badge reste local a l espace.

---

## 8. Recherche

Une recherche globale, raccourci Ctrl K, sur : canaux, personnes, agents, mandats,
missions, briefs, approbations, evenements. Resultats groupes par type, avec extrait et
lien profond. La recherche respecte les droits : un viewer ne voit pas un canal prive.

---

## 9. Regles de securite dans l interface

1. Un mandat expire ne peut plus recevoir de mission. Le composeur le dit avant l envoi.
2. Un delegataire ne voit jamais l approbation qu il a demandee comme une decision qu il
   pourrait prendre. Les boutons sont absents, pas seulement desactives.
3. Un canal prive n affiche ni son nom ni son existence aux non participants. Le lien
   profond repond "indisponible".
4. Le journal d un mandat est exportable par l owner et l admin seulement, en CSV et JSON.
5. Toute action d agent affiche le mandat et la mission qui l autorisent. Un post d agent
   sans ces deux references ne doit pas exister.
6. Les jetons et les secrets ne sont jamais affiches, seulement les compteurs.

---

## 10. Design system applique

Jetons issus du projet Lovable mndt, deja releves : offwhite `#F6F4F1`, charbon
`#0C0F17`, blanc `#FFFFFF`, ardoise `#5A6475`, bordure `#E2E4E9`, surface `#F0EFED`, accent
electrique `#4B5CFF`, violet `#8B68FF`, succes `#16724B`, alerte `#8A4B00`, danger
`#B3261E`.

Typographie : Space Grotesk pour les titres de canal, les titres de carte et les chiffres
cles. Inter pour le texte, les libelles et les champs. Corps a 15 px, interligne 1.5.
Titres de canal a 20 px, titres de carte a 14 px, texte de post a 14 px, metadonnees a
12 px.

Rayons : cartes 16 px, boutons et champs 12 px, pastilles 999 px, cadre de capture 24 px.
Ombres : aucune ombre sur les cartes, une bordure d un pixel. La profondeur vient du
contraste entre le fond offwhite et les surfaces blanches.

Boutons : primaire charbon avec texte blanc, secondaire blanc avec bordure, danger texte
danger avec bordure. Hauteur 32 px, 28 px en barre d outils. Focus visible avec anneau de
3 px a 30 pour cent d accent.

Densite : une ligne de liste fait 40 px, une carte de mission 96 a 140 px, un post de note
48 a 120 px. Le fil ne depasse pas 760 px de large.

Iconographie : traits de 16 px, deux tons maximum, jamais d emoji comme icone. Les avatars
agents sont carres arrondis de 24 px, les avatars humains ronds de 24 px.

---

## 11. Correspondance avec l API

Endpoints existants : `/mndt-api/state`, `/missions`, `/missions/<id>`, `/mandates`,
`/mandates/<id>/sign`, `/retire`, `/journal`, `/approvals`, `/approvals/<id>/decide`,
`/connectors`, `/machines/...`.

Endpoints a ajouter, en lecture d abord :

| Route | Role |
|---|---|
| `GET /channels` | canaux derives des mandats, dossiers et canal systeme, avec compteurs |
| `GET /channels/<id>/posts?before=` | fil pagine, posts normalises |
| `GET /channels/<id>/context` | panneau de contexte |
| `POST /channels/<id>/notes` | publier une note humaine |
| `GET /members` | humains et agents avec presence et mandats |
| `GET /activity` | agregation des alertes |

Le fil est d abord derive en lecture seule des missions, briefs, approbations et
evenements deja stockes. Aucune nouvelle table de messages au depart : un post est une
projection. Une table de notes humaines est ajoutee ensuite, quand le composeur sera
livre.

Temps reel : polling de cinq secondes sur le canal ouvert, puis SSE quand le volume le
justifiera. Pas de websocket dans un premier temps.

---

## 12. Responsive et accessibilite

Trois points de rupture : 1280 px et plus, trois colonnes ; de 960 a 1280, contexte
replie en panneau glissant ; moins de 960, rail compact et liste en tiroir, fil plein
ecran.

Accessibilite : navigation complete au clavier, ordre de tabulation lineaire, raccourcis
Ctrl K pour la recherche, Ctrl Entree pour envoyer, Echap pour fermer un thread. Contrastes
conformes AA sur le texte ardoise. Chaque carte a un titre lisible par un lecteur d ecran.
Les etats ne sont jamais transmis par la couleur seule, toujours avec un libelle.

---

## 13. Livraison par phases

**P0, la coquille.** Rail, liste des canaux derives des mandats, fil de posts en lecture,
en-tete, panneau de contexte en lecture. Aucune ecriture. Critere : un canal de mandat
montre ses missions et ses briefs reels, un canal systeme montre le briefing et les refus.
Preuve : captures avant et apres, et un canal par mandat actif.

**P1, la decision.** Cartes d approbation decisionnelles dans le fil, avec refus motive,
journalisation, et interdiction du delegataire. Critere : une approbation demandee par une
mission s approuve depuis le canal, la decision apparait dans le fil et dans le journal.
Preuve : mission reelle, capture, ligne de journal.

**P2, l ecriture.** Composeur de note et lanceur de mission depuis un canal, mention d un
agent qui cree une mission dans le mandat du canal. Critere : lancer une mission depuis le
canal produit un post de mission puis un post de brief. Preuve : capture et brief.

**P3, l activite.** Vue Activite, recherche Ctrl K, badges de non-lus, export du journal
depuis le canal. Critere : trois alertes reelles agregees, recherche sur un brief trouve.

Hors perimetre de cette version : messages directs avec un agent, appels, reactions,
canaux libres, edition de post, suppression de post, notifications par mail.

---

## 14. Decisions ouvertes

1. **Le canal principal est il le mandat ou le dossier client ?** La recommandation est le
   mandat pour les canaux actifs, avec un canal de dossier pour un client qui a plusieurs
   mandats. A confirmer.
2. **Un agent par canal ou un agent par role ?** La recommandation est un agent par role,
   membre de plusieurs canaux, avec un mandat par canal.
3. **Le fil par defaut est il le canal d equipe ou le canal du mandat le plus actif ?** La
   recommandation est le canal d equipe a l ouverture, pour ne pas cacher l activite
   transverse.
4. **Faut il un mode demo ?** Oui a terme, pour montrer le produit sans donnees reelles.
   Il est hors perimetre de P0 et P1.

---

## 15. Ce que cette specification change dans le produit

La page "This morning" ne disparait pas. Elle devient le canal d equipe, avec la meme
matiere, presentee comme un fil et non plus comme une pile de cartes. Les cartes existantes
deviennent des posts types. Le composeur, les canaux et le panneau de contexte sont
nouveaux. Les mandats passent du statut de formulaire a celui de cadre lisible en
permanence.

Le critere de reussite est simple : une personne qui arrive sait, sans cliquer, qui
travaille avec qui, sous quel mandat, et quelle decision l attend.
