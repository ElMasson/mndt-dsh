# Machine par personne

Une machine par personne veut dire, dans ce produit, un conteneur ephemere et
durci par session, cree a la demande depuis la page. Le navigateur y est seul,
sans outil de shell, sans gestionnaire de paquets, et rien ne survit a la session.

## Ce qui est en service

```
page          carte Machine : une adresse, un bouton, la capture affichee
API           GET /machines (sessions en cours), POST /machines/capture
droits        lancer une session demande workflows.write ; un lecteur recoit 403
sidecar       mndt-machines, seul a voir le socket Docker, sur le reseau front
image         mndt-browser:test, Debian slim + Chromium, utilisateur 10001
nettoyage     la session est supprimee a la sortie, capture reussie ou non
```

Preuves du 27 octobre, en production :

```
capture duke      ok, 67 241 octets, 25 secondes
capture lecteur   403
sessions          aucune apres la capture
disque            /data inchange, 72 %
controles         0 echec
```

## L'isolation, telle qu'elle est vraiment

```
user=10001:10001        non root
readonly=true           racine en lecture seule
capdrop=[ALL]           aucune capacite
security=[no-new-privileges]
memory=805306368        768 Mo
pids=128                128 processus au plus
nanocpus=1000000000     1 vCPU
```

Garanti : le code de la session ne peut pas ecrire hors de ses deux volumes
temporaires, ne peut pas elever ses privileges, ne voit pas les fichiers d une
autre personne, et disparait a la fin.

Pas garanti : c'est un conteneur, pas une machine virtuelle. Le noyau est partage
avec l hote. Pour une frontiere materielle, la trajectoire est Firecracker ou
Kata, sur une machine plus grande que ce serveur (4 vCPU, 8 Go, disque partage
avec Tellus).

## Ce qui manque encore

1. Une duree de vie par session et un quota par personne, pour que deux demandes
   simultanees ne se marchent pas dessus.
2. Le mode interactif : aujourd hui une capture, pas encore une navigation
   pilotee pas a pas par l agent.
3. La même chose en microVM quand la machine cible sera dimensionnee.

## Utilisation directe, hors produit

```
bash packages/host/mndt/deploy/sandbox/sandbox-browser.sh \
  duke@datanalysis.re https://example.com /tmp/duke.png
```

Captures de reference : `evidence/sandbox-browser-duke.png` et
`evidence/machine-capture-duke.png`.
