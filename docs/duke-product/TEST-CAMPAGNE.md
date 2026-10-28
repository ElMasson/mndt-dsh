# Campagne de tests, duke et smarion

Le 28 octobre 2026, en production, avant de continuer la phase 4.

Deux personnes : duke (owner) et smarion (operator). Chaque test est fait sur le
produit en service, pas sur une maquette.

## Acces

| Test | duke | smarion |
|---|---|---|
| page servie par la passerelle | 200 | 200 |
| role lu a chaque requete | owner | operator |
| peut agir | oui | oui |
| peut administrer | oui | non |
| peut partager le travail des autres | oui | non |

## Onboarding

Les deux pages affichent la visite guidee et les etapes d accueil. La carte est
visible pour les deux roles, avec le texte adapte : smarion ne voit pas les
commandes d administration.

## Segregation des personnes

| Test | resultat |
|---|---|
| mission privee de duke lue par smarion | 403 |
| mission privee de duke dans la liste de smarion | absente |
| note privee de duke visible dans la page de smarion | non |
| journal demande par smarion | 403 |
| boutons d administration des membres pour smarion | 0 |
| boutons d administration des membres pour duke | 1 |
| shell par personne | shell-duke-datanalysis-re, shell-smarion-datanalysis-re |
| etat par personne | home et web-token separes |
| consommation | chacune voit la sienne, le detail equipe est reserve aux admins |

## Connecteurs

Quatre connecteurs montes pour les deux : approvals, attio, office365,
workbench_facts. Le brief du matin du 28 octobre a ete produit a 06:30 par le
planificateur et termine en `done`, ce qui prouve l usage reel des connecteurs.

## Missions et delegation

| Test | resultat |
|---|---|
| mission privee creee par duke | done |
| lecture par duke | 200 |
| mandat duke vers smarion, une mission par jour | proposed puis active apres contresignature |
| mission de smarion sous mandat | done, porte le mandateId |
| deuxieme mission du jour | 403 daily limit reached: 1 of 1 missions today |
| retrait du mandat | 200, etat retired |

## Automatisation

```
fichier            /data/mndt/live/briefing-schedule.json
contenu            {"at":"06:30","lastFiredDate":"2026-10-28"}
mission du jour    2026-10-28T06:30:21.495Z, briefing, done, createdBy scheduler
```

Le planificateur a donc tire le brief du matin, sans intervention.

## Computer et browser use

| Test | duke | smarion |
|---|---|---|
| navigateur pilote, goto | ok, Example Domain | ok, Example Domain |
| navigateur, capture | ok | ok |
| navigateur depuis la carte de la page | deja prouve | ok, capture affichee |
| bureau, open | ok | ok |
| bureau, capture | ok, 104 324 caracteres | ok, 104 324 caracteres |
| fermeture des sessions | ok | ok |

## Ce qui a echoue

Aucun test en echec sur cette campagne.

## Points a noter

- Les mandats de test s accumulent dans la carte, tous en `retired`. Un filtre
  par etat serait plus lisible.
- smarion peut proposer un mandat, parce qu elle peut agir. C est conforme a la
  regle actuelle, mais si vous voulez reserver la proposition aux admins, c est
  un changement d une ligne.
- Le bureau est prouve par l API pour les deux. Le pilotage du bureau depuis la
  carte n a ete joue que pour duke, la carte etant la meme pour les deux.

## Preuves

- `evidence/test-duke.png` : page de duke, commandes d administration presentes.
- `evidence/test-sara.png` : page de smarion, navigateur ouvert dans la carte,
  aucun bouton de journal ni d administration des membres.
- `evidence/mandates-card.png` : carte des mandats.
