# Audit fonctionnel: agents et missions

> Audit en lecture seule du projet source (`ceo-dashboard`, produit Tellus / Duke Workbench).
> Objectif: extraire l'INTENTION FONCTIONNELLE (comportement attendu, boucles, règles) et non
> l'implémentation, pour reconstruire le produit sur une autre base.
> Aucun extrait de code. Seuls des noms de fichiers, classes et fonctions sont cités pour la
> traçabilité. Sources principales: `docs/AGENT_SYSTEM_SPECIFICATION.md`, `docs/agents-strategy.md`,
> `docs/audit-autonomy-vision-2026-06-11.md`, `docs/audit-briefing-incoherences-2026-06-08.md`,
> `docs/audit-task-generation-slop-2026-06-03.md`, `docs/RESUMPTION-PLAN-TEL730-hallucination-hardening.md`,
> `docs/audit-2026-09-03-tellus-vs-definition-cible.md`, `docs/audit-agents-tenants-users-2026-07-14.md`,
> `docs/hitl-unified-pile-2026-06-04.md`, puis `src/agents/` (framework, pipelines), `src/agents/sub_agents/`,
> `src/orchestrator/mission.py`, `src/services/night_*` et `src/agents/scheduler.py`.

---

## 1. Objectif du produit

Donner au dirigeant de Duke Analytics (et à son équipe) une équipe d'agents qui observe en continu les
systèmes de l'entreprise (mail, calendrier, CRM, appels, tickets, factures, campagnes, web), en tire un
briefing quotidien priorisé, prépare et documente les boucles de travail (réunions, comptes clients, ventes,
finance, marketing), et n'agit jamais à l'extérieur sans validation humaine explicite.
Le produit ne remplace pas la décision: il supprime le temps de collecte et de synthèse, et fait travailler
les humains sur les bons sujets (philosophie affichée: "les agents font travailler l'équipe, les humains
valident"). Cible réelle: un CEO multi-entités (La Réunion, Maurice, France) avec 4 sociétés dans Dolibarr,
2 boîtes mail, des clients grands comptes et une équipe d'une vingtaine de personnes.
La valeur se mesure en temps gagné, en sujets manqués évités, et en travail humain réellement déclenché
(et non en nombre d'actions produites).

---

## 2. Agents

Trois familles cohabitent et doivent être reconstruites comme trois couches distinctes:

1. **Agents autonomes** (pipelines IPO: Input, Process, Output). Ils écoutent un événement ou un cron,
   exécutent un plan déterministe de quelques étapes, produisent une action dans le fil et une mémoire.
2. **Sous-agents spécialistes** (panthéon). Un domaine, un connecteur, un jeu d'outils restreint, un
   prompt de rôle. Ils ne décident pas de la priorité: ils répondent à une question de domaine.
3. **Le coordinateur**. Il ne voit pas les 80+ outils mais une douzaine de méta-outils `ask_<agent>`,
   raisonne en mode think, appelle les sous-agents en parallèle, croise et synthétise.

Règle de conception structurante: 1 agent = 1 responsabilité; le LLM raisonne, le code fait la plomberie
(récupérer, formater, parser, persister); tout agent suit le même cycle (enrichir, planifier, exécuter,
corriger, persister, mémoriser); aucune action externe ne contourne le gate humain.

### 2.1 Tableau A: agents autonomes et pipelines déterministes

| Agent (classe / fichier) | Rôle | Entrées | Connecteurs | Sorties | Cadence | HITL |
|---|---|---|---|---|---|---|
| **Helios** (Coordinator, `coordinator.py`) | Chef d'orchestre du briefing et des commandes CEO; raisonne puis délègue | Déclencheur matinal/nuit, commande CEO, alertes stratégiques, objectifs, profil utilisateur | Aucun accès direct: 12 méta-outils `ask_*` + date courante | Briefing structuré (focus areas, timeline du jour, dispatch équipe), priorités, JSON strict | 03h00 (nuit) et à la demande | Oui pour toute action externe (les écritures restent des outils gatés) |
| **Pipeline nocturne** (`night_briefing_pipeline`) | Assemble le briefing en 7 phases: 12 briefs, recoupement, composition, préparation réunions, brouillons, relecture critique, cockpit | Briefs des agents, calendrier du jour, délégations proposées | Indirects (via sous-agents) | Briefing persisté + actions + préparations de réunion + snapshot cockpit | 03h00 | Non pour composer; oui pour tout ce qui sort |
| **Eos** (MorningBriefingAgent, `morning_briefing.py`) | Briefing matinal en 4 étapes (briefing précédent, génération, persistance, carte au fil) | Cron matinal | O365 + service de briefing (6 sources) | BriefingRecord + carte dans le fil | 7h à 8h45 (désactivé au profit du pipeline nocturne, cf. TEL-354) | Non |
| **Angelia** (EmailTriageAgent, `email_triage.py`) | Classe chaque mail entrant, croise client et finance, déduplique, décide s'il y a action | Poll boîte mail | O365, Attio, Dolibarr, mémoire | Action classée + score de priorité + mémoire | Toutes les 2 min | Non pour classer; oui pour toute réponse |
| **Mercury en mode autonome** (`sub_agents/mercury.py`) | Triage LLM few-shot d'un mail reçu et création d'action si non trivial | Événement "mail reçu" | O365 + règles de triage apprises de l'utilisateur | Action de triage, priorité, trace | Toutes les 2 min | Oui (envoi/réponse) |
| **Argus** (InvoiceWatcherAgent, `invoice_watcher.py`) | Surveille les impayés et prépare des relances progressives | Cron factures | Dolibarr + LLM | Alertes + brouillons de relance par palier (J+7, J+15, J+30, J+45) | Quotidien 8h | Oui (brouillon seulement, jamais d'envoi) |
| **Plutus en mode autonome** (`sub_agents/plutus.py`) | Scan des impayés sur les 4 entités, total consolidé en EUR, alerte si significatif | Cron factures | Dolibarr (4 entités, 3 devises) | Alerte financière + synthèse | Quotidien 8h | Non pour l'alerte |
| **Kairos** (PreMeetingAgent, `pre_meeting.py`) | Prépare un dossier complet avant une réunion (client, historique, tickets, factures, derniers appels) | Poll calendrier, 30 min avant l'événement | Attio, Leexi, Jira, Linear, Dolibarr, O365 | Brief de réunion structuré + action MEETING_PREP | 30 min avant chaque réunion (poll 30 min) | Non |
| **Clio** (PostCallAgent, `post_call.py`) | Transforme un appel terminé en actions concrètes: tickets, note CRM, brouillon de suivi | Poll appels | Leexi, Attio, générateur d'emails | Actions + brouillon d'email + mémoire | Toutes les 3 min | Oui pour l'envoi |
| **Themis** (MeetingIntelligenceAgent, `meeting_intelligence.py`) | Catégorise l'appel en 6 types (projet client, vente, interne, marketing, RH/admin, partenariat) et dispatche vers les bons systèmes | Appel terminé | Leexi, Attio, Jira, Linear, mémoire | Tickets, note CRM, brouillons, connaissances | Toutes les 3 min | Oui sur les écritures CRM/Jira/Linear |
| **Tyche** (LeadScoringAgent, `lead_scoring.py`) | Score les leads et route: MQL (>=50) vers le CEO, pré-MQL (30 à 49) en nurturing, veille (<30) | Signal lead (poll 10 min) | Attio + campagnes + appels | Dossier MQL, séquence de nurturing, veille | Sur signal | Oui pour l'approche commerciale |
| **Nyx** (DailyRetrospectiveAgent, `daily_retrospective.py`) | Bilan de fin de journée: erreurs, décisions, cause racine, fix proposé, score de santé | Journal du jour | JournalStore + LLM | Rétrospective structurée + health score | Quotidien 18h | Non |
| **Hesperus et Saturnus** (ClosingBriefingAgent, `closing_briefing.py`) | Debrief en arrière: non fait, urgent non traité, reporté avec raison | Briefing du matin, actions de la période, agenda | Stores internes | Debrief EOD (19h locale) et EOW (vendredi 17h locale) | 1 fois/jour et 1 fois/semaine | Non |
| **Calliope** (SprintReporterAgent, `sprint_reporter.py`) | Rapport de sprint croisant Jira et Linear: vélocité, completion, blockers | Cron fin de semaine | Jira, Linear, mémoire | Rapport + mémoire de vélocité pour tendance | Vendredi 17h | Non |
| **Strategos** (revue stratégique, `scheduler.py`) | Revue des objectifs et KPI, écarts par fonction, plans d'action structurés (qui, quand, comment) | Cron hebdomadaire | Objectifs/KPI + sous-agents | Recommandations, plans, délégations | Lundi 8h30 | Oui pour les actions |
| **Nike** (CommandAgent, `command_agent.py`) | Interprète une commande du CEO en langage naturel et l'exécute ou la propose | Requête du CEO | Multi-connecteurs | Action exécutée ou proposée | À la demande | Oui pour les envois |
| **Zeus** (personas de notification, `scheduler.py`) | Porte la voix de chaque agent sur WhatsApp (une persona par agent) | Alerte d'agent | WhatsApp | Message court avec persona | Sur événement | Non (notification seule) |

### 2.2 Tableau B: sous-agents spécialistes (panthéon)

Ils sont appelés par le coordinateur, et 12 d'entre eux tournent aussi chaque nuit dans le briefing.

| Agent | Domaine et connecteur | Entrées | Sorties | Cadence | HITL |
|---|---|---|---|---|---|
| **Mercury** | Office365: mails et calendrier (13 outils) | Question de domaine, mails, calendrier, 2 comptes | Synthèse de mails, triage, brouillons, disponibilités | À la demande + nuit | Oui (envoi, réponse, événement) |
| **Atlas** | Attio CRM: clients, deals, tâches, notes, listes, reporting (18 outils) | Recherche, dossier client, pipeline | Fiches, tâches, notes, métriques CRM | À la demande + nuit | Oui (toutes écritures CRM) |
| **Vulcan** | Jira: projets clients (4 outils) | Tickets, recherche, JQL | Liste de tickets, blockers, créations | À la demande + nuit | Oui (création/mise à jour) |
| **Prometheus** | Linear: dev interne et sprints (3 outils) | Tâches, cycles | Rapport de sprint, vélocité, blockers | À la demande + nuit | Oui (création/mise à jour) |
| **Plutus** | Dolibarr: factures, devis, compta (6 outils, 4 entités, multi-devises) | Factures, propositions, notes de frais, commandes | Synthèse financière, impayés, CA | À la demande + nuit | Non (lecture seule) |
| **Echo** | Leexi: appels et transcriptions (2 outils) | Liste d'appels, détail, transcript | Synthèse d'appels, actions, sentiment | À la demande + nuit | Non (lecture seule) |
| **Hermes** | Lemlist + Kaspr: outreach et enrichissement (5 lectures, écritures proposées) | Campagnes, stats, leads, activités | KPIs de campagne, propositions d'actions | À la demande + nuit | Oui (écritures retirées de sa boucle et proposées) |
| **Apollo** | HeyGen, ElevenLabs, Gamma: médias (3 lectures, générations proposées) | Avatars, voix, statut vidéo | Plan de génération (script, avatar, voix), suivi | À la demande + nuit | Oui (crédits et validation) |
| **Mnemosyne** | Knowledge graph mémoire (2 outils) | Recherche sémantique, faits à sauver | Faits retrouvés, confirmations | À la demande + nuit | Non (écriture mémoire soumise au critic) |
| **Athena** | Brave Search: recherche web (2 outils + mémoire) | Question de recherche | Synthèse sourcée avec URLs | À la demande + nuit | Non (lecture) |
| **Iris** | WhatsApp, Slack, Teams: messagerie (17 outils de lecture + mémoire) | Conversations, threads | Synthèse multi-canal, messages non répondus | À la demande + nuit | Oui (jamais d'envoi direct) |
| **Hephaestus** | Browser Use + DesktopCommander: automatisation web et poste (préfixes d'outils) | Tâche d'automatisation | Actions, captures, fichiers | À la demande + nuit | Oui (commandes destructives) |
| **Delphi** | Duke Analytics BI: données et dashboards (2 outils) | Question analytique | Réponse Duke restituée intégralement (données, SQL, tables, graphiques) | À la demande + phase de recoupement nocturne | Non |
| **Architect** | Analyse de gap de capacité (2 outils mémoire) | Gap constaté | Plan de solution: skill, outil, sous-agent, ou escalade humaine | À la demande | Oui (création d'outil ou d'agent) |
| **Sous-agents dynamiques** (`dynamic.py`) | Agent créé à l'exécution avec son propre domaine, prompt et outils | Configuration runtime | Comportement identique à un agent statique | À la demande | Oui (création et périmètre d'écriture) |

### 2.3 Tableau C: sous-agents métier et méta

Ces agents traduisent la stratégie commerciale et marketing du produit (19 agents prévus au plan initial).

| Agent | Rôle | Entrées | Connecteurs | Sorties | Cadence | HITL |
|---|---|---|---|---|---|---|
| **Chronos** | Synthèse hebdomadaire multi-sources et deck | Semaine écoulée, synthèse précédente | Mail, calendrier, CRM, Jira, Linear, Dolibarr, Leexi, mémoire, Gamma | Bilan, métriques vs S-1, wins, risques, top 3 priorités, deck | Hebdo (vendredi) ou à la demande | Oui pour le partage et le deck |
| **Panoptes** | Fiche client 360 avec santé, risques, opportunités | Nom de client | Attio, Jira, Linear, Dolibarr, O365, Leexi, mémoire (14 outils) | Fiche 360 structurée + actions recommandées | À la demande | Non (lecture) |
| **Metis** | Veille concurrentielle à partir des mentions terrain | Calls, mails, CRM, web | Leexi, O365, Attio, Brave, mémoire (7 outils) | Rapport de positionnement, concurrents détectés, menaces, opportunités | À la demande / hebdo | Non (lecture) |
| **Ares** | Orchestrateur ABM: comptes cibles, décideurs, séquences | ICP, CRM, campagnes | Attio, Kaspr, Lemlist, Gamma, mémoire (12 outils) | Comptes priorisés, décideurs enrichis, stratégie d'approche | À la demande | Oui (enrichissement payant, campagnes) |
| **Pheme** | Performance des campagnes Lemlist et conversion en deals | Campagnes, activités | Lemlist, Attio, mémoire (7 outils) | KPIs, top/flop campagnes, funnel lead vers deal, recommandations | Hebdo | Non (lecture) |
| **Euterpe** | Moteur de contenu: sujets et formats issus du terrain | Calls, tickets, CRM | Leexi, Jira, Linear, Attio, Gamma, Lemlist, mémoire (9 outils) | Sujets, contenus multi-formats, calendrier éditorial | À la demande | Oui (publication) |
| **Peitho** | Sales enablement: brief avant rendez-vous commercial et assets | Prospect, deal, historique | Attio, Leexi, O365, Gamma, mémoire (10 outils) | Brief commercial, arguments, objections anticipées, assets | À la demande / avant call | Oui (envoi et assets externes) |
| **Aglaea** | Dashboard marketing hebdomadaire | Campagnes, pipeline, appels | Lemlist, Attio, Leexi, mémoire (7 outils) | KPIs, tendances, anomalies, 2 à 3 actions | Hebdo | Non (lecture) |
| **Thalia** | Cycle événement et webinaire (avant et après) | Audience, inscriptions, réponses | Attio, Lemlist, Gamma, O365, calendrier, mémoire (11 outils) | Invitations, supports, relances, analyse de participation | Par événement | Oui (invitations, événement calendrier) |
| **Cadmus** | Génération de documentation technique et fonctionnelle | Tickets, mails, décisions | Jira, Linear, O365, mémoire (7 outils) | ADR, specs, guides, release notes, comptes rendus | À la demande | Non |
| **Daedalus** | Assistant SQL: question vers requête, exécution en sandbox | Question, schémas | Sandbox Python (pandas, sqlite, matplotlib) + mémoire (3 outils) | Requête, résultats lisibles, graphiques | À la demande | Non (lecture seule, écriture interdite) |
| **Hestia** | Suivi de projets clients cross-plateforme | Jalons, sprints, deals | Jira, Linear, Attio, mémoire (15 outils) | État on-track/at-risk/delayed, tickets critiques, échéances | À la demande | Oui (création/mise à jour de tickets) |
| **Sophia** | Méta-apprentissage: performance des agents, patterns, optimisations | Historique de performance | Mémoire (3 outils) | Patterns de succès et d'échec, recommandations | Périodique | Non (propose, n'applique pas) |
| **Argus (renforcé)** | Surveillance avancée des factures: corrélation CRM, patterns de paiement, relances intelligentes | Factures, CRM, mails | Dolibarr, Attio, O365, mémoire (7 outils) | Rapport de relances priorisées, prévisionnel, patterns | Quotidien / à la demande | Oui (jamais d'envoi direct) |

### 2.4 Mécanique commune à tous les agents

- **Cycle unique**: enrichir (mémoire 48h, faits client, contexte métier) puis planifier, exécuter,
  auto-corriger (max 3 itérations), persister, mémoriser, publier dans le fil temps réel.
- **Trois niveaux de complexité** décidés avant l'agent: SIMPLE (aucun LLM, heuristique), STANDARD
  (un appel LLM, budget contraint), COMPLEX (pipeline complet enrichi). C'est un levier de coût majeur.
- **Budget de tokens par agent** et plafond quotidien global (la spécification de mars 2026 cite 50k pour
  le briefing, 30k pour le tri mail, 10k pour les factures, 250k pour le total journalier).
- **Événements métier** comme contrat d'entrée: appel terminé, mail reçu, réunion imminente, contrôle
  factures, déclencheur du matin, commande CEO, signal lead, revue stratégique, rapport de sprint,
  rétrospective, workflow.
- **Mémoire en trois couches**: épisodique (ce qui s'est passé), sémantique (entités et relations, graphe
  de connaissances), procédurale (leçons apprises des évaluations). Chaque agent lit avant d'agir et écrit
  après avoir agi; c'est ce qui rend les agents collectivement plus intelligents.
- **Évaluation et apprentissage**: chaque réponse du coordinateur est notée sur 6 dimensions
  (nouveauté, actionnabilité, exactitude, pertinence, croisement des sources, complétude), la note produit
  des leçons réinjectées au tour suivant d'une session.
- **Observabilité de l'agent lui-même**: trace de raisonnement diffusée en direct, latence et erreurs par
  composant, journal des erreurs et décisions, contrôle de santé périodique des connecteurs.

---

## 3. Les 6 boucles produit les plus importantes

### Boucle 1: briefing quotidien (le coeur du produit)

- **Déclencheur**: chaque nuit à 03h00 (et à la demande via un bouton "générer").
- **Données et chaîne**: 12 sous-agents observent en parallèle leur domaine (mail, CRM, Jira, Linear,
  finance, appels, outreach, médias, messagerie, automatisation, marché, mémoire), puis deux agents de
  recoupement (Delphi pour l'alignement stratégique, Mnemosyne pour la rétrospective) relisent ces briefs;
  le coordinateur compose et hiérarchise; suivent la préparation des réunions du jour, l'enrichissement des
  délégations proposées, une relecture critique et un instantané du cockpit.
- **Livrable et destinataire**: un briefing persistant ("Ce matin") avec 5 zones de focus maximum, une
  timeline de la journée et un dispatch par owner; destinataire le CEO (et le propriétaire du tenant dans
  une version multi-org).

### Boucle 2: courrier entrant, triage et traitement

- **Déclencheur**: poll de la boîte toutes les 2 minutes, plus un scan d'intelligence mail toutes les 5 min.
- **Données et chaîne**: lecture des mails entrants sur plusieurs boîtes, filtrage des newsletters et
  notifications automatiques, croisement avec le CRM (qui est ce contact, deal en cours) et la finance,
  vérification systématique du dossier "envoyés" pour ne pas relancer ce qui a déjà été répondu, puis
  classement (urgent, action, information, bruit) et proposition d'action.
- **Livrable et destinataire**: cartes d'action dans le fil (avec score de priorité), brouillons de réponse,
  mémoire; destinataire le CEO, toute réponse ou envoi restant soumis à validation.

### Boucle 3: boucle réunion, avant, pendant, après

- **Déclencheur**: poll du calendrier (30 min) pour le "30 minutes avant", poll Leexi (3 min) pour l'après-appel.
- **Données et chaîne**: avant, un dossier de réunion agrège CRM, derniers appels, tickets, factures et
  échanges; après, la transcription est catégorisée (projet client, vente, interne, marketing, RH/admin,
  partenariat) puis distribuée vers Jira ou Linear, une note CRM, des actions extraites et un brouillon de
  compte rendu.
- **Livrable et destinataire**: brief de réunion puis actions post-appel et brouillons; destinataire le CEO
  et les owners de projet, avec validation sur toute écriture dans un outil tiers.

### Boucle 4: relance facture

- **Déclencheur**: cron quotidien à 8h, plus la détection d'un mail contenant une facture en pièce jointe.
- **Données et chaîne**: lecture des factures impayées sur les 4 entités Dolibarr et devises, calcul du
  retard et du total consolidé en euros, croisement avec la santé du client dans le CRM et l'historique des
  relances déjà envoyées, puis escalade par palier (rappel amical, relance formelle, escalade décideur,
  contentieux à valider).
- **Livrable et destinataire**: alerte financière priorisée et brouillon de relance adapté au ton du client;
  destinataire le CEO et la comptabilité; l'envoi n'est jamais automatique.

### Boucle 5: synthèse hebdomadaire et clôtures

- **Déclencheur**: vendredi 17h (rapport de sprint et synthèse de semaine), vendredi 17h locale (debrief de
  semaine), chaque soir 19h locale (debrief du jour), lundi 8h30 (revue stratégique).
- **Données et chaîne**: agrégation de 6 sources et comparaison avec la semaine précédente (mails traités,
  deals avancés, tickets fermés, CA facturé, appels), puis catégorisation en wins, risques, actions en cours,
  à venir, avec top 3 des priorités de la semaine suivante; les debriefs de clôture croisent ce qui était
  prévu le matin avec ce qui a réellement été fait.
- **Livrable et destinataire**: synthèse hebdomadaire (texte et deck), debrief EOD/EOW en trois rubriques
  (non fait, urgent non traité, reporté avec raison), recommandations stratégiques; destinataire le CEO et
  la CMO.

### Boucle 6: pipeline commercial, marketing et veille

- **Déclencheur**: signal lead (poll 10 min), rapports hebdomadaires, et à la demande pour une fiche compte.
- **Données et chaîne**: score MQL selon un barème explicite (taille, secteur, stack existante, localisation,
  engagement campagne, demande de contact), enrichissement des décideurs, suivi des campagnes et du funnel
  lead vers reply vers deal, et détection des mentions de concurrents dans les appels, mails et deals perdus.
- **Livrable et destinataire**: dossier MQL transmis au CEO avec score détaillé et approche recommandée,
  tableau de bord marketing hebdomadaire pour la CMO, fiche concurrent et alertes; destinataire le CEO et la
  CMO, toute approche commerciale restant validée.

### Boucles secondaires (à prévoir, moindre priorité)

Veille technologique et marché en profondeur (Athena), gestion d'événement et webinaire (Thalia), cycle de
contenu éditorial (Euterpe), documentation (Cadmus), assistance SQL (Daedalus), suivi de délégation et de
SLA (rappels, escalade), auto-amélioration (revue des prompts proposée en validation), et workflows
planifiés déclenchés par cron ou événement.

---

## 4. Règles de comportement attendues

### Langue et ton

- **Français par défaut**, mais toujours **matcher la langue des échanges précédents** pour un mail (FR ou
  EN), et le **ton** (formel ou informel) de la conversation en cours. Ne jamais supposer la boîte d'envoi:
  la vérifier dans les envoyés.
- Ton **sobre, professionnel, direct, orienté décision**. Pas de commentaire personnel, pas de plaisanterie,
  pas de signature ajoutée (la messagerie la pose), pas de tiret cadratin dans un texte rédigé.
- **Niveau dirigeant**: agréger par projet, client ou owner plutôt qu'énumérer des tickets; résumer un
  domaine en 3 à 5 phrases; jamais de dump brut de données.

### Priorisation

- **Stratégique avant opérationnel**: les premières zones de focus doivent citer un objectif ou une alerte
  impactée, nommer l'écart et lister les actions manquantes; le réactif (un ticket, un mail) est agrégé.
- **Une zone de focus = un seul domaine**. Si un client cumule facture impayée, bug de livraison et
  renouvellement, produire plusieurs zones distinctes, jamais une boule unique.
- **Maximum 5 zones de focus**, triées par importance pour le CEO. Un signal ne doit pas être recyclé dans
  plusieurs zones. En cas de crise réelle (production down, sécurité), elle peut passer en tête.
- **Séparer passé et futur**, et distinguer le personnel du délégué. Ne jamais présenter un événement passé
  comme une priorité. Filtrer les événements annulés ou refusés.
- **Montants multi-devises**: afficher la devise locale avec l'équivalent en euros.

### Ancrage factuel (règle la plus importante)

- **Ne jamais inventer** un nom de contact, un identifiant de ticket, de deal ou de facture, un montant, un
  pourcentage. Un identifiant cité doit exister dans la réponse de l'outil qui l'a fourni.
- **Chaque chiffre doit venir d'une source**, et l'attribution doit être exacte: ne pas prêter à un agent un
  constat qu'il n'a pas produit (par exemple attribuer un constat de facturation à l'agent des appels).
- **Distinguer un deal (CRM) d'une facture (comptabilité)**, et un service desk client d'un produit interne.
- Si une source est indisponible, écrire "données indisponibles" et **ne produire aucun chiffre**; ne jamais
  mélanger "outil en panne" et "constat chiffré".
- **Dédupliquer**: une même référence de facture est la même facture, comptée une seule fois. Ne relier deux
  items que s'il existe un lien causal explicite.
- Une erreur d'outil n'est **pas** un résultat vide: distinguer erreur, vide et tronqué, et le dire.

### Ce qui est interdit

- **Aucun envoi sans validation humaine explicite**: mail, réponse, transfert, WhatsApp, Slack, Teams,
  invitation ou modification de calendrier, génération de vidéo avatar. Le défaut est le brouillon.
- **Aucune écriture dans un système tiers sans validation**: CRM, Jira, Linear, Swing, Lemlist, Dolibarr,
  Qonto. Ces outils sont gatés par conception, pas par discipline de prompt.
- **Aucun envoi automatisé en masse** (séquences Lemlist, enrichissement payant) sans annonce du coût et
  accord; les crédits (HeyGen, Kaspr, ElevenLabs) sont limités et non remboursables.
- **Aucun succès déclaré sur un échec**: ne jamais répondre "X leads ajoutés" ou "campagne créée" quand
  l'action n'a pas été exécutée; décrire la proposition, pas le résultat.
- **Aucune modification de données** (insertion, mise à jour, suppression) sans validation explicite.
- **Aucune action destructive** (suppression, formatage, arrêt de service) sans validation.
- **Aucun fallback silencieux**: une erreur doit être visible et nommée, jamais remplacée par une valeur par
  défaut crédible.
- **Pas de spam d'approbations**: le gate doit rester lisible (regrouper par source ou par dossier plutôt que
  noyer le CEO sous des cartes unitaires).

### Validation humaine (HITL)

- Le gate est **structurel**, pas déclaratif: un outil sensible est intercepté par le moteur, la boucle est
  mise en pause, une demande d'approbation est émise (dans l'application et sur le canal mobile), et rien ne
  s'exécute avant une décision.
- Le gate couvre aussi les variantes techniques des mêmes outils (appels directs aux serveurs de connecteurs),
  sinon le modèle contourne la règle sans le savoir.
- **Toute approbation est bornée à son objet et liée au contenu**: une validation pour un sujet ne vaut pas
  pour un autre sujet; modifier le destinataire ou le corps après approbation invalide l'accord.
- **Fail-closed**: timeout, erreur ou ambiguïté signifie "pas d'exécution", jamais "approuvé par défaut".
- Certaines actions sont volontairement **auto-exécutées** car sans effet tiers: créer une tâche ou un ticket
  interne, ajouter une note, produire une synthèse. Tout ce qui sort de l'entreprise est proposé.

### Mémoire et apprentissage

- **Lire la mémoire avant d'agir** (contexte client, décisions passées, corrections de l'utilisateur) et
  **écrire après** (fait, décision, préférence) avec provenance.
- Les corrections de l'utilisateur deviennent des **règles de triage** réutilisées, pas desmessages perdus.
- Une leçon apprise doit être **appliquée**, pas seulement produite: une amélioration de prompt proposée doit
  passer par une validation puis être réellement appliquée, sinon la boucle d'apprentissage est décorative.
- Ne pas mémoriser du contenu non vérifié: une réponse rejetée par le critique ne doit pas alimenter la
  mémoire ni le graphe de connaissances.

### Coût, charge et fiabilité

- Annoncer le coût avant un appel payant (enrichissement, génération média, campagne).
- Ne pas paralléliser au-delà de ce que la capacité de calcul supporte: au-delà d'une poignée d'agents
  simultanés, le gain est illusoire et la latence s'effondre.
- Un agent autonome doit toujours revenir: borner le temps d'un agent de nuit, dégrader proprement en
  rapport en erreur, et laisser les autres continuer.
- Un agent qui n'a pas de données doit le dire, pas inventer un rapport.

---

## 5. Ce qui est critique ou cassé d'après les audits internes

Cette section ne décrit pas des bugs de code mais des **défaillances fonctionnelles constatées en production**,
utiles pour ne pas reconstruire les mêmes angles morts.

### 5.1 Le briefing n'est pas fiable (audit du 2026-06-08)

Sur un briefing réel, **0 des 5 KPI de une était une mesure fraîche du jour**. Mécanisme en trois couches:
des alertes stratégiques périmées (jusqu'à 3 mois, avec des dizaines de doublons) réinjectées comme contexte
frais; des rapports de sous-agents produits alors que leurs connecteurs étaient en panne, mais marqués en
succès; et un orchestrateur sans règle d'attribution, qui a donc fabriqué des identifiants, des montants et des
attributions d'agent fausses (par exemple un constat de doublons de factures attribué à l'agent des appels,
qui n'a aucun accès aux factures). Des tickets existants ont été décrits comme bloqués alors qu'ils étaient
assignés, et le volume de tickets non assignés a été sous-estimé d'un facteur 8. Conclusion à retenir: sans
fraîcheur datée, statut "pas de données" et attribution stricte, un briefing de CEO est dangereux, pas
seulement imprécis.

### 5.2 Fabrication et empoisonnement de mémoire (incident SkyDeck, plan TEL-730)

Un mail a été **entièrement fabriqué** et un brouillon préparé vers une adresse inventée. Le mécanisme: une
mémoire préalablement polluée a été relue comme une source, un garde anti-fabrication a compté le bloc mémoire
comme une preuve, et le verdict du critique n'a pas bloqué l'écriture en mémoire. Les gardes existaient mais
laissaient passer une variante de la même mécanique (promotion d'une fabrication en "à raffiner" plutôt qu'en
"rejet", panne du modèle traitée comme un succès). Les corrections livrées ferment la cause racine, mais
l'audit a montré que **rien n'était instrumenté**: les signaux de rejet n'étaient que des logs, les verdicts
n'étaient pas persistés, aucune alerte n'était poussée. Une récurrence serait donc invisible.

### 5.3 Génération de tâches "slop" (audit du 2026-06-03)

La création de tâches CRM, Jira, Linear et de délégations souffre d'une défaillance en couches: la
déduplication est ancrée sur le record lié, donc une même action posée sur trois records n'est jamais
comparée; il n'existe aucune clé d'idempotence par source et par action, donc le briefing régénère chaque jour
les mêmes délégations (le seul dédoublonnage existant est un cache de 30 secondes); le contenu du LLM est
recopié brut dans le titre d'une tâche, sans nettoyage ni contrôle de non-vacuité, ce qui produit des tâches
placeholders réduites à des tags; et le routage (record, système, owner, projet) est entièrement délégué au
modèle, avec des défauts dangereux (un projet client codé en dur sur un client non résolu, un premier résultat
de recherche floue accepté sans vérification du nom). Effet net: bruit, données dégradées, file d'approbation
polluée, et quelques tâches orphelines. Les chemins gatés limitent l'impact, pas la qualité.

### 5.4 La boucle d'apprentissage est ouverte (audit de vision du 2026-06-11)

Le juge note, la réflexion injecte, les crons proposent des correctifs de prompt, mais **personne ne les
applique**: l'apprentissage produit du texte qui n'agit pas. Le graphe de connaissances n'est pas mis à jour
par les résultats observés, et l'outil de forge d'outils est du code mort en production. La note de maturité du
chantier apprentissage est de 2 sur 5. Corollaire: afficher des scores et des "leçons" sans mécanisme
d'application crée une illusion de progrès.

### 5.5 Pas de runtime durable, donc pas de tâche longue (même audit)

Les sessions ont une durée de vie de 2 heures et aucun point de reprise: un redémarrage perd tout. Il n'y a
pas d'état durable de tâche, pas de reprise à mi-parcours, pas de planification "fais ça demain 9h", pas de
délégation à un sous-agent en profondeur (profondeur 1, appel unique, pas de re-questionnement). Recherche
profonde et browser distant sont notés 1,5 et 1 sur 5. Conclusion: le produit est un excellent orchestrateur
de tâches **courtes et validées**, pas un agent autonome de longue haleine.

### 5.6 La validation humaine est là mais saturée, et l'autonomie est nominale

Le gate tient par construction (aucun chemin LLM n'atteint un tiers sans clic), mais la file d'approbations
sature: les approbations des agents autonomes n'étaient pas visibles dans l'application avant un correctif, les
têtes de file non résolues bloquaient les notifications jusqu'à 12 heures, et deux systèmes de validation
cohabitaient. Surtout, l'autonomie réelle se résume à "propose une action unitaire ou rien": avec un plafond
d'approbations en attente très bas, la plupart des actions sont **différées en silence**, sans que personne ne
le sache. Les niveaux d'autonomie existent dans les modèles mais ne changent pas le comportement à l'exécution.

### 5.7 La délégation à des humains ne produit pas de travail humain (audit du 2026-09-03)

Sur 989 délégations, **62 % ont expiré sans suite** et **88 % des clôtures prouvent que le CEO a fait le
travail lui-même**. Aucune tâche n'a jamais atteint un état "livré puis vérifié": il n'existe pas de preuve de
travail d'un assigné, et le seul chemin qui vérifie un livrable contre ses critères d'acceptation n'a jamais
tourné en production, faute de portail assigné. L'apprentissage ne tourne pas non plus sur les délégations.
Le pilier "les agents font travailler les humains" est donc noté 2 sur 10: la mécanique de proposition existe,
la fermeture de boucle non.

### 5.8 Le plan de contrôle des agents n'est pas multi-tenant (audits du 2026-07-14 et 2026-09-03)

Les données sont isolées par tenant mais **le moteur qui fait tourner la société d'agents reste un singleton
ancré sur le tenant par défaut**: le planificateur ne connaît quasiment pas le tenant (7 chemins sur 48), les
sous-agents statiques sont des singletons partagés, le registre des agents dynamiques est global, et les
notifications partent sur le téléphone du CEO quel que soit le tenant. Un second tenant n'a ni briefing, ni
apprentissage, ni notifications correctes. À reconstruire dès le départ comme multi-tenant, pas après.

### 5.9 Capacité des agents et saturation de contexte

Les sous-agents n'ont pas de compaction de contexte (ils contournent le pipeline de middlewares): la
troncature par résultat ne borne rien d'autre. Constaté en production: une requête de sous-agent partie avec
environ 127 000 jetons, refusée par le modèle, 331 secondes brûlées, et le rapport perdu donc absent du
briefing. La nuit, 12 agents partent en parallèle sur une seule instance de calcul: au-delà de quelques
agents, le parallélisme est illusoire et la phase dure ce que dure son agent le plus lent. Un agent bloqué sur
un connecteur en erreur d'authentification est resté 23 heures en vol faute de borne.

### 5.10 Ce qui tient malgré tout (à ne pas casser en reconstruisant)

Le gate de validation est le point fort: il est structurel, il couvre les variantes techniques des outils, et
aucun chemin trouvé ne permet à un modèle d'écrire chez un tiers sans décision humaine. L'audit chaîné des
actions, le caractère "fail-closed" des vérifications et la séparation entre proposition et exécution sont de
bonnes fondations. Le socle de test est massif (plusieurs milliers de tests) et l'architecture par couches
est saine. Ce qui manque n'est pas la sûreté, c'est la **fermeture des boucles** (preuve de livraison,
application des apprentissages, reprise d'état) et la **fraîcheur des données** présentées comme des constats.

---

## 6. Ce qu'il faut retenir pour la reconstruction

1. Le produit est un **système de propositions** avant d'être un système d'actions: la valeur est dans la
   qualité du brief et la pertinence des actions proposées, pas dans le volume exécuté.
2. Trois couches sont obligatoires et doivent rester séparées: agents de pipeline déterministes, sous-agents
   de domaine, coordinateur qui raisonne sur un petit nombre de méta-outils.
3. Quatre règles non négociables: **aucun envoi sans validation**, **aucun chiffre sans source datée**,
   **aucun succès sur un échec**, **aucune écriture tierce non gatée**.
4. Les six boucles à reconstruire en premier: briefing quotidien, tri du courrier, boucle réunion, relance
   facture, synthèse hebdomadaire et clôtures, pipeline commercial et veille.
5. Tout ce qui a trait à la **preuve** (fraîcheur, provenance, statut de données, verdict de qualité, preuve
   de livraison) est aujourd'hui le point faible du produit existant: le traiter comme un besoin de premier
   rang, pas comme du polish.
