# Phase 3, mandat et journal

Decisions prises le 27 octobre 2026, avant tout code.

## Premier cas couvert

Direction, preparation de dossiers. Un cadre delegue a un agent la lecture des
courriers et de l'agenda, et la production de brouillons. Aucun envoi n'est
possible : l'agent prepare, l'humain decide.

## Ce qu'un mandat porte, des le depart

```
delegant        la personne qui donne le mandat
delegataire     la personne qui recoit le mandat
cas d usage     direction, preparation de dossiers
perimetre       connecteurs autorises, en lecture ; envoi interdit
echeance        date de fin, obligatoire
plafond         nombre de missions par jour et par personne
contre-signature owner ou admin, jamais le delegant lui-meme
etat            propose, actif, expire, retire
```

Un mandat ne prend effet qu'apres la contre-signature. Il peut etre retire a
tout moment, et il expire seul a sa date.

## Journal

Chaque action liee a un mandat laisse une ligne horodatee : auteur, mandat
utilise, action, cible, resultat, approbation humaine s'il y en a une.

Deux formats d'export, CSV et JSON. Lecture reservee au proprietaire et aux
admins. Pas de role auditeur supplementaire pour l'instant.

## Regles d'acces

```
proprietaire    voit tous les mandats, signe, retire
admin           voit et signe les mandats, ne peut pas signer le sien
operateur       recoit un mandat, agit dans son perimetre
lecteur         ne voit que ce qui est partage
```

Un mandat non contre-signe n'autorise rien. Un mandat expire ou retire n'autorise
plus rien, meme si la session de l'agent est encore ouverte.

## Ce que cela ajoute au produit

- Un onglet Mandats dans la page, avec creer, signer, retirer, exporter.
- Une verification a chaque mission et a chaque action : mandat actif, perimetre
  respecte, plafond non depasse, sinon refus explicite.
- Les refus sont ecrits dans le journal, avec le motif.

## Ce qui n'est pas dans cette phase

- Rattachement aux groupes Entra.
- Escalade et delais de rappel.
- Role auditeur dedie.
- Signature a deux niveaux.

Ces points viennent apres, une fois le mandat et le journal en production.
