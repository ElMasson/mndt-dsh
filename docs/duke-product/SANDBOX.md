# Machine par personne

Une machine par personne veut dire, dans ce produit, un conteneur ephemere et
durci par session. Le navigateur y est seul, sans outil de shell, sans gestionnaire
de paquets, etrien ne survit a la session.

## Ce qui a ete construit et prouve

```
image          mndt-browser:test, Debian slim + Chromium, utilisateur 10001
entree         une seule capture d URL, ecrite la ou l appelant la demande
session        nommee par identite et par seconde, supprimee a la sortie
preuve         deux sessions distinctes (duke, sara), deux PNG de 67 241 octets,
               aucun conteneur restant apres les captures
```

Proprietes verifiees par `docker inspect` pendant une session :

```
user=10001:10001        non root
readonly=true           racine en lecture seule
capdrop=[ALL]           aucune capacite
security=[no-new-privileges]
memory=805306368        768 Mo
pids=128                128 processus au plus
nanocpus=1000000000     1 vCPU
```

## Ce que cela garantit, et ce que cela ne garantit pas

Garanti : le code qui tourne dans la session ne peut pas ecrire hors de ses deux
volumes temporaires, ne peut pas elever ses privileges, ne peut pas voir les
fichiers d une autre personne, et disparait a la fin de la session.

Pas garanti : c'est un conteneur, pas une machine virtuelle. Le noyau est partage
avec l hote. Pour une frontiere materielle, la trajectoire est Firecracker ou
Kata, sur une machine plus grande que ce serveur (4 vCPU, 8 Go, 3,8 Go de disque).

## Etat actuel et suite

Aujourd hui la session se lance par un script d exploitation :

```
bash packages/host/mndt/deploy/sandbox/sandbox-browser.sh \
  duke@datanalysis.re https://example.com /tmp/duke.png
```

Reste a faire pour que ce soit une fonctionnalite du produit :

1. une route `/machines` qui cree, liste et arrete une session par identite ;
2. une carte dans la page qui montre la session en cours et sa derniere capture ;
3. une duree de vie et un quota par personne, pour que deux sessions ne se
   marchent pas dessus.

La capture de reference : `docs/duke-product/evidence/sandbox-browser-duke.png`.
