# Audit des connecteurs et des outils

Ce document décrit l'intention fonctionnelle des connecteurs du produit décrit
par `ceo-dashboard`, pas son implémentation. Il répond à quatre questions : quel
connecteur existe et sert à quoi, lesquels sont indispensables à un MVP, quelles
règles de sécurité doivent les encadrer, et ce que le harnais DSH couvre déjà.

**Sources lues en lecture seule.** Les trois documents de référence
(`docs/connectors-architecture.md`, `docs/audit-connectors-2026-07-14.md`,
`docs/clay-mcp-blocked-2026-06-02.md`), les documents d'intégration
(`user-guide-integrations.md`, `mcp-departmental-catalog-2026-07-11.md`,
`lovable-prompts-integrations-wp7-2026-07-14.md`, `test-plan-integrations.md`),
puis réconciliation avec le catalogue déclaré, la configuration du registre
partagé, les gestionnaires de session par utilisateur et par tenant, et les
points d'enregistrement des outils.

**Ce que le catalogue réel contient.** 31 entrées déclarées, dont 20 proposées
par utilisateur et 11 seulement par organisation, 18 serveurs réellement
configurés dans le registre partagé, 15 exposés en passthrough au modèle. Le
catalogue déclaré et le catalogue branché ne coïncident donc pas, et c'est
normal : un connecteur déclaré mais non branché est une carte, pas une capacité.

**Échelle de sensibilité utilisée dans le tableau.**

- **Critique** : effet irréversible vers un tiers ou mouvement de fonds, ou
  média synthétique d'une personne réelle. Aucune exécution sans validation
  humaine nominative.
- **Élevée** : écriture dans un système de référence, ou lecture de données très
  confidentielles (conversations, banque, données clients).
- **Moyenne** : écriture réversible et interne, ou lecture de données
  personnelles.
- **Faible** : lecture seule sans donnée sensible.

**Consommateurs.** `A` = agent automatique (pipeline, sous-agent, planificateur),
`W` = workflow planifié, `C` = chat à la demande. Un connecteur qui n'a que `C`
n'est pas branché sur la valeur du produit, il est disponible.

## 1. Catalogue des connecteurs

| Connecteur | Rôle | Auth | Lecture | Écriture | Sensibilité | Consommateurs |
|---|---|---|---|---|---|---|
| **Office 365** | Boîte mail et agenda des deux comptes (contact@, duke@) | OAuth Microsoft, device-code, par utilisateur ou par organisation | Reçus, envoyés, non lus, détail, pièces jointes, calendriers, événements du jour et à venir | Brouillon, envoi, réponse, transfert, marquage lu, création et réponse à un événement | **Critique** (envoi sortant irréversible, agenda visible par des tiers) | A, W, C, services (génération de mail, contexte client, briefing) |
| **Attio** | CRM : contacts, entreprises, deals, pipeline, listes, tâches, notes | OAuth (clé API conservée en héritage) | Recherche et lecture d'enregistrements, listes, attributs, tâches, notes, commentaires, membres du workspace, rapports | Création et mise à jour d'enregistrements, de tâches, notes, commentaires, ajout à une liste | **Élevée** (système de référence commercial) | A (Atlas, scoring, avant et après réunion), W, C, services (rapprochement client) |
| **Leexi** | Réunions : appels, transcriptions, résumés, actions | HTTP Basic (identifiant et secret de clé) | Liste des appels, détail, transcription, résumé, actions | Aucune | **Élevée** (contenu conversationnel, données personnelles) mais lecture seule | A (Echo, préparation de réunion, briefing de clôture), W, services (actions, génération de mail) |
| **Dolibarr** | ERP et comptabilité : factures clients et fournisseurs, devis, commandes, projets, notes de frais | Clé API et URL d'instance | Factures impayées, devis, factures fournisseurs, notes de frais, commandes, projets | Création de facture et de lignes, validation, encaissement, écriture comptable, rapprochement, plus un point d'entrée API brut acceptant toutes méthodes | **Critique** (pièces comptables, irréversible) | A (Plutus, veilleur de factures), W, C, briefings |
| **Qonto** | Banque : comptes, soldes, transactions, bénéficiaires | OAuth sur MCP hébergé (validation forte côté banque) | Comptes, transactions, bénéficiaires | Ordres de paiement, selon le périmètre accordé | **Critique** (mouvement de fonds) | Aucun consommateur automatique ; C ; rapprochement natif facture contre transaction bancaire |
| **Chift** | Agrégateur comptable européen (Pennylane, Qonto, BoondManager) | Identifiants client, compte et consommateur | Données comptables agrégées | Selon les outils exposés par l'agrégateur | **Critique** | Aucun : désactivé, non souscrit |
| **Duke Analytics** | La donnée de Duke : sources, métriques, dimensions, règles métier, réponse chiffrée sourcée | Clé API et identifiant d'organisation | Question en langage naturel, réponse sourcée, liste des sources | Aucune | **Élevée** (données clients) mais lecture seule | A (Delphi), C |
| **Swing** | Tickets, sprints, mémoire projet et wiki (remplace Jira) | Email et mot de passe, jeton renouvelé automatiquement | Tickets, projets, sprints, wiki, décisions | Création de ticket, cycle de vie du ticket | **Moyenne** (écriture interne réversible) | A (CommandAgent, actions du briefing, réconciliation de délégation), C |
| **Jira / Confluence** | Tickets et wiki | Jeton API Atlassian (email et token) | Recherche d'issues, résumé de sprint, pages | Création et mise à jour de ticket, commentaire, transition | **Moyenne** | A (Vulcan, projet client), W, C. Décommissionné au profit de Swing, ne pas remonter dans la cible |
| **Linear** | Issues produit et cycles | OAuth sur MCP hébergé, ou clé API | Recherche et lecture d'issues, cycles | Création et mise à jour d'issue, commentaire | **Moyenne** | A (Prometheus, projet client), W, C. Même remarque que Jira |
| **Gamma** | Présentations générées | Clé API | Thèmes, dossiers, statut de génération | Génération de présentation (coût en crédits, livrable externe) | **Moyenne** (effet externe et coût) | A (Apollo, ABM, contenu, événement), W, C |
| **HeyGen** | Vidéo avatar | Clé API | Groupes d'avatars, voix, crédits, statut de vidéo | Création de vidéo | **Critique** (média synthétique d'une personne réelle, consentement et étiquetage) | A (Apollo), C, toujours gaté |
| **ElevenLabs** | Voix : synthèse, clonage, transcription | Clé API | Liste des voix | Synthèse vocale, clonage de voix, transcription | **Critique** (clone de voix) | A (Apollo, service de voix), C |
| **Lemlist** | Outreach : campagnes, séquences, leads, activités | Clé API (connecteur direct, pas un serveur MCP) | Campagnes, statistiques, leads, activités, crédits d'équipe | Création de campagne et de lead, suppression de lead, mise en pause, marquage intéressé | **Élevée** (le contenu part ensuite sans relecture côté produit) | A (Hermes, performance de campagne, tableau marketing, contenu, événement), W |
| **Kaspr** | Enrichissement de contacts (email, téléphone) | Clé API | Recherche de personne, enrichissement de profil (coût par appel) | Aucune | **Moyenne** (données personnelles, coût, clé non vérifiable au branchement) | A (Hermes, ABM) |
| **Clay** | Enrichissement et recherche de comptes et de contacts | OAuth uniquement, pas de clé API | Recherche et enrichissement d'entreprises et de personnes, audiences | Dépôt de lignes dans une table via un webhook de table | **Moyenne** | Aucun : son OAuth exige une liste de domaines de redirection agréés, le produit d'origine n'y figurait pas |
| **Slack** | Messagerie d'équipe | Jeton de bot et identifiant d'équipe | Canaux, historique, recherche, fils de discussion | Publication de message | **Élevée** (message envoyé à des humains) | A (Iris, lecture seule), C |
| **Teams** | Messagerie Microsoft | Jeton d'accès vérifié ; serveur à cache d'authentification, donc pas de session par utilisateur en v1 | Équipes, canaux, messages | Envoi de message | **Élevée** | A (Iris, lecture seule), C. Carte honnête « à reconnecter », pas « connecté » |
| **WhatsApp** | Messagerie, appairage par QR code, un pont par organisation | QR et session locale, repli d'envoi par Twilio | Conversations, contacts, messages | Envoi de message | **Critique** (canal personnel du dirigeant, règle N°1) | A (Iris, lecture seule), C, notifications |
| **Brave Search** | Recherche web | Clé API | Recherche web, recherche locale | Aucune | **Faible**, mais le résultat est une entrée non fiable | A (Athena), C |
| **Memory** | Graphe de connaissances : entités, observations, relations | Aucune (serveur local) | Recherche de nœuds, lecture du graphe | Création d'entités, d'observations, de relations, suppression | **Moyenne** (mémoire du dirigeant, écriture réversible) | A (tous les sous-agents), C |
| **LinkedIn** | Profils | Serveur local, non catalogué | Recherche et lecture de profil | Aucune | **Moyenne** (profils, conditions d'utilisation du réseau) | Aucun agent identifié |
| **Automatisation de l'hôte** (navigateur, terminal) | Navigation web et exécution de commandes sur la machine | Aucune | Capture d'écran, fichiers, processus | Navigation, clic, remplissage, exécution de commande | **Critique** : exécution de code sur l'hôte | Aucun, par décision : exclus du passthrough |

### 1.1 Les familles techniques, et ce qu'elles imposent

Trois familles, qui n'ont pas le même coût de maintenance ni le même risque.

1. **MCP hébergé générique** (Qonto, Pipedrive, Notion, HubSpot, Stripe, Crisp,
   Sentry, Fireflies, et un MCP maison de client). On le branche par déclaration.
   Les outils sont découverts et exposés tels quels au modèle.
2. **Connecteur dédié** (Office 365, Attio, Jira, Linear, Gamma, Dolibarr,
   Lemlist, Leexi, Kaspr, Swing). Il porte son authentification et ses outils
   nommés à la main. C'est là que se concentre la dette : chaque connecteur
   dédié est un endroit de plus où le statut peut mentir.
3. **Serveur local en processus** (Memory, LinkedIn, HeyGen, ElevenLabs, Brave,
   Slack, Teams, WhatsApp, navigateur, terminal). Il est lancé avec une clé en
   variable d'environnement, donc son contrat de configuration peut changer sans
   préavis quand sa version change.

La règle de conception à conserver : **un nouveau connecteur se déclare, il ne se
code pas**. Le produit d'origine l'a inscrit noir sur blanc et a arrêté d'écrire
des connecteurs dédiés.

### 1.2 Ce que la lecture du code ajoute aux documents

- **Le gate d'approbation ne repose pas sur une liste de serveurs.** Il repose
  sur une présomption de forme : un outil dont le nom ne contient aucun verbe de
  lecture connu est présumé écrire, donc gaté. Les listes existantes (outils
  d'envoi protégés, serveurs gatés) sont un plancher, pas une autorisation : un
  serveur absent d'une liste n'est pas réputé inoffensif.
- **Quatre états de connexion honnêtes** (vivant, zéro outil, échec de
  connexion, non configuré) et deux messages distincts, « connecte » contre
  « reconnecte ». C'est une exigence produit, pas une finition : 42 anomalies
  confirmées sur la seule famille connecteurs venaient presque toutes d'un
  statut menteur, d'un cache périmé, d'un credential détruit par une validation
  ratée, ou d'un contrat de configuration mort.
- **Le risque principal n'est pas le connecteur absent, c'est le connecteur vert
  qui ne l'est pas.** Un connecteur qui affiche « connecté » sans avoir prouvé
  qu'il répond est pire qu'une carte grise, parce qu'un agent s'appuie dessus et
  produit un brief vide.
- **Deux connecteurs du catalogue ne sont pas des connecteurs métier** : le
  terminal et le navigateur donnent au modèle une exécution de code sur la
  machine qui héberge la plateforme. Ils sont exclus du passthrough, et il ne
  faut pas les réintroduire sous un autre nom.
- **Les outils non nommés d'un serveur restent atteignables.** Le serveur Office
  n'expose pas seulement le mail et l'agenda : ce qu'il expose en plus (fichiers,
  planificateur) arrive au modèle par le même chemin. Un audit de périmètre doit
  lister ce que le serveur expose, pas ce que le connecteur nomme.

### 1.3 Les six familles d'actions sensibles

Ce sont les actions qu'un humain doit voir avant qu'elles partent, quel que soit
le connecteur qui les porte.

| Famille | Exemples dans le catalogue | Pourquoi elle est sensible |
|---|---|---|
| Envoi de mail | Envoi, réponse, transfert, réponse à tous | Part au nom de l'entreprise, irréversible, engage la relation |
| Envoi de message | WhatsApp, Slack, Teams, SMS de repli | Idem, sur un canal souvent personnel, et parfois le canal du dirigeant |
| Création ou mutation d'événement | Création, acceptation, refus, report d'un événement | Modifie l'agenda d'autres personnes, notification immédiate |
| Publication et diffusion | Campagne Lemlist, Brevo, dépôt social, dépôt de lignes Clay | Sort de l'entreprise sans relecture possible après coup |
| Mouvement de fonds | Paiement Qonto, facture validée Dolibarr, charge Stripe | Argent réel, non réversible |
| Média synthétique d'une personne | Vidéo avatar HeyGen, clone de voix ElevenLabs | Obligations d'information et de consentement, atteinte à l'image |

S'y ajoutent deux familles qui ne sortent pas de l'entreprise mais qui comptent :
la **suppression** (lead, enregistrement, entité de mémoire) et l'**écriture
comptable** (facture, écriture, rapprochement).

## 2. Les huit connecteurs indispensables pour un MVP

Le critère n'est pas la richesse du connecteur, c'est la **boucle produit qu'il
rend possible**. Le produit décrit six boucles : briefing quotidien, préparation
de réunion, revue de compte, relance de facture, veille et contenu, synthèse
hebdomadaire. Un connecteur indispensable est celui dont l'absence laisse une
boucle vide.

| # | Connecteur | Boucles servies | Ce qui casse sans lui | Comment il doit arriver |
|---|---|---|---|---|
| 1 | **Office 365** | 1, 2, 3, 4, 6 | Plus de briefing, plus de détection de réponse, plus de relance : c'est la matière première et l'horloge du produit. Deux boîtes obligatoires, la distinction contact@ contre duke@ est une règle métier | Lecture d'abord (mail, agenda, envoyés), écriture ensuite et toujours derrière une approbation nominative |
| 2 | **Attio** | 1, 2, 3, 6 | Plus de notion de compte à risque, de jalons, de pipeline : la revue de compte n'a plus de système de référence et se rabat sur le mail, qui ne sait pas ce qu'est un deal | Lecture complète, écriture (tâche, note, enregistrement) derrière approbation |
| 3 | **Leexi** | 2, 3, 6 | Ce qui s'est dit dans un appel n'existe nulle part ailleurs. La préparation de réunion devient une reformulation du mail. Connecteur en lecture seule, donc le meilleur rapport valeur sur risque du lot | Lecture seule, sans écriture, dès le premier jour |
| 4 | **Dolibarr** | 1, 3, 4 | Plus d'échéance de facturation, plus de facture échue, donc plus de boucle de relance. C'est aussi la seule source des devis et des projets facturables | Lecture seule d'abord (factures, devis, échéances). Toute écriture comptable est critique et arrive après le circuit d'approbation |
| 5 | **Qonto** | 4 | Une facture dite « due » par l'ERP n'est pas une facture impayée : c'est la banque qui le dit. Sans elle, on relance des clients qui ont payé, ce qui est la faute la plus coûteuse du produit | Lecture seule (comptes, transactions). Aucun ordre de paiement dans un MVP |
| 6 | **Swing** | 1, 5, 6 | Plus de trace du travail interne, plus de mémoire de mission, plus de tickets : le produit sait parler du client mais pas de ce que l'équipe fait. Il remplace Jira dans le produit d'origine pour cette raison | Lecture, puis création de ticket derrière approbation |
| 7 | **Duke Analytics** | 3, 5, 6 | Les agents répondent avec des généralités au lieu des chiffres de Duke. C'est le seul connecteur qui rend le produit spécifique plutôt que générique | Lecture seule, sans écriture, dès le premier jour |
| 8 | **Clay** | 5 | La boucle de veille n'a aucune source externe datée : le modèle ne connaît ni le marché du jour ni les comptes qui ont bougé. C'est aussi le seul connecteur que le produit d'origine n'a jamais réussi à brancher | Lecture et enrichissement. Toute écriture (dépôt de lignes) derrière approbation |

**Pourquoi Clay plutôt qu'un autre pour la huitième place.** La boucle de veille
a besoin d'une source externe de comptes et de contacts. Côté harnais, la
recherche web générique existe déjà sans connecteur, donc elle ne compte pas
comme un connecteur à brancher. Clay est la seule source externe à la fois
disponible en MCP et absente du produit d'origine : il comble un trou réel, pas
un trou théorique.

**Si la boucle de veille glisse en phase 2**, Clay est le seul des huit qui peut
attendre sans casser une boucle. **Gamma** prend alors sa place, parce que la
revue de compte et la synthèse hebdomadaire finissent en document présentable et
qu'un brief markdown ne se présente pas en comité.

### Les trois qui suivent de près, et pourquoi ils attendent

- **Gamma** : transforme un brief en livrable. Utile dès la phase 2, mais un
  brief markdown suffit à décider.
- **Lemlist** : moteur d'outreach. Il n'est sur aucune des six boucles, et son
  contenu part sans relecture côté produit : il arrive quand le circuit
  d'approbation est éprouvé, pas avant.
- **Kaspr** : enrichissement. Redondant avec Clay pour un MVP, et son coût par
  appel est le seul du catalogue qui n'est pas vérifiable au branchement.

### Les deux qui ne doivent pas entrer

- **Automatisation de l'hôte** (navigateur, terminal) : ce n'est pas un
  connecteur métier, c'est une exécution de code sur la machine. En multi-tenant,
  un tenant peut y lire les secrets de tous les autres. Exclusion définitive.
- **Chift** : agrégateur comptable. Il n'ajoute rien quand Dolibarr et Qonto sont
  branchés en direct, et il déplace la surface de risque bancaire chez un tiers
  intermédiaire. Il était déjà désactivé pour cette raison.

### Les deux qui sortent du périmètre

**Jira et Linear** restent au catalogue du produit d'origine mais sont
décommissionnés au profit de Swing. Les reprendre dans la cible serait payer deux
fois la même fonction et rouvrir deux surfaces d'écriture.

## 3. Règles de sécurité attendues

Ces règles ne sont pas des préférences. Chacune répond à une défaillance
observée dans le produit d'origine, et la description ci-dessous dit **ce qui
doit être vrai dans le harnais**, pas comment le produit d'origine le faisait.

### 3.1 Validation humaine (HITL)

1. **Aucune action de la section 1.3 ne part sans validation humaine
   nominative.** Pas de mode « auto-approuvé » global, pas de dérogation de
   session qui couvre les envois, les messages et l'agenda. La dérogation, si
   elle existe, porte sur des écritures internes et réversibles, jamais sur un
   envoi.
2. **Le gate est fail-closed par défaut de forme, pas par liste.** Un outil
   jamais vu, sur un serveur jamais vu, dont le nom ne dit pas clairement
   « lecture », est présumé écrire. Une liste de noms autorisés est le premier
   endroit où un nouvel outil passe sans être vu.
3. **Le gate raisonne sur les arguments, pas seulement sur le nom.** Un point
   d'entrée générique appelé avec une méthode mutante est une écriture, même si
   son nom ne contient aucun verbe d'écriture. C'est le contournement le plus
   simple et il a existé.
4. **Un agent ne fait pas l'action : il produit une demande d'approbation.** Le
   modèle dit quoi envoyer, à qui, avec quelle preuve ; l'exécution attend un
   humain. C'est déjà le modèle cible retenu pour la couche produit (une
   approbation, pas un envoi).
5. **L'approbation est une promesse sur un contenu précis.** Ce qui est approuvé
   est ce qui part : pas de régénération entre la validation et l'envoi, pas de
   re-résolution de destinataire, réclamation unique de la demande en attente.
6. **Ce qui a été approuvé est auditable** : qui, quand, quel contenu, quelle
   source. Un journal d'audit chaîné, et non un log applicatif.

### 3.2 Portées et droits

1. **Trois niveaux par service : aucun, lecture, écriture.** Ils s'agrègent par
   groupe, jamais par personne isolée, et un administrateur de plateforme n'a
   pas accès aux données du dirigeant par défaut. Un rôle d'administration donne
   le pouvoir de configurer, pas celui de lire.
2. **La visibilité d'un outil est scopée à l'appelant.** Un agent voit les outils
   des services que **ce** demandeur a branchés. La forme des outils branchés par
   un autre membre ne doit pas fuiter par un registre partagé de définitions.
3. **Une famille d'agent n'a que les outils de son métier.** Un agent de briefing
   n'a aucun outil d'écriture dans sa liste, pas seulement une interdiction de
   l'appeler. La liste d'outils est la première barrière, le gate la seconde.
4. **La portée d'un connecteur est une décision produit déclarée** : personnel ou
   organisation. Une boîte mail est personnelle, une banque est une affaire
   d'organisation, un CRM est personnel par commercial. Une même liste pour les
   deux écrans est un défaut, pas une simplification.

### 3.3 Secrets

1. **Un secret ne vit que dans un coffre chiffré, indexé par utilisateur et par
   organisation.** Jamais dans un fichier JSON en clair sur le disque, jamais
   dans un fichier de sauvegarde, jamais dans une variable d'environnement
   résolue à vide.
2. **Un secret non résolu est une erreur visible, pas une chaîne vide.** Un
   serveur qui démarre sans sa clé doit être « non connecté », pas « connecté ».
   Le silence produit un statut vert et un échec à la première utilisation.
3. **Le cache de secret est purgé à chaque connexion et à chaque rotation.** Un
   secret tourné ne doit pas survivre au-delà de la session qui l'a chargé, et le
   cache d'un serveur ne doit jamais servir à un autre.
4. **Une validation ratée restaure l'ancien credential, elle ne le détruit pas.**
   Une panne réseau ne doit pas coûter une connexion valide.
5. **Les serveurs tiers sont épinglés en version**, et leur contrat de
   configuration est revérifié à chaque montée. Un serveur MCP est versionné par
   son cache ou son volume, pas par le dépôt : c'est la cause racine de plusieurs
   pannes silencieuses.
6. **Les serveurs à exécution locale ne sont pas acceptés en self-service**
   depuis une interface. Un serveur lancé par un utilisateur, c'est une exécution
   de code arbitraire dans le conteneur qui détient tous les secrets.

### 3.4 Multi-tenant

1. **Deux axes orthogonaux et non interchangeables** : l'organisation est une
   frontière d'isolation, l'utilisateur est une isolation nominative. Toute
   lecture et toute écriture portent les deux.
2. **Jamais de repli silencieux sur le compte partagé** quand un tenant n'a pas
   sa propre session : échec explicite, avec un message qui distingue « branche
   ton compte » de « ta connexion ne fonctionne plus ».
3. **Un connecteur par tenant est une instance par tenant**, avec son propre
   matériel d'authentification et son propre fichier de session. Filtrer un
   compte partagé à la lecture n'est pas de l'isolation.
4. **Une valeur par défaut d'environnement n'est jamais une identité de repli.**
   Le compte propriétaire de la plateforme ne doit pas devenir le compte de
   l'agent pour un tenant qui a oublié de brancher le sien. Ce chemin a déjà
   produit une fuite de briefing entre deux organisations.
5. **Le résultat d'un connecteur est une donnée non fiable.** Un mail, un
   transcript, une note CRM peuvent contenir des instructions. Le contenu lu ne
   doit jamais devenir une instruction exécutable.

### Les tests qui rendent ces règles vraies

Une règle non testée n'existe pas. Cinq contrôles suffisent à couvrir l'essentiel.

- Un test qui branche un serveur inconnu exposant un outil d'écriture au nom
  inconnu, et vérifie qu'il est gaté sans aucune déclaration.
- Un test qui tente un point d'entrée générique avec une méthode mutante et
  vérifie le refus d'exécution sans approbation.
- Un test qui révoque une clé et vérifie que la carte passe de « connecté » à
  « échec de connexion », pas à « connecté avec zéro outil ».
- Un test qui simule une panne réseau au branchement et vérifie que l'ancien
  credential est intact.
- Un test cross-tenant : aucune donnée d'une organisation ne doit apparaître dans
  une lecture, un brief ou un envoi d'une autre, avec un compte partagé configuré
  pour rendre le repli tentant.

## 4. Correspondance avec les serveurs MCP disponibles côté DSH

Douze serveurs sont déjà montés : `office/mail` (deux comptes, contact@ et
duke@), Attio, Leexi, Dolibarr, Qonto, Swing, Gamma, HeyGen, Lemlist, Clay, Duke
Analytics. La couverture est meilleure que celle du produit d'origine sur un
point précis : **Clay est disponible**, alors que le produit d'origine ne pouvait
pas le brancher.

| Connecteur produit | Serveur MCP DSH | Couverture | Écarts à traiter |
|---|---|---|---|
| **Office 365** | `office/mail`, deux serveurs distincts (contact@ et duke@) | Mail (dossiers, messages, pièces jointes), calendrier (événements, vues, occurrences), brouillon de mail, création et mise à jour d'événement | **Pas d'envoi de mail exposé** : seul le brouillon est créé. Le « switch de compte » devient deux familles d'outils au lieu d'un sélecteur. Le produit visait deux boîtes dans un seul serveur, ici c'est un serveur par boîte : la règle métier « quelle boîte parle » doit être portée par la couche produit |
| **Attio** | Attio | Large : enregistrements et listes, attributs, tâches, notes, commentaires, rapports, membres du workspace, plus mails et réunions liés | Rien de bloquant pour les six boucles. Vérifier le coût de lecture sur les rapports agrégés |
| **Leexi** | Leexi | Appels, détail, transcription, résumé, recherche plein texte | **Pas de signal temps réel** : le produit d'origine déclenchait sur fin d'appel. Sans webhook, la boucle de réunion passe en lecture à la demande, donc en mode « préparer » et non « réagir » |
| **Dolibarr** | Dolibarr | Factures clients et fournisseurs, commandes, produits, projets, clients et fournisseurs, paiements, point d'entrée API générique | La surface « écriture comptable » et « rapprochement Grand Livre » du produit n'a pas d'équivalent direct : elle se compose en deux appels, ou reste hors du MVP |
| **Qonto** | Qonto | **Lecture seule** : organisations, comptes, transactions, relevés, factures, clients, produits, membres | L'écart est assumé et c'est le bon pour un MVP : aucun paiement possible. Conséquence : la boucle de relance fonctionne, la boucle de dépense n'existe pas |
| **Duke Analytics** | Duke Analytics | Sources, métriques, dimensions, relations, règles métier, question en langage naturel avec provenance SQL | Un seul tenant de sources, et l'une des deux sources est un **embryon vide** (Dolicloud). Le problème est côté données, pas côté connecteur, mais un agent répondra sur des chiffres partiels sans le dire |
| **Swing** | Swing | Projets, tickets, wiki, sprints, décisions, sessions, commentaires, membres | Rien de bloquant. C'est le connecteur le plus complet du lot côté DSH |
| **Gamma** | Gamma | Génération, édition, export (PDF, PPTX, PNG), thèmes, dossiers, analytique de lecture | Rien de bloquant |
| **HeyGen** | HeyGen | Avatars, vidéo avatar, vidéo modèle, voix, traduction, assets, dossiers | La gate de consentement et d'étiquetage doit être portée par la couche produit, pas par le connecteur |
| **Lemlist** | Lemlist | Très large : campagnes, séquences, leads, boîte de réception, enrichissement, listes, webhooks, veilles | Rien de bloquant. C'est le lot le plus riche, et le plus dangereux sans approbation : la séquence part toute seule |
| **Clay** | Clay | Recherche et enrichissement d'entreprises et de personnes, audiences, fonctions d'enrichissement maison, question sur les comptes | Le blocage du produit d'origine (OAuth restreint à une liste de domaines partenaires) **n'existe plus côté harnais**. Vérifier les portées accordées et le coût en crédits avant d'en faire un usage d'agent |
| **Kaspr** | Absent (couvert fonctionnellement par Clay) | Recherche de personne et enrichissement de profil | Aucun besoin de le couvrir séparément si Clay est retenu |

### Les manques à couvrir

**Manques sans impact sur le MVP** (à ne pas couvrir, ou plus tard) : Jira et
Confluence, Linear (Swing les remplace), Slack, Teams et WhatsApp (canaux de
notification, pas de décision : suffisants en phase 2 quand une boucle d'alerte
existera), Brave Search et navigateur (la recherche web générique est déjà là,
sans connecteur), Chift (inutile en direct), Fireflies (Leexi le fait),
HubSpot, Pipedrive, Notion, Airtable, Stripe, Sentry, Crisp, Pennylane, Brevo,
Postproxy, LinkedIn, Twilio.

**Manques à couvrir avant un pilote réel** :

1. **Les documents.** Une revue de compte a besoin des contrats, des devis et des
   propositions, qui sont des fichiers et pas des champs. Aucun serveur monté ne
   lit un espace documentaire (SharePoint, OneDrive, Drive). Les pièces jointes
   de mail sont accessibles, c'est un pis-aller, pas une réponse.
2. **Les contacts.** Il n'y a pas d'annuaire monté. Attio couvre les contacts
   commerciaux, pas les contacts internes ni les interlocuteurs d'un client hors
   CRM. La préparation de réunion en dépend.
3. **Le signal de fin d'appel.** Le produit d'origine réagissait à la fin d'un
   appel pour produire le compte rendu. Sans webhook Leexi, cette boucle devient
   une action à la demande. C'est acceptable, mais il faut le dire : ce n'est pas
   la même promesse.
4. **Les données de Duke.** Le connecteur fonctionne, les sources sont
   incomplètes. Un agent qui répond sur une seule source réelle sans le signaler
   est un générateur de fausses certitudes. À trancher côté données avant de
   mettre le connecteur en avant.
5. **Le dernier kilomètre d'envoi.** Le mail monté crée des brouillons et
   n'envoie pas. C'est plus sûr, mais cela déplace l'envoi hors du produit : soit
   on l'assume (un humain envoie depuis sa boîte, le produit garde la trace), soit
   il faut un chemin d'envoi explicite, unique, derrière l'approbation. Les deux
   sont défendables, le flou ne l'est pas.

**Ce qui n'est pas un manque de connecteur.** Le circuit d'approbation, l'audit,
l'identité et la mémoire d'entreprise ne sont pas des connecteurs : ce sont des
capacités du harnais et de la couche produit. Les chercher dans le catalogue MCP
conduit à empiler des connecteurs là où il manque une règle.
