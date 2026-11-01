# Agents autonomes et automatisations planifiees

Ce document identifie ce qui peut tourner sans personne devant l ecran, ce qui existe deja,
et ce qu il faut construire pour le porter proprement. Il porte sur le produit mndt, pas sur
une conversation : une automatisation est une mission planifiee, avec un prompt fixe, un
calendrier, et un resultat depose dans le fil.

## 1. Ce qui existe deja dans le produit

- Un **agent planificateur** cree un briefing chaque matin. Il est code en dur dans
  `packages/host/mndt/src/gateway.ts` : heure dans `briefing-schedule.json`, une seule
  execution a la fois, mission de type `briefing` avec `createdBy: scheduler`.
- Un **runner de mission** (`packages/host/mndt/src/runner.ts`) qui execute une mission dans
  une session DSH, avec les connecteurs montes et le modele par defaut de la session.
- Des **types de mission** deja connus : `briefing`, `weekly-synthesis`, `account-review`,
  `custom`.
- Une **API de planification** reduite a une heure unique : `GET /schedule` et
  `POST /schedule` lisent et ecrivent ce fichier.
- Un **journal**, des **approbations**, et des **mandats** qui limitent les connecteurs
  autorises, les types de mission et le nombre quotidien.

Tout ce qui suit s appuie sur ces briques, sans nouvelle infrastructure.

## 2. Modele d execution, et la question du modele de langage

Une automatisation est une mission sans humain : meme runner, memes connecteurs, meme
politique d approbation. Aucun chat, aucun fil de discussion, aucune reponse attendue.

Le modele est celui de la session : `runner.ts` lit `agentDefaultModel.currentSelection()` et
transmet le couple fournisseur et modele a la mission. Changer de modele ne demande donc pas
de code dans mndt, seulement de changer la selection par defaut du profil.

**Constat verifie sur le serveur de production le 1er novembre, a propos du vLLM Qwen 3.8 :**

- aucune trace de vLLM, de Qwen ou d un point de terminaison compatible OpenAI sur le
  serveur : pas de processus en ecoute sur 8000, 8001 ou 11434, aucune variable de ce type
  dans le conteneur workbench, aucun modele de ce nom dans le profil ;
- le seul fournisseur configure est DeepSeek, par cle d API
  (`DEEPSEEK_API_KEY` dans le workbench, journal `llm-deepseek` cote home) ;
- la machine n a pas de GPU (`nvidia-smi` absent), 4 vCPU, 8 Go de memoire dont environ 2 Go
  disponibles, et 3,9 Go de disque libre.

Conclusion honnete : faire tourner Qwen 3.8 en local sur ce serveur n est pas realiste
aujourd hui, vLLM exige un GPU et il n y en a pas, et l espace disque ne permet pas non plus
une pile CPU confortable. Deux options propres, sans coder dans mndt :

1. **Qwen servi ailleurs** (vLLM sur une machine a GPU, ou un fournisseur compatible
   OpenAI), et le profil du serveur pointe vers ce point de terminaison. Le runner suivra
   automatiquement la selection par defaut.
2. **Rester sur DeepSeek** pour les automatisations, qui est deja connecte et facture a la
   cle existante.

Dans les deux cas, l architecture des automatisations ne change pas. C est un point a
arbitrer cote infrastructure, pas cote produit.

## 3. Candidats d automatisation, par valeur

| # | Automatisation | Frequence | Entrees | Sortie | Risque | Faisable maintenant |
|---|---|---|---|---|---|---|
| 1 | Briefing du matin | chaque jour, 07 h 30 | agenda, courriers, Attio, échéances | brief dans le canal equipe | lecture seule | oui, existe, a generaliser |
| 2 | Synthese hebdomadaire | lundi, 08 h 00 | missions de la semaine, journal | brief de synthese | lecture seule | oui, type `weekly-synthesis` deja reconnu |
| 3 | Relance des approbations en attente | chaque jour, 09 h 00 | approbations non decidees | liste des demandes qui dorment, dans le fil | lecture seule, aucun mail | oui |
| 4 | Echeance de mandat a J-30 et J-7 | chaque jour, 08 h 30 | mandats et leurs dates | alerte dans le canal du mandat | lecture seule | oui |
| 5 | Revue de compte client | a la demande, planifiee | Attio, agenda, courriers | brief de revue | lecture seule | oui, type `account-review` deja reconnu |
| 6 | Triage des courriers sans reponse | chaque jour, 12 h 00 | boite lecture seule | liste priorisee, sans repondre | lecture seule | oui, connecteur office365 en lecture |
| 7 | Rapport d usage et de qualite | chaque vendredi, 17 h 00 | usage, echecs de mission | bilan chiffre | lecture seule | oui, API `/usage` existe |
| 8 | Controle de sante et sauvegarde | chaque nuit, 03 h 00 | `/health`, fichiers d etat | copie + verdict, sans LLM | ecriture locale | oui, script systeme, pas une mission |
| 9 | Detection de derive de quota | chaque heure | missions du jour par personne | alerte si depassement | lecture seule | oui, si le quota est applique |
| 10 | Preparation de reunion | la veille a 18 h 00 | agenda du lendemain | ordre du jour propose | lecture seule | oui |

Regle commune : une automatisation ne decide rien et n envoie rien. Si une action sensible
est necessaire, elle cree une approbation, et un humain decide. Aucun mail ne part sans
validation explicite, conformement a la regle du poste.

## 4. Ce qu il faut construire

### 4.1 Registre des automatisations

Un fichier `automations.json` a cote de l etat, avec une liste d objets :

- `id`, `name`, `enabled` ;
- `kind` (type de mission) et `prompt` (texte fixe, relu a chaque execution) ;
- `at` (heure locale), `days` (jours de la semaine), ou `everyMinutes` pour les essais ;
- `lastFiredDate`, `lastMissionId`, `lastOutcome` ;
- `createdBy` (qui a cree l automatisation), et `mandateId` si elle est rattachee a un
  mandat.

Le gateway lit ce fichier une fois par minute, comme il lit deja l heure du briefing, et
lance les executions dues. Une execution a la fois par automatisation. Le fichier survit aux
redemarrages.

### 4.2 API et interface

- `GET /automations`, `POST /automations` (creation et mise a jour), `POST /automations/:id/run`
  (executer maintenant), `POST /automations/:id/enabled` (activer ou suspendre).
- Dans la page : une entree `Automatisations` dans le groupe systeme, qui liste les
  automatisations, leur prochaine execution, leur dernier resultat, avec trois actions :
  executer maintenant, suspendre, modifier l heure. Pas de conversation, un tableau de
  bord.

### 4.3 Garde-fous

- Une automatisation ne peut pas choisir un connecteur hors du mandat auquel elle est
  rattachee.
- Le quota quotidien du mandat s applique aussi aux executions planifiees.
- Une automatisation dont le dernier resultat est une erreur est suspendue apres trois echecs
  consecutifs, avec une raison visible dans l interface.
- Toute action sensible demandee par une automatisation passe par une approbation.

## 5. Ordre de livraison propose

1. Registre, API, execution planifiee generalisee, journalisation du resultat.
2. Interface Automatisations avec activer, suspendre, executer maintenant.
3. Trois automatisations par defaut : briefing, relance des approbations, echeances de
   mandat.
4. Synthese hebdomadaire et revue de compte, qui reutilisent les types deja reconnus.
5. Rapport d usage et controle de sante, sans LLM, en scripts systeme.
6. Le reste selon les besoins observes.

Le point 1 remplace le minuteur code en dur du briefing : une seule mecanique, un seul
fichier, plus de cas particulier.
