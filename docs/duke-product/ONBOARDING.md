# mndt, prendre en main et travailler en équipe

Ce document décrit ce que la personne voit en arrivant, les quatre gestes qui
mettent le produit en main, et la façon dont plusieurs personnes travaillent
ensemble sans se marcher dessus.

## Ce que vous voyez en arrivant

La page du matin, en une lecture :

- ce qui attend une décision humaine ;
- les missions en cours et terminées ;
- les briefs produits ;
- les connecteurs montés ;
- ce que l'équipe a choisi de retenir.

En haut à droite, deux pastilles disent qui vous êtes et ce que vous pouvez
faire : `duke@datanalysis.re` et `May run missions`, ou `Read only` pour une
personne en lecture.

## Les quatre premiers gestes

La carte « Premiers pas » les affiche avec leur état réel, coché quand c'est fait.

1. **Votre identité et vos droits.** Viennent du SSO Entra et de l'autorité
   centrale, jamais d'un choix dans la page.
2. **Lancer une mission.** Le bouton lance le briefing du matin. La mission
   apparaît dans la liste, puis le brief dans la colonne de droite.
3. **Trancher une décision.** Une mission peut demander un accord (envoi,
   publication, dépense, suppression). Elle ne peut pas se l'accorder. La
   décision apparaît dans la première carte et attend une personne.
4. **Vérifier les connecteurs.** La carte « Connectors » liste ce qui est monté
   et actif. Attio est monté en lecture seule, écriture refusée avant le serveur.

La carte se masque, et le masquage est mémorisé dans le navigateur.

## Travailler en équipe

### Qui peut quoi

Les droits sont lus à chaque requête auprès de l'autorité centrale.

```
viewer     lit tout, ne lance rien, ne tranche rien
operator   lance des missions, tranche les décisions
admin      gère les membres et les connecteurs
owner      tout, y compris les décisions structurantes
```

Une personne en lecture reçoit un refus explicite (403) si elle tente de lancer
une mission ou de trancher une décision. Ce n'est pas un bouton grisé qui
prétend, c'est le serveur qui refuse.

### Ajouter quelqu'un

Sur le serveur, une seule commande :

```
/opt/governance/add-member.sh nouvelle.personne@duke-analytics.com viewer
```

Le rôle peut être `viewer`, `operator`, `admin` ou `owner`. Aucun redéploiement
n'est nécessaire : la personne se connecte avec son compte Duke et ses droits
sont déjà les bons.

### Ce qui est partagé

- **Missions et briefs** : visibles par toute l'équipe, chacun porte le nom de
  son auteur.
- **Décisions** : une seule file, une personne tranche, la décision garde le nom
  du décideur et son motif.
- **Notes et mémoire** : partagées, avec leur portée (`team`, `user`, `mission`).
- **Connecteurs** : montés une fois pour le produit, pas par personne. Le jeton
  Attio vit sur le serveur, protégé, et peut être révoqué sans toucher au reste.

### Ce qui n'est pas partagé

La session du shell est tenue par la passerelle pour une identité donnée. Les
actions de produit sont attribuées par personne via `/mndt-api`. Les fonctions de
shell qui ne passent pas par le produit restent, elles, liées au workbench
lui-même : c'est une limite connue, écrite dans les documents de preuve.

## Vérifier que tout est réel

```
bash /opt/mndt-front/smoke.sh
```

Le script vérifie la santé, les droits par personne, les connecteurs, la page
avec et sans jeton, la redirection Entra, le certificat public et
l'automatisation déjà exécutée. Il sort en erreur au premier manque.

Pour rejouer la chaîne de connexion sans toucher à Entra :

```
bash packages/host/mndt/deploy/sso-test/rehearse.sh
```

La recette crée son fournisseur OIDC, son proxy, vérifie trois faits, puis
supprime tout ce qu'elle a créé.

## Ce qui se passe tout seul

Chaque matin, une mission planifiée produit un briefing. Elle déclare ce qu'elle
a réellement lu et refuse d'inventer une rubrique sans source. Si elle est
interrompue par un redémarrage, elle ressort en échec avec ce motif plutôt que de
rester en cours pour toujours.
