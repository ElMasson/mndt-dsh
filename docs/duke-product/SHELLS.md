# Un shell par personne

Chaque personne qui se connecte obtient son propre processus DSH, avec son propre
repertoire d etat. Les sessions, les fichiers de travail et le jeton de page d une
personne ne sont pas visibles depuis l instance d une autre.

## Comment cela fonctionne

```
navigateur -> oauth2-proxy -> passerelle -> shell-<identite>:3111
                                 |
                                 +-> /mndt-api/* -> workbench central (API produit)

le sidecar cree le shell de la personne au premier acces, puis le laisse tourner
```

Composants :

```
passerelle    lit x-forwarded-email, demande l instance au sidecar, echange le
              jeton de lancement cote serveur, garde le cookie du shell et rend
              au navigateur un cookie de session a elle
sidecar       cree le conteneur shell-<identite>, monte /data/mndt/shells/<identite>
              comme /state, et rend le jeton de cette instance
instance      image workbench, DSH_HOME=/state/home, aucun port d API produit :
              la page passe par la passerelle pour l API et garde le reste chez elle
```

## Preuves du 27 octobre, en production

```
duke        page 200, 38 845 octets, propre instance shell-duke-datanalysis-re
smarion     page 200, 38 845 octets, propre instance shell-smarion-datanalysis-re
identite    /mndt-api/state rendue par la passerelle : smarion@datanalysis.re,
            role operator, donc l API centrale voit bien la bonne personne
sessions    partagee : 2 elements ; duke : 0 ; smarion : 0
memoire     166 Mo et 153 Mo pour deux instances, limite 768 Mo chacune
jeton       chaque instance publie le sien, jamais montre au navigateur
controles   0 echec
```

## Ce que cela garantit, et ce que cela ne garantit pas

Garanti : une personne ne peut pas lire ni lister les sessions d une autre depuis
le produit, parce que ce sont deux processus et deux repertoires differents. Une
compromission du shell d une personne ne donne pas acces au repertoire d une autre.

Pas garanti : les instances partagent le noyau de l hote, comme les conteneurs du
reste de la pile. Le shell n a pas de racine en lecture seule : le chargeur natif
de Node refuse de demarrer sans ecrire dans son arborescence. La limitation est
documentee, pas contournee en silence.

## Exploitation

```
compose        service machines : socket Docker, /data/mndt/shells, /seed/profiles
               passerelle : env_file machines.env, donc jeton et adresse du sidecar
nettoyage      un conteneur shell par personne, supprimable sans perte produit :
               docker rm -f shell-<identite> ; il sera recree au prochain acces
rotation       au redemarrage d une instance, la passerelle retente une fois avec
               le nouveau jeton avant de rendre une erreur
```

Limites restantes :

1. Un shell par personne consomme environ 150 a 200 Mo ; au-dela d une dizaine de
   personnes simultanees, il faudra une machine plus grande.
2. La carte « machine de travail » et le shell sont deux mecanismes distincts : le
   premier capture une page, le second donne l espace de travail.
3. Le mode microVM reste la trajectoire pour une frontiere materielle.
