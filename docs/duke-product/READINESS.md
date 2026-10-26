# mndt, état de conformité

Ce document confronte chaque exigence du mandat à une preuve observable. Il dit
aussi ce qui reste ouvert, pour éviter qu'une démonstration partielle passe pour
un produit fini.

Date du relevé : 25 octobre 2026. Serveur : `51.159.164.138`.

## Exigences et preuves

| Exigence | Preuve | État |
|---|---|---|
| Reconstruit sur DSH, sans le code de ceo-dashboard | paquets `packages/host/mndt` et `packages/client/ui-mndt`, aucun import du projet de référence | tenu |
| Pages produit | page servie, captures `page-morning.png`, `page-final-stack.png` | tenu |
| Agents et missions exécutés par DSH | missions réelles `mis_a5e4b4fcf6494bc0b6d7`, `mis_11f510baef7f4e31b945`, briefs générés | tenu |
| Connecteurs MCP réels | Attio en lecture seule : trois entreprises lues avec domaines et identifiants ; écriture refusée par la passerelle de lecture | tenu |
| Automatisations planifiées | mission `scheduler` terminée seule, brief qui cite Attio et date sa dernière trace | tenu |
| Gouvernance RBAC centralisée | promotion `contact@` en operator : `canWrite` passe à vrai, retour en viewer : faux, sans redéploiement | tenu |
| SSO Entra devant le produit | certificat valide, redirection vers Microsoft, page de connexion Duke, amorçage cookie `dsh-auth` pour `mndt.duke-analytics.com`, page 200 avec ce cookie | partiel |
| Multi-utilisateurs | `duke@` peut écrire, `contact@` lit seulement, à travers la passerelle (`/mndt-api/state`) | tenu |
| Déploiement sur `51.159.164.138` | conteneurs `gateway`, `proxy`, `workbench` sur le réseau du front, publications limitées à la boucle locale | tenu |
| Builds et tests | compilateur hôte, bundle, build web et tests unitaires au vert ; `smoke.sh` 16 contrôles | tenu |
| Décisions humaines réelles | mission ayant demandé un accord send-email, brief sans envoi, décision humaine enregistrée avec motif, journal pproval.requested puis pproval.approved | tenu |
| Aucune surface qui prétend exécuter | missions interrompues marquées en échec avec leur motif, brief qui déclare l'absence de source, connecteur refusé plutôt que simulé | tenu |

## Ce qui reste ouvert

1. **Rotation de la clé de modèle.** Elle a servi aux tests et devrait être
   remplacée une fois la recette terminée.
2. **Jeton OAuth Attio.** Il vit dans `/data/mndt/live/mcp-auth` (700/600) et peut
   être révoqué côté Attio, ou supprimé du serveur, sans toucher au reste.
3. **Image reconstruite depuis la source.** Le correctif de hauteur de la carte
   d'accueil est figé dans l'image en service ; une reconstruction complète depuis
   la source est en cours pour que l'image redevienne reproductible sans passer par
   ce figeage.

Le SSO Entra n'est plus un point ouvert : Stéphane s'est connecté dans son
navigateur le 26 octobre, la page s'est affichée avec son identité, et la capture
est conservée (`page-authenticated-stephane.png`).

## Commandes de vérification

    bash /opt/mndt-front/smoke.sh

Le script vérifie la santé de l'API, les droits par personne, les deux connecteurs,
l'autorité centrale, la page avec et sans jeton, la redirection Entra, le
certificat public et l'automatisation déjà exécutée. Il sort en erreur au premier
manque.
