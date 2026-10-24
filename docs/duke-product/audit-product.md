# Audit produit : surface, parcours et intention d'expérience

> Audit en lecture seule du projet source (`ceo-dashboard`, produit Tellus.ai pour Duke Analytics).
> Objectif : extraire l'INTENTION FONCTIONNELLE et l'expérience attendue, pas le code, pour
> reconstruire le produit sur une autre base. Aucun extrait de code, aucun fichier copié,
> aucune modification du projet source.
>
> Sources principales : `AGENTS.md`, `docs/audit-2026-09-03-tellus-vs-definition-cible.md`,
> `docs/audit-briefing-incoherences-2026-06-08.md`,
> `docs/audit-multiuser-onboarding-cmo-2026-06-09.md`,
> `docs/audit-agentic-multitenant-2026-07-09.md`, `MANUAL_TEST_2026-05-15_E2E.md`,
> `MANUAL_TEST_SARA_CMO_ROLLOUT.md`, `gtm-dossiers.md` (survol),
> `docs/specs/audit-mndt-2026-09-27/02-PLAN-AJUSTE-actionabilite-parcours-2026-10-06.md`,
> `docs/specs/audit-mndt-2026-09-27/03-SPEC-ce-matin-2026-10-08.md`,
> `docs/REPRISE-2026-10-19.md` et `docs/REPRISE-2026-10-20.md` (état de prod),
> `docs/lovable-spec-team-page.md`, `docs/LOVABLE_FRONTEND_SPECS.md`,
> puis `frontend/` (arborescence des pages et composants) et `src/api/routes` (liste des routes,
> pour déduire les capacités exposées).
>
> Deux avertissements de lecture.
> 1. Le front de production n'est pas dans ce dépôt : c'est `zen-flow` (dépôt séparé, Vite/React).
>    Le `frontend/` présent ici est une application Next.js **legacy**, non déployée. Les écrans
>    de production sont donc reconstitués à partir des spécifications et des notes de reprise,
>    pas d'un code présent. Le `frontend/` reste utile comme inventaire historique des capacités
>    exposées (pages, actions, routes appelées).
> 2. La cible d'expérience la plus récente et la plus explicite est la spécification « Ce matin »
>    (2026-10-08) et son plan (2026-10-06). Elle décrit l'intention retenue, validée par le
>    dirigeant, et un écart assumé avec ce qui est livré. Cet audit s'appuie sur cette cible pour
>    dire ce que le produit **veut** être, et sur les audits internes pour dire ce qu'il fait
>    encore mal.

---

## 1. Promesse du produit en 5 lignes

1. Tellus est une équipe d'agents IA qui observe en continu les systèmes de l'entreprise (boîtes
   mail, calendrier, CRM, appels, tickets, factures, campagnes, web) et transforme ce flux en
   propositions prêtes à décider, pour un dirigeant puis pour son équipe.
2. Sa promesse tient en une question posée une fois par jour : « qu'est-ce qui m'attend, et
   puis-je le régler maintenant ? ». Une seule page y répond, avec un compteur exact et identique
   sur le web, le mobile et WhatsApp.
3. Ce qui est proposé arrive **déjà fait** : brouillon rédigé, destinataire, boîte d'envoi
   résolue, personne proposée, livrable et critères d'acceptation. Le produit ne demande pas de
   choisir, il demande de valider.
4. L'humain décide sur le contenu exact qui partira (De, À, CC, objet, corps, pièces jointes, et
   jusqu'au texte des notifications aux collègues), avec cinq verbes qui font ce qu'ils disent,
   et rien ne part sans son clic : la règle fondatrice est « proposer, jamais envoyer ».
5. La valeur se mesure en boucle fermée : ce qui a été décidé revient en preuve (brouillon prêt,
   envoyé, répondu, livré vérifié, expiré sans décision) et le même sujet ne se perd ni ne se
   dédouble. Ce qui n'est pas mesuré ainsi (nombre d'actions produites) n'est pas la valeur.

---

## 2. Pages et écrans

Convention de statut : **prod** = écran réellement servi (zen-flow, hors dépôt) ; **legacy** =
page du `frontend/` Next.js non déployée mais révélatrice d'une capacité attendue ; **API** =
surface exposée sans écran dédié ; **prévu** = conçu dans les spécifications, pas livré.

### 2.1 Le quotidien : décider et suivre

| Écran | Statut | Rôle | Contenu principal | Actions |
|---|---|---|---|---|
| **Ce matin** (accueil, `/`) | prod | Page d'arrivée unique, remplace le Brief, le Fil et la pile Olympus | En-tête daté par la génération du brief (pas par la date du jour), bandeau de source en échec, top 3 des décisions classées par le LLM, puis sections : Décisions, Exceptions, À envoyer par vous, En cours, Mes tâches, Depuis hier, Contexte (replié), Non classé. Compteurs et badge | Ouvrir une carte (ouvre le panneau), sélectionner pour agir en lot, replier le Contexte, relancer la génération du brief, relancer le classement |
| **Panneau de décision** (composant, adresse propre par décision) | prod, partiel | Le seul endroit où l'on décide ; un composant unique réutilisé par Ce matin, le chat et Olympus | En-tête (titre, étape, révision), ce qui partira champ par champ et en entier, le texte exact des notifications aux collègues, pourquoi maintenant / pourquoi vous / ce qui est attendu, sources datées avec liens, disponibilité du canal, différence depuis la révision précédente, puis les étapes après décision | Valider vers brouillon, Modifier (révision), Demander une réécriture, Déléguer, Reporter, Refuser avec motif |
| **Carte** (élément de liste) | prod | Résumer une décision en un coup d'œil sans permettre de décider | Rang, titre en verbe + objet + tiers, pourquoi maintenant, pourquoi vous, attendu, état de préparation, échéance ou expiration, canal et boîte, sources, badge d'étape honnête (proposée, validée, transmise, brouillon prêt, envoyé) | Ouvrir le panneau ; la carte ne porte **pas** de bouton Valider sur desktop |
| **Suivi** | prévu, partiel | Voir ce que mes délégations attendent, groupé par personne | Délégations émises, étapes nommées, timeline réelle des événements, retards, blocages, livraisons à vérifier | Relancer depuis la carte, réassigner, répondre, accepter ou renvoyer une livraison |
| **Historique et preuve** | prévu | Voir ce qui s'est passé et ce qui le prouve | Faits clos avec leur preuve (envoyé détecté, répondu, livré vérifié, supplanté par le CEO), expirations avec motif | Consulter, filtrer, exporter |
| **Mes tâches** (vue assigné) | prévu, partiel | Donner au membre un chemin de bout en bout | La demande, le livrable attendu, les critères d'acceptation, l'échéance, pourquoi vous | Je prends, Question, Je ne peux pas (bloqué), Livrer avec pièces |
| **Chat** | prod | Faire faire, pas seulement décider : conversation avec l'orchestrateur | Réponse en markdown, blocs de raisonnement repliables, appel d'outils en cours, fragments de raisonnement des sous-agents, artefacts produits, cartes d'approbation HITL en ligne | Envoyer, approuver ou rejeter un appel d'outil, fixer un auto-approbation limité par session, injecter un contexte, reprendre une session |
| **Olympus** (panthéon vivant) | prod | Rendre visible que les agents travaillent, et incarner le monde des agents | Monde isométrique où chaque dieu correspond à un agent réel, bulles de raisonnement, états (pensée, action, attente de validation), rail HITL | Approuver ou rejeter depuis le rail, actions rapides (briefing, scans), basculer vers le chat |
| **WhatsApp** (surface hors écran) | prod | Décider là où l'on est, sans ouvrir l'application | Digest du matin (compteurs identiques au web, 3 premières décisions, mention de source en échec), puis demande unitaire « 1/N » avec l'objet, la boîte, la raison, un aperçu du corps | Voir n, Plus tard n, Valider si le corps complet a été envoyé, Refuser avec choix du motif, poser une question |
| **Mobile** (375 px) | prévu, partiel | Mode série, une décision après l'autre | Carte plein écran, panneau bas pour lire le brouillon, barre basse | Valider (actif seulement après ouverture du brouillon), Modifier, Déléguer, Plus tard, Refuser, Précédente / Suivante |
| **Brief** (ancienne vue) | legacy | Lire le récit du matin, non actionnable | Récit exécutif, zones de focus, actions recommandées, préparation de réunion, timeline de la journée | Marquer une action, générer, consulter l'historique |
| **Fil d'activité** (ancienne vue) | legacy | Voir les actions des agents au fil de l'eau | Cartes d'actions enrichies (agent, type, statut, résumé, sources, score, trace de raisonnement), flux temps réel | Valider, écarter, ouvrir le détail |
| **Pile unifiée** (`/inbox/feed`) | API | Source de vérité d'une pile personnelle, indépendante du statut métier | Items calculés par utilisateur, avec état de pile (actionnable, en attente, traité, masqué), indicateur de validation requise | Masquer / démasquer, marquer comme lu, ouvrir la source |

### 2.2 Pilotage et analyse

| Écran | Statut | Rôle | Contenu principal | Actions |
|---|---|---|---|---|
| **Stratégie** | legacy, API riche | Relier décisions et objectifs | Objectifs, plans d'action, recommandations, alertes stratégiques, écarts fonctionnels, progression, revues, pulse | Créer ou modifier un objectif, approuver une action d'objectif, acquitter une alerte, déléguer un item de plan, lancer une revue |
| **Agents** | legacy | Voir la santé et la qualité des agents | Liste des agents et de leurs capacités, actions récentes, scores de qualité par agent juge, évaluations récentes, santé par agent | Consulter une fiche, lancer une évaluation, créer ou modifier un sous-agent dynamique |
| **Autonomie** | legacy | Régler ce que les agents peuvent faire seuls | Actions autonomes et annulables, configuration, règles d'autonomie par domaine | Annuler une action, activer ou désactiver une règle, régler un niveau |
| **Email / Meetings / Leads / Sprints intelligence** | legacy, API | Consommer l'analyse quotidienne par domaine | Comptes rendus par jour : triage, extraits, références croisées, décisions prises, alertes, plan de déblocage, impact client, scoring | Lancer un scan, valider, écarter, exécuter une action, corriger le triage |
| **Appels** | API | Exploiter les transcriptions | Détail d'appel, transcript, résumé | Consulter, retrouver un appel |
| **Factures et comptabilité** | API | Suivre le recouvrement | Factures, échéances, impayés | Consulter, générer une relance |
| **Qualité (juge)** | API | Mesurer la qualité des sorties | Évaluations, statistiques, cas de référence | Lancer un benchmark |
| **Apprentissage** | API, propriétaire | Voir la boucle d'apprentissage | Expériences, patchs de prompt, compétences, écarts, solutions, rapport hebdomadaire | Désactiver un patch, approuver un plan de solution |
| **Usage et coûts** | API | Attribuer les dépenses | Résumé, par modèle, par mission, par agent, par utilisateur, par palier, tendance, alertes | Consulter |
| **Programmes et revues** | API | Suivre les engagements contractuels | Clauses à revoir, revues par occurrence, réponses | Ouvrir une revue, répondre |
| **Brain** | API, admin | Rejouer la consolidation de mémoire | Rêves (transcripts), instantanés du graphe de connaissance, santé du câblage | Déclencher un rêve avec instruction, consulter |
| **Cockpit V6 / decision packs** | API, propriétaire | Vue de pilotage stratégique | Packs de décision, KPI du jour, concurrents, signaux, santé des services, observabilité (épisodes, journal de signaux, cache procédural, saillance) | Décider sur un pack, investiguer, acquitter un patch de prompt |

### 2.3 Administration, configuration, confiance

| Écran | Statut | Rôle | Contenu principal | Actions |
|---|---|---|---|---|
| **Intégrations** | prod (self-service) | Donner à chacun ses accès, sans passer par un admin | Catalogue des services par rôle, état (connecté, à reconnecter, non configuré), comptes et boîtes disponibles, méthodes d'authentification (OAuth, code d'appareil, clé, identifiants), encart « déjà fourni par votre organisation » | Connecter, reconnecter, tester, déconnecter, choisir un compte par défaut |
| **Onboarding (persona + checklist)** | prévu, partiel | Décider ce que le produit doit montrer à cette personne | Choix du rôle au premier login, puis checklist groupée par priorité (essentiel, recommandé, optionnel), avec « pourquoi » et barre de progression | Choisir son rôle, connecter un service, fermer le bandeau quand tout l'essentiel est fait |
| **Équipe** (`/team`) | prévu, API prête | Rendre l'organisation lisible et configurable | Trombinoscope ou organigramme : titre, département, entité, localisation, canal préféré, missions, clients assignés, charge active, statut externe | Éditer un membre, câbler le manager, filtrer par entité ou localisation |
| **Admin utilisateurs et invitations** | prod/légacy | Ouvrir et fermer des accès | Liste des utilisateurs (email, rôle, statut, dernier login), invitations en attente, jetons | Inviter, désactiver, réactiver, supprimer, promouvoir, changer un rôle |
| **Admin groupes et accès outils** | legacy | Décider qui peut appeler quel service | Groupes, membres, matrice d'accès aux serveurs d'outils et niveau (lecture, écriture) | Créer un groupe, ajouter ou retirer un membre, éditer la matrice |
| **Admin organigramme** | legacy | Poser la hiérarchie | Arbre des managers | Rattacher un utilisateur à un manager |
| **Admin tenants et organisations** | API, admin plateforme | Isoler les organisations | Liste des organisations, statut, fuseau, propriétaire, provisionnement | Créer, suspendre, provisionner, mettre à jour |
| **Admin audit** | legacy, API | Prouver qui a fait quoi | Journal d'audit chaîné (auteur, action, cible, horodatage) | Filtrer, consulter, exporter |
| **Admin exploitation** | API | Surveiller la file de validation et la réconciliation | Instantané de la file HITL, résolution forcée des périmés, déclenchement de la réconciliation, purge de doublons, état des sauvegardes | Déclencher, forcer, purger |
| **Réglages profil** | prod | Identité et canaux de la personne | Nom affiché, fuseau, téléphone, avatar, rôle de profil, canaux (Slack, Teams, WhatsApp) et préférence de canal, consentements par canal | Modifier, changer de mot de passe |
| **Réglages notifications** | API | Choisir comment être prévenu | Abonnements push par appareil et par seuil (critique, élevé, tout), dernière réussite d'envoi | S'abonner, changer de seuil, désactiver, supprimer un appareil |
| **Réglages clés API** | prévu | Ouvrir le produit à un système tiers | Clés, dates de création et de dernière utilisation, portée | Créer, faire tourner, révoquer |
| **Réglages facturation** | API | Suivre l'abonnement | Plan, usage, factures | Consulter |
| **Base de connaissance** | API | Alimenter la mémoire documentaire | Sources ingérées | Ingérer, lister, supprimer |
| **Workspaces** (constructeur d'agents) | legacy, API | Composer un agent ou un mode de travail dédié | Nom, mode (conversation ou workflow), invite système, outils activés et paramètres par défaut, règles de comportement, déclencheur (manuel, événement, planification), sessions | Créer, dupliquer depuis un modèle, éditer, partager, lancer une session |
| **Système / statut** | legacy | Vérifier que la plateforme tient | Santé, services, paramètres, catalogue d'outils par serveur | Consulter, appeler un outil |
| **Démo (DECIDE)** | legacy | Scène de démonstration immersive | Chat plein écran, flux d'agents en direct, panneau vocal | Envoyer, parler, voir le flux |

### 2.4 Entrées publiques

| Écran | Statut | Rôle | Contenu principal | Actions |
|---|---|---|---|---|
| Landing et tarifs | prod | Présenter et vendre | Promesse, plans, prix, add-ons | Choisir un plan, demander une démo |
| Connexion / mot de passe oublié / réinitialisation | prod | Entrer et récupérer l'accès | Formulaire, messages d'erreur non énumérants | Se connecter, demander un lien, définir un mot de passe |
| Acceptation d'invitation | prod | Entrer dans une organisation existante | Jeton, création du mot de passe | Accepter, choisir son rôle au premier login |
| Création d'organisation | prod | Ouvrir une nouvelle organisation | Formulaire d'organisation et de propriétaire | Créer l'organisation et son premier compte propriétaire |

### 2.5 Surfaces prévues mais absentes (intention non livrée)

- **Portail de l'assigné externe** : une personne sans compte n'a aujourd'hui aucune surface pour
  lire une demande, livrer, refuser ou répondre. L'intention est un accès par lien signé à durée
  limitée, avec une projection expurgée de la demande.
- **Fiche de tâche assigné** : l'écran qui montre la demande, le livrable, les critères et les
  quatre actions (je prends, question, je ne peux pas, livrer) n'existe pas.
- **Vue délégant** : aucune route ni écran « émises par moi » ; le délégant ne voit pas ce que ses
  délégations attendent de lui.
- **Sélection de la personne** dans une délégation : pas de graphe de délégation, l'espace de choix
  reste l'annuaire entier du tenant.
- **Panneau de décision complet** : les révisions, le diff depuis la version précédente, la boîte
  d'envoi scellée affichée avant validation et le blocage si le contenu a changé sont conçus et
  partiellement livrés.

---

## 3. Les cinq parcours utilisateurs clés

### 3.1 Le CEO le matin (décider en 2 minutes)

Déclencheur : ouverture de l'application au réveil, ou digest WhatsApp ; le brief de nuit a été
généré et les propositions ont été préparées pendant la nuit.

- **Étape 1** : la page d'arrivée est toujours la même, datée par la génération du brief, avec un
  compteur unique et le top 3 classé par le LLM.
- **Étape 2** : il ouvre la première carte, lit le contenu exact qui partira (De, À, CC, objet,
  corps, pièces jointes) et le texte des notifications aux collègues, puis valide.
- **Étape 3** : la carte ne disparaît pas ; elle passe en « en cours », puis « à envoyer par vous »
  avec le lien vers la boîte et le rappel que l'envoi lui revient.
- **Étape 4** : il traite ensuite les exceptions (bloqué, interrompu, en retard, expiré sans
  décision, livré à vérifier, validation orpheline), puis range en lot ce qui n'appelle aucune
  action (clore, reporter).
- **Attendu à l'écran** : 6 à 8 gestes au total sur une seule surface (contre 15 à 25 gestes sur
  trois ou quatre surfaces aujourd'hui), zéro attente au clic, zéro état faux ; chaque carte dit
  pourquoi maintenant, pourquoi vous, ce qu'on attend et quand elle expire ; une source en échec
  est nommée au lieu de produire un vide.
- **À garantir** : un fait produit une seule carte et une seule décision ; une décision non prête
  reste visible avec « à compléter par Tellus » ; le classement manquant est affiché comme
  indisponible et jamais remplacé par un tri de secours.

### 3.2 Le CEO en déplacement (décider hors écran)

Déclencheur : notification WhatsApp ou push pendant un déplacement ; la demande unitaire porte un
numéro (« 1/6 ») et l'objet.

- **Étape 1** : le message montre le destinataire, la boîte d'envoi, l'objet, la raison, et le corps
  complet si le canal l'accepte (sinon un renvoi vers la lecture avant validation).
- **Étape 2** : il répond « voir 1 », « plus tard 1 », « valider », « refuser » ; une question reçoit
  une réponse et la demande reste en attente, elle n'annule rien.
- **Étape 3** : le refus demande un motif choisi dans une liste (déjà traité, plus d'actualité,
  mauvaise proposition, pas pour moi, autre) ; sans motif, rien n'est enregistré.
- **Étape 4** : le retour est construit sur le résultat réel : « brouillon prêt dans Outlook, à toi
  de l'envoyer » ou « rien fait, cause », puis « suivante ? ».
- **Attendu à l'écran** : 1 à 2 gestes pour une validation informée, le compteur identique à celui
  du web, un numéro figé au moment du digest (un numéro périmé est refusé et non détourné), jamais
  de demande évincée sans avertissement.
- **À garantir** : un « OK » n'est accepté que si le contenu complet a été délivré ; une réponse
  n'annonce jamais un succès avant d'avoir agi ; le message ne dit jamais « OK pour envoyer »
  quand la règle produit est « brouillon seulement ».

### 3.3 Le CMO, puis tout membre de l'équipe (sa propre expérience)

Déclencheur : invitation reçue par un admin, acceptation, premier login avec choix du rôle
(marketing) ; la persona doit être persistée côté serveur, pas dans le navigateur.

- **Étape 1** : la checklist d'onboarding est personnalisée par rôle : ce qu'elle doit connecter
  elle-même (boîte, CRM, plateforme d'outreach) est distingué de ce que l'organisation fournit
  déjà (téléphonie, factures, vidéo), avec une priorité par item.
- **Étape 2** : elle connecte ses propres comptes ; ses accès ne sont jamais ceux d'un collègue, et
  une lecture de boîte sans compte connecté est bloquée avec un message explicite.
- **Étape 3** : elle reçoit **son** briefing, au prisme de son rôle (croissance, pipeline, contenu,
  angles morts marketing, budget de lecture), pas celui du CEO ; elle voit ses décisions et ses
  tâches assignées.
- **Étape 4** : elle délègue à un collègue par un canal interne (sans passer par Outlook), reçoit
  ses propres validations à faire, et approuve ses propres brouillons nominatifs.
- **Attendu à l'écran** : une page d'arrivée identique dans sa forme, différente dans son contenu ;
  chacune de ses notifications arrive sur son canal à elle ; « pourquoi vous » parle de son rôle.
- **À garantir** : une même organisation ne signifie pas une même expérience ; le rôle choisi
  change réellement le contenu produit, et un membre n'a jamais besoin du propriétaire pour
  travailler.

### 3.4 Le sales (pipeline, relances, comptes)

Déclencheur : signaux de compte (nouveau contact, deal qui bouge, impayé sur compte actif, dormant
à réactiver) remontés par l'analyse quotidienne ; le dossier de compte est le livrable attendu.

- **Étape 1** : il part d'un dossier de compte consolidé (identité, cycle de vie, signaux, chiffres,
  contacts, deals, appels, derniers échanges, tâches ouvertes) au lieu de recouper six outils.
- **Étape 2** : les propositions arrivent prêtes : relance de facture, relance commerciale,
  réactivation, chiffrage d'une phase suivante, avec la personne à qui écrire et le motif.
- **Étape 3** : il valide ou modifie le brouillon, puis retrouve le lien vers Outlook ; l'envoi reste
  son geste.
- **Étape 4** : une réponse reçue rouvre le même sujet, un envoi détecté clôt la relance, et une
  échéance dépassée devient une exception relançable.
- **Attendu à l'écran** : le même parcours de décision que le CEO, mais alimenté par le pipeline et
  les séquences d'outreach de son propre compte ; aucune donnée d'un autre tenant ni d'un collègue
  dans ses vues.
- **À garantir** : la relance proposée doit dire ce qui part et à qui ; une relance approuvée doit
  réellement partir ; un impayé sur compte actif ne doit pas se perdre dans les constats.

### 3.5 Gestion de mission, validation HITL et artéfacts

Déclencheur : une action externe est proposée (email, message, événement, vidéo) ou une mission est
confiée à un humain ; dans les deux cas le produit prépare, l'humain décide.

- **Étape 1** : une carte d'approbation apparaît là où le travail se fait (chat, Ce matin, Olympus,
  WhatsApp), avec l'outil, les arguments lisibles, le destinataire et la raison.
- **Étape 2** : approuver est lié au contenu vu : le panneau montre le contenu complet, la décision
  est attachée à cette version, et si le contenu a changé entre-temps rien ne part et on le dit.
- **Étape 3** : les pièces jointes sont des références scellées (nom, type, taille, empreinte) ; ce
  qui a été montré est ce qui part, ou rien ne part ; une pièce non scellée est refusée au départ.
- **Étape 4** : pour une mission confiée à un humain, la demande porte un contrat (livrable, critères
  d'acceptation, échéance) ; la clôture exige une preuve observée dans le système source, pas une
  déclaration.
- **Attendu à l'écran** : étapes nommées et lisibles (proposée, validée, transmise, brouillon prêt,
  envoyé, livré, vérifié), artefacts visibles dans la conversation avec aperçu et téléchargement,
  et un historique des événements de la mission.
- **À garantir** : aucun chemin d'exécution ne contourne le gate humain ; une approbation ne peut
  pas être rejouée ni modifiée après coup ; une livraison non vérifiée contre ses critères ne
  compte pas comme close.

---

## 4. Modèle multi-utilisateur et de partage tel qu'il est conçu

### 4.1 Deux axes orthogonaux, à ne jamais confondre

| | Axe **tenant** (isolation) | Axe **utilisateur** (personnalisation et attribution) |
|---|---|---|
| Question | « cette organisation peut-elle voir les données d'une autre ? » | « cette personne voit-elle et décide-t-elle pour elle-même ? » |
| Discriminant | identifiant d'organisation | identifiant d'utilisateur |
| Portée | frontière stricte, refus par défaut | personnalisation, propriété, autorité d'approbation |
| Conséquence si absent | fuite inter-organisations | produit mono-utilisateur déguisé en équipe |

L'intention explicite est que ces deux axes se cumulent : une organisation peut contenir plusieurs
personnes avec des expériences distinctes, et une personne peut appartenir à une seule organisation
(avec un rôle de super-administrateur pour la plateforme).

### 4.2 Rôles, propriété et autorités

- **Rôles applicatifs** : administrateur, membre, lecteur. L'administrateur gère les comptes, les
  groupes et les accès outils ; le membre travaille ; le lecteur consulte.
- **Propriétaire de l'organisation** : autorité de dernier recours, notamment sur les validations
  qui n'ont pas de propriétaire identifiable et sur les actions au nom de l'organisation.
- **Propriétaire de l'action** : sur un canal nominatif (une boîte mail personnelle, un numéro
  personnel), seul le propriétaire peut valider. Le propriétaire d'organisation lui-même ne valide
  pas l'envoi nominatif d'un autre.
- **Canal d'organisation** : validation par le propriétaire de l'action ou par le propriétaire de
  l'organisation.
- **Approbateurs multiples** : une décision peut déclarer plusieurs approbateurs ou une politique
  d'approbation (séquentielle, groupe), y compris pour une validation ciblée.
- **Hiérarchie** : chaque personne a un manager, ce qui permet de câbler l'organigramme et de
  router des escalades ; la racine est le propriétaire sans manager.
- **Groupes et accès outils** : l'accès à un service se donne par groupe, avec un niveau (lecture,
  écriture). Un membre sans groupe a une surface d'outils vide : c'est un piège d'onboarding connu.

### 4.3 Persona : ce que le produit doit montrer à cette personne

- Un rôle de profil persistant (direction générale, finance, opérations, marketing, ventes,
  consultant ou livraison, technique, sur mesure), avec des pondérations de focus, des angles morts
  prioritaires, un budget de temps de lecture, un style de communication et une langue.
- Des valeurs par défaut curées par rôle : le marketing voit croissance, pipeline et contenu, avec
  les angles morts ROI de campagne et MQL vers SQL ; les ventes voient pipeline et relances ; la
  livraison voit missions clients et gestion de projet.
- La persona est éditable par la personne, et par un administrateur pour autrui.
- Elle doit être **consommée** : briefing, classement, rédaction et propositions doivent en dépendre.
  C'est le point qui distingue une vraie expérience par rôle d'un simple champ décoratif.

### 4.4 Connecteurs, canaux et consentement (par personne)

- Chaque personne connecte ses propres comptes ; les secrets sont stockés par couple
  personne/service. Un mode strict empêche d'emprunter le connecteur d'un collègue : une lecture
  sans compte connecté est bloquée, avec un message qui invite à connecter.
- Les canaux de notification sont personnels (email, WhatsApp, Teams, Slack), avec un canal
  préféré et, pour WhatsApp, un consentement explicite et vérifié, horodaté, avec sa source.
- Le catalogue d'intégrations est présenté par rôle, avec une distinction nette entre ce que la
  personne doit connecter (sa boîte, son CRM, sa plateforme d'outreach) et ce que l'organisation
  fournit déjà (téléphonie, factures, vidéo, voix).

### 4.5 Ce qui se partage, et comment

| Objet | Visibilité conçue | Partage |
|---|---|---|
| Briefing quotidien | par personne, avec repli sur le briefing d'organisation pour le propriétaire | lecture seule, jamais réécrit par un autre |
| Décisions et approbations | par propriétaire de décision, plus approbateurs déclarés | délégation explicite, jamais implicite |
| Missions et délégations | délégant et assigné, plus les approbateurs | réassignation, relance, réponse, réouverture |
| Tâches assignées | la personne assignée (et son délégant pour le suivi) | question et blocage remontent au délégant |
| Pile personnelle | par personne (masquage, report, accusé de lecture) | aucun partage, c'est une vue privée |
| Stratégie et objectifs | organisation, en lecture pour tous | édition réservée |
| Workspaces et agents composés | créateur, avec partage explicite à une personne ou à un groupe | duplication, partage, révocation |
| Artefacts et livrables | organisation d'appartenance, accès contrôlé | pièces scellées, résolution refusée hors périmètre |
| Mémoire | organisation, avec partage déclaré et propriétaire nommé | un fait partagé est lisible, un fait personnel ne l'est pas |
| Journal d'audit | administrateurs | lecture seule, chaîné |
| Données personnelles | la personne, et l'administrateur pour l'effacement | effacement par personne, rétention et scellement par enregistrement |

### 4.6 Notifications : à qui parle le produit

- **Push navigateur** : par appareil, avec un seuil choisi (critique seulement, élevé et plus, tout),
  filtré côté serveur ; plusieurs appareils par personne.
- **WhatsApp** : digest du matin au numéro de la personne, demande unitaire, retours de résultat.
- **Slack et Teams** : cartes de validation avec boutons, et messages de service.
- **Dans l'application** : bannière d'approbation dans le chat, rail HITL dans Olympus, mise à jour
  temps réel de la pile et des compteurs, badge de navigation.
- **Digest hebdomadaire d'imputabilité** : santé des délégations, tâches à risque, réouvertures,
  leçons, et ce que les assignés ont réellement répondu, une fois par semaine et par organisation.
- **Principe** : une notification parle au propriétaire du fait. Elle ne part jamais sur le canal
  personnel d'un autre, ni sur le canal d'organisation par défaut.

### 4.7 Écart entre le conçu et l'état observé

Le modèle est conçu pour plusieurs personnes, plusieurs rôles, plusieurs canaux et plusieurs
organisations. L'état observé par les audits internes est plus étroit : la couche données isole
correctement les organisations, mais le moteur qui produit l'activité est resté mono-organisation
(une seule organisation reçoit briefing, triage, post-appel, factures), le routage des notifications
retombe sur le propriétaire global, un membre ne peut pas déléguer depuis le chat, la persona n'est
pas consommée, et plusieurs vues d'analyse sont partagées au niveau de l'organisation alors qu'elles
devraient être filtrées par personne. La refonte doit traiter ces deux axes comme un seul modèle,
pas comme deux chantiers séparés.

---

## 5. Défauts d'expérience connus, convertis en exigences pour la refonte

Cette section ne liste pas des bugs : elle transforme chaque défaut documenté par les audits
internes en exigence d'expérience vérifiable. Quand un défaut est daté et chiffré, le document
d'audit qui l'établit est cité dans la même ligne.

### 5.1 Fiabilité du récit : le briefing ne doit jamais inventer

| Défaut observé | Ce que l'utilisateur en subit | Exigence de refonte |
|---|---|---|
| Briefing construit sur des alertes recyclées (jusqu'à trois mois) et des rapports d'agents écrits alors que leurs outils étaient en panne ; sur les cinq indicateurs mis en avant, aucun n'était une mesure du jour ; attributions d'agents fausses, identifiants et montants fabriqués (`audit-briefing-incoherences-2026-06-08`) | Il ne peut plus croire ce qu'il lit, donc il revérifie tout, donc le produit ne lui fait rien gagner | Chaque chiffre affiché est tracé à une source, daté et attribué à l'agent qui l'a réellement produit ; une source indisponible produit un état « données indisponibles » explicite et jamais un chiffre ; un même signal ne peut pas servir deux fois dans deux sections |
| Un brief fabriqué sans données est indistinguable d'un brief valide | Confiance détruite en silence | Statut de donnée de première classe (disponible, partielle, indisponible) visible sur la carte et dans la section ; la confiance affichée dépend de la source, pas d'une constante |
| Brief non daté par sa génération, date du jour affichée à la place | Incertitude « est-ce le brief d'aujourd'hui ? » | Tout affichage porte la date et l'heure de génération ; un brief qui n'est pas du jour est signalé et relançable |
| Contexte stratégique injecté comme s'il était frais | Crise inventée le matin, bruit qui écrase l'essentiel | Le contexte stocké est étiqueté comme contexte et daté ; il n'est jamais présenté comme une mesure du jour |

### 5.2 Actionnabilité : une page, un fait, une décision prête

| Défaut observé | Ce que l'utilisateur en subit | Exigence de refonte |
|---|---|---|
| Page d'arrivée dépendante du dernier mode utilisé ; décisions éparpillées entre brief, fil, délégations et Outlook (15 à 25 gestes) (`02-PLAN-AJUSTE`) | Il ne sait pas où commencer et refait le tour de quatre surfaces | Une page d'arrivée unique et stable, sections explicites, compteur exact et identique partout |
| Un fait produit plusieurs cartes, dont une carte leurre dont la validation ne fait rien | Il valide du vide et perd confiance dans les boutons | Une clé de fait structurée, une carte par fait, et zéro carte dont l'action n'a pas d'effet réel |
| Les constats (environ 95 pour cent des propositions en production) occupent la fenêtre de lecture et poussent les vraies décisions hors de la pile | Il ne voit jamais ses décisions | Les constats sortent de la pile et vont au contexte ; la lecture des décisions est filtrée à la source, pas après coup |
| Compteurs marqués exacts alors qu'une source a échoué, plafonds silencieux, indicateur « il y a plus » toujours vrai | Il croit avoir tout vu alors qu'il manque des décisions | Un plafond n'est jamais silencieux (« au moins n »), un échec de source n'est jamais un zéro, et l'exactitude est un état explicite par section |
| 91 pour cent des items ouverts n'apparaissent dans aucune pile (`REPRISE-2026-10-09`, relevé du 9 octobre) | Des décisions disparaissent sans trace | Règle par défaut « non classé, visible » : aucun item lu ne peut être écarté faute de règle ; un test couvre chaque statut possible |
| Aucun accusé de lecture sur les expirations | Les expirations historiques gonflent le badge pour toujours | Un accusé de lecture explicite, avec motif, sort l'expiration des exceptions ; la date affichée est celle de la transition, pas celle de la création |

### 5.3 Des verbes qui font exactement ce qu'ils disent

| Défaut observé | Ce que l'utilisateur en subit | Exigence de refonte |
|---|---|---|
| « Déléguer » exécute l'action ; le fil valide une délégation sans brouillon ; « Déléguer » de la stratégie appelle une route inexistante ; « Relancer » lance une mission globale | Chaque bouton est une surprise ; il ne peut plus déléguer de confiance | Cinq verbes, toujours dans le même ordre et à la même place (Valider, Modifier, Déléguer, Reporter, Refuser), chacun avec un effet serveur documenté et testé ; un verbe non autorisé reste visible, grisé, avec sa raison |
| Validation possible sans avoir lu le contenu (le client seul décidait de l'affichage) | Validation à l'aveugle, contraire à la règle fondatrice | Le contenu complet n'est délivré que par le panneau ; valider exige l'empreinte du contenu vu et un identifiant de vue ; un contenu modifié entre-temps donne un refus explicite |
| Refus et clôture remettent l'item du brief en attente, donc il revient le lendemain | L'utilisateur ne peut pas clore un sujet | Un refus ou une clôture est définitif pour ce fait, sauf fait nouveau ; le motif est enregistré et alimente l'apprentissage |
| Statuts bloqué, refusé, expiré, annulé rangés dans aucune colonne du tableau de suivi | Des tâches invisibles | Chaque statut a une section et un verbe ; un test échoue si un statut ne produit aucune section |
| Annulation locale (dans le navigateur) présentée comme un vrai retour arrière | L'utilisateur croit avoir annulé ce qui est parti | Le report et le refus sont enregistrés côté serveur ; l'annulation est une décision serveur, ou n'est pas proposée |
| Action autonome « annulée » par un simple marquage, sans compensation | Promesse d'annulation mensongère | Une action n'est annulable que si la compensation existe réellement ; sinon l'écran ne propose pas le bouton |

### 5.4 Fermer la boucle : preuve plutôt que déclaration

| Défaut observé | Ce que l'utilisateur en subit | Exigence de refonte |
|---|---|---|
| 62 pour cent des délégations expirent sans suite ; 88 pour cent des clôtures prouvent que le CEO a fait le travail lui-même ; aucune tâche n'a jamais atteint « livré » puis « vérifié » (`audit-2026-09-03`) | L'illusion d'une équipe qui travaille, et un CEO qui travaille deux fois | La clôture exige une preuve observée dans le système source ; « livré » et « vérifié » sont des états distincts et mesurés ; l'expiration est un échec suivi, pas un déchet |
| Le vérificateur de livrable existe mais n'a jamais tourné en production, faute de portail assigné | Aucune preuve de travail d'assigné | Le chemin « livrer puis vérifier contre les critères » est un parcours de première classe, accessible et mesuré |
| Le lien du brouillon Outlook n'est jamais affiché, alors qu'il est stocké ; « à envoyer par vous » n'existe pas | L'utilisateur ne sait pas ce qui reste à sa main | Section « à envoyer par vous » avec lien, boîte et âge ; l'envoi détecté fait passer la ligne en « envoyé le … » |
| Les brouillons validés ne sont jamais réconciliés ; une réponse reçue n'est pas rattachée ; la relance approuvée n'a aucun étage de dispatch | Boucle ouverte, relances fantômes, sujets dupliqués | Tout ce qui a été validé est suivi jusqu'à une preuve ; une relance approuvée part réellement ; une réponse rouvre le même sujet |
| Les propositions de relance sont journalisées comme envoyées au moment de la proposition | Statistiques fausses, alertes inutiles | « Proposé » et « envoyé » sont deux états distincts, jamais confondus dans l'affichage ni dans les compteurs |
| Le travail humain réel n'est pas mesuré (ni questions, ni blocages, ni livraisons) | Impossibilité de dire si le produit fait travailler les gens | Chaque état de mission est un événement daté et attribué, visible dans le suivi et comptabilisé |

### 5.5 Hors écran : WhatsApp, push et mobile

| Défaut observé | Ce que l'utilisateur en subit | Exigence de refonte |
|---|---|---|
| « Exécution en cours » annoncé avant d'agir ; le message dit « OK pour envoyer » alors que la règle est brouillon seulement | Mensonge sur l'issue, perte de confiance | La réponse est construite après l'action, sur le résultat réel : « brouillon prêt, lien » ou « rien fait, cause » |
| Une question annule l'action ; une correction se perd ; une seule demande est visible ; une demande peut être évincée sans avertissement | Il n'ose plus répondre autre chose que « ok » | Une question ne vaut jamais décision et la demande reste en attente ; une demande évincée est annoncée ; plusieurs demandes sont visibles et numérotées |
| Le digest permettait de valider sans avoir lu le corps | Validation à l'aveugle sur un canal | Le digest ne sert qu'à repérer et à reporter ; valider exige le corps complet, sinon renvoi vers la lecture |
| Numéros du digest résolus contre le classement courant | « voir 1 » ouvre une autre décision | Le numéro est figé à l'envoi ; un digest ou une carte périmés sont refusés avec un message explicite |
| Pas de motif de refus hors écran | Refus inexploitable, aucun apprentissage | Refus guidé par une liste de motifs, note libre, délai de réponse court |
| Notifications de délégation routées vers le canal personnel du dirigeant quel que soit le destinataire | Un membre reçoit sur le téléphone d'un autre, ou l'inverse | Chaque notification part sur le canal de la personne concernée, avec repli explicite et compteur d'anomalies |

### 5.6 Le membre et l'expérience par rôle

| Défaut observé | Ce que l'utilisateur en subit | Exigence de refonte |
|---|---|---|
| Un membre ne peut pas déléguer depuis le chat (outil non mappé pour son rôle) ; le service interne ne lui est pas accordé, il perd l'accès aux outils de conversation | Le membre est un spectateur | Le parcours membre est complet : déléguer, recevoir, approuver ses propres brouillons, suivre, répondre, livrer |
| Le choix de rôle au premier login n'est pas persisté (perdu au changement d'appareil) et n'a aucun effet | Persona décorative | Persona persistée côté serveur, éditable, consommée par le briefing, le classement et la rédaction |
| Le briefing est identique pour tous les membres de l'organisation | Un CMO reçoit le briefing du CEO | Un briefing par personne, au prisme de son rôle, avec un budget de lecture propre |
| « Mes tâches » cherche le nom du dirigeant en dur ; le fil exclut les tâches du membre ; l'assigné voit des brouillons non validés | Aucun chemin de bout en bout pour le membre | Une vue assigné unique et correcte, alimentée par la propriété réelle des objets |
| Le contrat (livrable, critères) n'est affiché nulle part | L'assigné ne sait pas ce qu'on attend | Le contrat est visible sur la fiche de tâche, avec l'échéance et les actions possibles |
| Les connecteurs de la pile marketing ne sont pas exposés en self-service (404 à la connexion) | Le CMO ne peut pas travailler avec ses outils | Chaque rôle voit ses outils dans le catalogue et peut les connecter seul |
| Une organisation peut contenir plusieurs personnes, mais les vues d'analyse et les listes ne sont pas filtrées par personne | Chacun voit la stratégie, les délégations et les tableaux de tous | Décider explicitement, objet par objet, ce qui est partagé et ce qui est personnel, et l'appliquer dans les vues |

### 5.7 Multi-organisation

| Défaut observé | Ce que l'utilisateur en subit | Exigence de refonte |
|---|---|---|
| Le moteur d'activité est mono-organisation : une deuxième organisation n'a ni briefing, ni triage, ni post-appel, ni factures (`audit-agentic-multitenant-2026-07-09`) | Un client payant reçoit une coquille vide | Tout ce qui produit de l'activité (briefing, scans, analyses, réconciliation, apprentissage) tourne pour chaque organisation, avec son fuseau et ses connecteurs |
| Les notifications et certains flux temps réel retombent sur le propriétaire global | Une activité d'une organisation arrive chez quelqu'un d'une autre | Le routage est résolu par organisation et par personne, refus par défaut si non résolu |
| Des vues d'analyse lisent sans prédicat d'organisation | Lecture de données d'une autre organisation | Aucune lecture sans prédicat d'organisation ; un contrôle automatisé empêche la régression |
| Le propriétaire d'organisation n'a pas d'écran pour naître : pas de provisioning guidé | Mise en service manuelle, donc risquée | Un parcours de création d'organisation atomique qui seede le propriétaire, les groupes, les approbateurs et les tâches planifiées |

### 5.8 Autonomie : une promesse qui doit être tenue ou retirée

| Défaut observé | Ce que l'utilisateur en subit | Exigence de refonte |
|---|---|---|
| L'interface promet des niveaux d'autonomie, mais le seul mode réel est « proposer en validation unitaire ou rien », avec un plafond d'une proposition en attente qui diffère le reste en silence | Promesse non tenue, actions perdues | Soit un mandat borné réel (périmètre de destinataires, appels autorisés figés, plafond d'émissions, expiration, interrupteur d'arrêt, journal des évaluations), soit un seul mode annoncé honnêtement |
| Aucun mandat : pas d'enveloppe, pas d'empreinte de contenu vérifiée au départ, pas de durée de validité réévaluée, pas d'arrêt d'urgence par décision | Confiance impossible à accorder | Une enveloppe approuvée une fois est réévaluée à chaque envoi, peut être arrêtée immédiatement, et une validation ne survit pas à la modification du contenu |
| L'annulation d'une action autonome ne défait rien ; l'interrupteur d'arrêt n'est pas audité | Faux sentiment de contrôle | Toute promesse d'annulation ou d'arrêt est soit réelle et auditée, soit absente de l'interface |

### 5.9 Confiance, sécurité et honnêteté de l'interface

| Défaut observé | Ce que l'utilisateur en subit | Exigence de refonte |
|---|---|---|
| Deux doctrines d'approbation coexistent (propriétaire d'organisation et propriétaire du fait), et un administrateur peut approuver le sortant nominatif d'un membre | Le modèle d'autorité n'est pas lisible, donc pas fiable | Une seule doctrine, écrite, appliquée à toutes les portes, et lue à l'écran (« qui peut valider, et pourquoi ») |
| Validation possible par un tiers non habilité (porte de messagerie non fermée par défaut) et routes de démonstration exposées sans authentification | Risque d'envoi non autorisé | Une seule porte d'approbation, authentifiée, avec une trace de l'acteur réel et non de l'approbateur attendu |
| Miroirs de validation à durée de vie courte et sessions orphelines (26 cas constatés) | Des décisions invisibles ou fantômes | Chaque appel en attente a une carte unique, ou une exception visible et actionnable ; ni doublon, ni orphelin silencieux |
| Le journal d'audit enregistre l'approbateur attendu, pas l'acteur réel ; certains chemins d'approbation n'écrivent aucune ligne | Impossibilité de prouver qui a validé | Chaque décision écrit une ligne nominative, avec l'acteur authentifié, la cible, le contenu figé et l'horodatage |
| Défauts dits « muets » : une erreur de source affichée comme un vide, un 404 converti en liste vide, un plafond qui se présente comme un total, un aperçu tronqué qui remplace le contenu | Le produit se tait quand il ne sait pas | Toute absence a une cause affichée ; toute limite est nommée ; aucun contenu tronqué n'est présenté comme complet |

### 5.10 Onboarding et mise en service

| Défaut observé | Ce que l'utilisateur en subit | Exigence de refonte |
|---|---|---|
| Le produit est présentable à un utilisateur, mais pas à une deuxième personne de la même organisation sans passer par le propriétaire (`audit-multiuser-onboarding-cmo-2026-06-09`) | Le passage de un à plusieurs casse le produit | Considérer « deuxième utilisateur » et « deuxième organisation » comme deux critères de recette, avec un parcours complet chacun |
| Un membre invité sans groupe a une surface d'outils vide, dégradation silencieuse | « Ça ne marche pas », sans explication | Un groupe par défaut seedé, ou une bannière qui explique et propose l'action |
| Les limites connues (feed peu peuplé, triage sur les boîtes partagées, notifications vers le propriétaire, vues partagées) ne sont pas dites à l'utilisateur | Il conclut à une panne | Annoncer explicitement les limites dans la checklist d'onboarding, et les retirer au fur et à mesure |

### 5.11 Ordre de priorité pour la refonte

| Priorité | Exigence | Critère d'acceptation |
|---|---|---|
| P0 | Une seule page d'arrivée, datée, avec compteur exact et sections honnêtes | Trois décisions réglées en moins de deux minutes, zéro état faux, aucune source en échec masquée |
| P0 | Le panneau de décision : contenu complet, empreinte de contenu, boîte scellée, cinq verbes à effet réel | Un bouton par décision, un effet documenté par bouton, aucun envoi possible sans lecture du contenu |
| P0 | Une carte par fait, constats hors de la pile, non classé visible | Zéro doublon, zéro item écarté faute de règle |
| P1 | La boucle fermée : à envoyer, envoyé, répondu, livré vérifié, expiré avec motif | Une mission réelle va jusqu'à la preuve sans geste manuel, et un refus ne revient pas |
| P1 | L'expérience par personne : persona consommée, briefing par rôle, notifications au propriétaire, connecteurs self-service | Une deuxième personne de la même organisation a une expérience complète sans le propriétaire |
| P1 | Hors écran : résultat réel, motifs, demandes numérotées et non évincées | Une validation WhatsApp informée en 2 gestes, issue confirmée sur le même canal |
| P2 | Deuxième organisation réellement autonome | Une organisation neuve reçoit briefing, scans, validations sur son canal, et rien de l'autre organisation |
| P2 | Autonomie bornée sous mandat, avec arrêt et annulation réels | Une enveloppe approuvée exécute plusieurs envois et peut être arrêtée et auditée |
| P2 | Surfaces manquantes : portail assigné, fiche de tâche, vue délégant, graphe de délégation | Un externe sans compte lit, livre, refuse ; un délégant voit ce qui l'attend, groupé par personne |

---

*Fin de l'audit produit. Notes fonctionnelles uniquement : aucune ligne de code, aucun fichier du
projet source n'a été modifié ni copié. Seuls des noms de pages et de routes sont cités, pour la
traçabilité des capacités exposées.*
