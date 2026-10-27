# Phase 2, revue finale

Objectif : donner a chaque personne une machine isolee pour browser use et
computer use, brancher Office365, cloisonner le shell par personne, et finir les
chantiers restants, chaque point verifiable en production.

Date de la revue : 27 octobre 2026, production `mndt.duke-analytics.com`.

## Ce qui est prouve

| Point | Preuve | Etat |
|---|---|---|
| Machine isolee, browser use | `goto`, `fill`, `click`, `text`, `screenshot` sur httpbin, formulaire envoye avec `custname` | fait |
| Machine isolee, computer use | bureau Xvfb, souris `click` 200,28 et clavier `type` "Duke au bureau", formulaire envoye | fait |
| Quotas | deux demandes pour une personne, une 200 une 429 ; trois personnes, deux 200 une 429 | fait |
| Office365 courriers | mission `mis_257f0e481daf4937aabc` : deux courriers reels lus dans la boite duke, sujets et expediteurs | fait |
| Office365 agenda | mission `mis_600bad4fbcd848d19c08` : rendez-vous reels des 28 et 29 octobre, dont Morning roadshow DUKE et DAILY SPRINT | fait |
| Shell par personne | `duke` et `smarion` a 200, deux conteneurs, deux `/state`, deux jetons | fait |
| Planification depuis la page | 06:30 lu et reecrit, lecteur refuse 403, survit au redemarrage | fait |
| Onboarding guide | sept etapes, visite guidee dans la page, etat coche | fait |
| Image propre | construite depuis le commit 21106d7, 7 portes sur 7, en service | fait |
| Carte navigateur et bureau | ouvrir, saisir, cliquer, lire, capture, fermer, dans la page | fait |
| Tests | 35 tests passent, 0 en echec | fait |

## Ce qui est limite, dit explicitement

- **Rotation des secrets** : reportee par le decideur le 27 octobre. Les cles et
  jetons actuels restent en place. Ce n'est pas fait, c'est assume.
- **Isolation du shell** : noyau partage, racine inscriptible parce que le chargeur
  natif Node refuse de demarrer sans ecrire. Les gardes sont `--cap-drop ALL`,
  `--security-opt no-new-privileges`, limites de processus, de memoire et de CPU,
  plus un `/state` dedie par personne.
- **Isolation de la machine** : conteneur durci, pas de microVM. L'hote a quatre
  vCPU et 8 Go, `/dev/kvm` existe mais trop petit pour Firecracker. La trajectoire
  reste le microVM.
- **Bureau** : pas de VNC depuis le navigateur de la personne, pas d'audio, une
  seule application installee en pratique, Chromium.
- **Office365** : lecture seulement, `Mail.Read` et `Calendars.Read`. Aucun outil
  d'envoi n'est expose, donc aucun courrier ne peut partir par le produit.
- **Perimetre des personnes** : routage par personne prouve pour `duke` et
  `smarion`. La troisieme personne, `contact`, a le role lecteur et se voit refuser
  les actions.
- **Delegation d'entreprise** : roles, gardes d'action, approbations, partage et
  trace existent. Le mandat avec perimetre, plafond et echeance, et le journal
  exportable des approbations, restent a construire.

## Etat

Phase 2 atteinte hors rotation des secrets, qui reste une decision du decideur.
