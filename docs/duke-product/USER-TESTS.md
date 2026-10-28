# Tests utilisateurs, front end

Protocole pour Stephane (duke, owner) et Sara (smarion, operator).

Adresse : https://mndt.duke-analytics.com

Chacun se connecte avec son adresse. Pas de mot de passe a saisir ici.

Duree : 15 a 20 minutes par personne, a faire separement.

## Avant de commencer

- Utilisez Chrome ou Edge, plein ecran.
- Si la page affiche « Get started », cliquez, puis appuyez sur Echap pour fermer
  le choix d espace, puis cliquez « This morning ».
- Le brief du matin peut mettre quelques secondes a s afficher.

## Parcours de Stephane, owner

| Etape | Action | Attendu |
|---|---|---|
| 1 | Ouvrir la page | Le brief du matin, les cartes Missions, Approbations, Membres |
| 2 | Lancer « Visite guidee » | Les etapes defilent, la visite se ferme |
| 3 | Carte Mandats, bouton Actifs | Un mandat actif vers smarion, 3 missions par jour, signe par gouvernance |
| 4 | Bouton En attente | Un mandat propose, avec le bouton Contresigner visible |
| 5 | Contresigner le mandat en attente | Il passe actif, ou un message explique le refus |
| 6 | Journal CSV puis Journal JSON | Un fichier se telecharge, il contient des lignes horodatees |
| 7 | Carte Machine de travail, URL https://httpbin.org/forms/post, Ouvrir | La capture de la page apparait dans la carte |
| 8 | Fermer la session navigateur | La capture disparait |
| 9 | Carte Membres | Les roles sont visibles, vous pouvez ajouter quelqu un |
| 10 | Carte Planification | 06:30, bouton Enregistrer |

## Parcours de Sara, operator

| Etape | Action | Attendu |
|---|---|---|
| 1 | Ouvrir la page | La page s ouvre, le role operator est reconnu |
| 2 | Lancer « Visite guidee » | Les etapes defilent |
| 3 | Carte Mandats | Vous voyez les mandats qui vous concernent, filtres Tous, Actifs, En attente, Retires |
| 4 | Verifier l absence de commandes d administration | Pas de formulaire de creation, pas de Journal, pas de Contresigner, pas de bouton Retirer sur les mandats |
| 5 | Carte Machine de travail, URL https://example.com, Ouvrir | La capture apparait, vous pouvez fermer |
| 6 | Ouvrir le bureau, puis capturer | Un ecran s affiche, la capture revient dans la carte |
| 7 | Carte Connecteurs | Quatre connecteurs montes |
| 8 | Carte Jetons consommes | Vous voyez votre consommation, pas le detail de l equipe |

## Ce qui est normal aujourd hui

- Un mandat cree reste « En attente » tant qu un admin ne l a pas contresigne.
  La contresignature se fait avec le compte de gouvernance, pas depuis la page.
- Lancer une mission sous mandat n est pas encore dans la page, c est une
  commande API. Ne le cherchez pas.
- Le bureau affiche un ecran vide tant qu aucune adresse n est ouverte.
- Dans la carte navigateur, le champ selecteur sert a la fois pour Saisir et pour
  Cliquer et lire. Il faut le changer entre les deux actions.
- Les mandats de test precedents apparaissent en Retires, c est le filtre qui
  nettoie la vue.

## Ce que je veux recueillir

Pour chaque etape : clair, confus, ou bloquant. Notez surtout :

- les mots qui ne sont pas compris (mandat, delegataire, contre-signature) ;
- ce que vous cherchez et que vous ne trouvez pas ;
- les actions qui prennent trop de temps ;
- toute erreur affichee, avec une capture.
