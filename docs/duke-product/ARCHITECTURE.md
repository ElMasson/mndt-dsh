# mndt workbench sur DSH : architecture cible

Reconstruction from scratch, sur la base DSH, du produit décrit par le projet
local `ceo-dashboard`. Deux références, deux rôles : **Tellus** pour les
capacités (agents, missions, connecteurs, boucles produit) et **mndt** pour le
produit et sa marque. Ce document ne décrit que l'intention fonctionnelle et
l'architecture retenue ; il n'emprunte rien à l'implémentation existante.

## Le produit en une phrase

Une équipe d'agents autonomes qui prépare, exécute et documente le travail
quotidien de Duke Analytics (briefing, comptes clients, ventes, marketing,
finance), avec des connecteurs réels, une mémoire d'entreprise, et une
gouvernance qui dit qui a le droit de faire quoi.

## Ce qui change par rapport à l'existant

L'existant est une application Python autonome qui recâble ses propres agents,
connecteurs, workflows et interface. Ici, le runtime est DSH : agents, sessions,
outils, MCP, planification et interface sont déjà là. Le produit devient une
**couche métier** au-dessus de ce runtime, pas une seconde plateforme.

Trois conséquences pratiques :

1. les connecteurs ne sont pas réécrits : ce sont les serveurs MCP déjà montés
   par la composition DSH (mail, calendrier, Attio, Leexi, Dolibarr, Qonto,
   Gamma, HeyGen, Lemlist, Clay, Swing, Duke Analytics) ;
2. une mission est une session DSH créée par programme, avec des outils, un
   modèle et un prompt de rôle ; son résultat est capturé et conservé ;
3. la gouvernance n'est pas réinventée : l'autorité RBAC déjà déployée porte
   les rôles, l'audit et l'identité Entra.

## Découpage

    packages/host/mndt          domaine (src/core) + plugin hote : API HTTP,
                                execution des missions via ctx.agents, face
                                Remote pour la page
    packages/client/ui-mndt     page produit : Ce matin, Missions, Artefacts,
                                Connecteurs, Memoire, Approbations
    packages/bundle/mndt-app    composition : base + connecteurs MCP + mndt
    deploy/                     service systemd, SSO Entra, jetons

Le domaine vit dans le paquet hôte tant qu'il n'a qu'un consommateur ; il sera
extrait le jour où un second en aura besoin, pas avant.

Le serveur héberge la couche Duke et le runtime ; le poste de travail affiche
les pages et peut lancer des missions. Le même identifiant circule partout :
email Entra pour le navigateur, jeton nominatif pour un poste.

## Modèle de domaine

    Mission      id, kind, prompt, status, createdBy, sessionId,
                 startedAt, finishedAt, error, visibility
    Brief        id, missionId, title, markdown, sources, status,
                 approvedBy, sharedWith
    Memory       id, scope (team|user|mission), kind, text, source, createdAt
    Approval     id, missionId, kind (send-email|publish|spend|delete),
                 payload, state, decidedBy, decidedAt
    Connector    serverName, status, capabilities, governed

Statuts d'une mission : `queued`, `running`, `done`, `failed`, `needs-review`.
Un brief n'est jamais publié sans `approved` quand il contient une action
externe ; c'est la règle des emails du projet d'origine, généralisée.

## Boucles produit

1. **Briefing quotidien** : agenda, courriers sans réponse, comptes à risque,
   échéances de facturation, préparation des réunions du jour. Un brief markdown
   avec ses sources, produit chaque matin, relu et partagé.
2. **Préparation de réunion** : à partir d'une réunion du calendrier, dossier
   client, derniers échanges, appels Leexi, sujets ouverts, questions à poser.
3. **Revue de compte** : santé du compte, jalons, factures, risques, prochaines
   actions, avec les preuves issues des connecteurs.
4. **Relance facture** : factures échues dans Dolibarr et Qonto, relances
   rédigées, en attente d'approbation avant tout envoi.
5. **Veille et contenu** : signaux marché et concurrents, brouillons de contenu
   marketing, toujours soumis à validation.
6. **Synthèse hebdomadaire** : ce qui a avancé, ce qui bloque, décisions prises,
   pour le lundi matin.

Chaque boucle se déclenche à la main, à l'heure dite, ou sur signal.

## Surface produit

    Aujourd hui     le brief du jour, ses sources, les approbations en attente
    Missions        lancer une mission, suivre son etat, lire son resultat
    Artefacts       tous les briefs, filtrables, partageables
    Connecteurs     ce qui est monte, son etat, ce que chaque agent peut utiliser
    Memoire         les faits et decisions de l'equipe, avec leur provenance
    Approbations    ce qui attend une decision humaine, et pourquoi
    Gouvernance     la page deja livree (roles, droits, audit)

## Contrats d'execution

Une mission ne "rend" jamais un succes sans preuve. Le service qui l'execute :

1. cree la session avec le prompt de rôle et les outils autorisés ;
2. attend la fin du tour et lit le message final, comme le fait déjà le module
   d'automatisation gouverné ;
3. capture le brief, ses sources et la consommation de jetons ;
4. marque `failed` avec la raison réelle si le tour a échoué, sans écrire de
   brief vide.

Les actions externes (envoyer un mail, publier, dépenser) ne sont jamais
exécutées par un agent : elles créent une `Approval`, que la gouvernance
autorise ou refuse selon les droits.

## Déploiement

Le serveur retient le modèle déjà éprouvé pour la gouvernance :

    Traefik existant     routeur navigateur -> oauth2-proxy -> Entra
                         routeur machine   -> API Duke (Bearer)
    duke-api             service node, aucune dependance runtime hors node
    etat                 /var/lib/dsh/duke (SQLite + artefacts)
    identite             email Entra ou jeton nominatif, jamais un nom declare

## Phases

1. **Socle** : paquet `duke/core`, modèle, stockage, exécution d'une mission
   réelle, API, page Aujourd hui et Missions, déploiement.
2. **Connecteurs et approbations** : vue des connecteurs montés, règles
   d'usage par agent, circuit d'approbation des actions externes.
3. **Automatisation** : briefings planifiés, notifications, mémoire alimentée
   par les missions, partage entre membres.
