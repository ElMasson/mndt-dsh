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

## Quotas et duree de vie

Une session de navigateur est ephemere par construction : elle meurt a la fin de
la capture. Deux limites empechent en plus deux demandes de se marcher dessus :

```
par personne      1 session a la fois ; la deuxieme repond 429
au total          2 sessions a la fois sur ce serveur ; la troisieme repond 429
duree de vie      celle du conteneur, 90 secondes maximum, puis suppression
```

Preuves du 27 octobre, en production :

```
deux demandes simultanees pour duke    une 200, une 429
trois personnes en meme temps          duke 200, smarion 200, contact 429
message du refus                       explicite, en clair, pas une erreur muette
```

## Navigation interactive

La machine ne se limite plus a une capture : elle ouvre une vraie session Chromium
qui dure jusqu a sa fermeture, pilotee par cinq operations.

```
start       demarre l instance de la personne, une seule a la fois
goto        ouvre une adresse et rend le titre et l URL reels
fill        saisit dans un champ
click       clique et attend la navigation
text        lit le texte de la page ou d un element
screenshot  rend une capture de l etat courant
stop        supprime l instance
```

Chaque operation est un appel HTTP au produit, qui verifie le droit
`workflows.write`, demande l instance au sidecar puis parle a l agent dans le
conteneur. Un lecteur recoit 403.

Preuve du 27 octobre, en production :

```
goto        https://httpbin.org/forms/post
fill        input[name=custname] = "Duke Analytics"
click       form button -> navigation vers https://httpbin.org/post
text        la reponse contient "custname": "Duke Analytics"
capture     browser-form-submitted.png, 1280x800
fermeture   aucun conteneur browser- restant
controles   0 echec
```

Le conteneur de session est en lecture seule, sans capacite, sans root, avec 1 Go
de memoire, 256 processus et un CPU au plus. La session vit jusqu a sa fermeture,
mais l hote ne tolere que deux sessions navigateur a la fois.

Ce qui manque encore cote experience : la carte de la page ne propose que la
capture unique. Les operations existent dans l API, pas encore dans l interface.
