# Session de test utilisateurs, v0.9

Date visée : vendredi 30 octobre 2026, après-midi. Durée : 45 minutes par personne,
3 personnes, en présentiel ou visio avec partage d écran.

Objet : vérifier que l espace de collaboration est compris sans explication, que les
mandats et les approbations sont lisibles, et que le lancement d une mission depuis un
canal est naturel.

## 0. Accès pour les testeurs

Adresse : https://mndt.duke-analytics.com, dans Chrome ou Edge, plein écran. La connexion
se fait avec l adresse professionnelle, sans mot de passe supplémentaire.

Si la page affiche « Get started », cliquer, puis appuyer sur Échap, puis cliquer
« This morning ». Le premier chargement peut prendre quinze à trente secondes.

## 1. Périmètre annoncé aux testeurs

Dans le périmètre :

- lire le fil d équipe, ouvrir un brief ;
- parcourir les canaux de mandat et lire le panneau de contexte ;
- lancer une mission depuis un canal et suivre son état ;
- approuver ou refuser une demande avec un motif ;
- comprendre qui peut décider et qui ne peut pas.

Hors périmètre, à annoncer dès l accueil : recherche globale, vue Activité,
notifications, non-lus, messagerie directe, application mobile, édition de post.

## 2. Comptes et rôles préparés

| Personne | Rôle | Ce qu elle doit pouvoir faire |
|---|---|---|
| duke@datanalysis.re | owner | tout, décider les approbations des autres |
| gouvernance@datanalysis.re | admin | décider les approbations, ne pas voir les missions privées des autres |
| smarion@datanalysis.re | operator | lire, lancer ses missions, ne pas décider une approbation |
| contact@datanalysis.re | viewer | lecture seule, aucun bouton de décision |

## 3. Préparation, côté animateur, avant la session

1. Ne déployer aucune image pendant la session.
2. Ouvrir une page avec chaque compte pour créer les shells à l avance. Vérifier que les
   quatre pages affichent l espace en moins de 20 secondes.
3. Vérifier l état de démonstration : 2 mandats actifs, 1 mission terminée avec brief,
   2 approbations en attente dont une demandée par duke et une par gouvernance.
4. Vérifier que la boîte de réception n est pas modifiée par la session : les missions de
   test ne doivent rien envoyer.
5. Préparer l enregistrement d écran et la grille d observation imprimée.

## 4. Déroulé

| Temps | Étape |
|---|---|
| 0 à 5 min | Accueil, périmètre, consentement à l enregistrement |
| 5 à 10 min | Scénario 1, découverte libre, aucune aide |
| 10 à 30 min | Scénarios 2 à 6, une consigne à la fois |
| 30 à 38 min | Scénarios 7 et 8, décision impossible et ségrégation |
| 38 à 45 min | Débrief, questions, mini questionnaire |

Règle d or : l animateur ne montre pas. Il lit la consigne, laisse faire, note l hésitation
et le temps. Il n intervient qu après 60 secondes de blocage complet.

## 5. Scénarios

### Scénario 1, découverte, 3 minutes

Consigne : « Ouvrez cette page. Regardez-la 30 secondes. Dites-moi ce que vous comprenez
de l endroit où vous êtes. »

Observer : nomme-t-il les canaux, les mandats, les approbations, les personnes et les agents ?
Demande-t-il où sont les messages ? Croit-il que c est une messagerie ?

Réussite : il cite au moins deux des trois entités, mandat, mission, approbation.

### Scénario 2, lire le fil d équipe, 3 minutes

Consigne : « Trouvez la dernière mission terminée et dites-moi ce qu elle a produit. »

Observer : repère-t-il la carte de mission, le bouton Ouvrir le brief, l auteur, l état ?
Lit-il le brief déplié sans se perdre ?

Réussite : il ouvre le brief et résume une phrase du contenu.

### Scénario 3, comprendre un mandat, 4 minutes

Consigne : « Ouvrez le canal Reporting marketing hebdomadaire. Dites-moi qui agit pour qui,
jusqu à quand, et ce qui est autorisé. »

Observer : lit-il le panneau de droite ? Comprend-il la limite de missions par jour et les
connecteurs autorisés ? Le nom du canal suffit-il ou faut-il ouvrir le contexte ?

Réussite : il cite le mandant, le délégataire, l échéance et une limite.

### Scénario 4, lancer une mission, 6 minutes

Consigne : « Lancez une mission courte depuis ce canal : demandez un point sur les
connecteurs, sans envoi de courriel. Suivez son état, puis ouvrez le résultat. »

Observer : trouve-t-il le composeur, choisit-il le bon type, comprend-il que la mission
démarre en privé, remarque-t-il le rafraîchissement du fil, attend-il correctement ?

Réussite : mission lancée, état vu, brief ouvert, aucun envoi réel.

### Scénario 5, approuver, 4 minutes

Consigne, avec le compte duke : « Une demande de gouvernance attend. Décidez-la, puis
expliquez ce qui vient de se passer. »

Observer : comprend-il qu il a le droit de décider ? Cherche-t-il la décision dans une autre
page ? La ligne d historique est-elle remarquée ?

Réussite : décision prise, compteur décrémenté, il explique que la décision est tracée.

### Scénario 6, la règle du demandeur, 4 minutes

Consigne : « Regardez la demande que vous avez vous-même créée. Pouvez-vous la décider ?
Expliquez pourquoi. »

Observer : identifie-t-il la carte demandée par lui-même ? Comprend-il que l autre humain
doit décider ? Le message d explication est-il lu ?

Réussite : il nomme la règle « le demandeur ne décide pas sa propre demande ».

### Scénario 7, décider en tant qu opérateur, 4 minutes

Consigne, avec le compte smarion : « Essayez de décider une demande. »

Observer : voit-il les boutons désactivés, comprend-il pourquoi ? Le libellé « Seul un owner
ou un admin peut décider » est-il suffisant ?

Réussite : il explique la limite sans se sentir bloqué par un bug.

### Scénario 8, ségrégation, 3 minutes

Consigne, avec smarion : « Voyez-vous le brief de la mission de duke ? Et gouvernance voit-il
vos missions privées ? »

Observer : comprend-il la notion de mission privée contre mission partagée à l équipe ?

Réussite : il constate que les briefs privés des autres ne sont pas visibles.

## 6. Grille d observation

Pour chaque scénario, noter :

| Colonne | Valeur |
|---|---|
| temps | secondes jusqu à la première action correcte |
| hésitations | nombre et moment |
| mots employés | ses mots, pas les nôtres |
| attente manquante | ce qu il a cherché et qui n existe pas |
| erreur | action fausse, avec description |
| réussite | oui, non, avec aide |

Noter aussi trois phrases verbatim par personne, sans les corriger.

## 7. Questions de fin

1. En un mot, cet espace sert à quoi ?
2. Quelle différence entre un canal de mandat et le canal d équipe ?
3. Qu est-ce qui manque le plus ?
4. Auriez-vous confiance pour laisser un agent travailler ici ? Pourquoi ?
5. Sur une échelle de 1 à 5, à quel point est-ce facile à prendre en main ?

## 8. Mini questionnaire, 5 items, échelle 1 à 5

1. Je comprends ce que je vois sans explication.
2. Je sais où lancer une mission.
3. Je sais où décider une approbation.
4. Je comprends qui peut faire quoi.
5. Je retrouverais cet espace si je revenais demain.

## 9. Critères de succès de la session

- 80 pour cent des scénarios réussis sans aide.
- Au plus trois frictions majeures, avec une correction priorisée pour chacune.
- Au moins deux testeurs sur trois décrivent correctement le lien mandat, mission,
  approbation.
- Aucun testeur ne conclut que c est une messagerie.

## 10. Après la session

Consigner les résultats dans ce fichier, section Résultats, avec les verbatim et les
frictions classées : compréhension, navigation, confiance, manque fonctionnel. Chaque
friction devient soit une correction de la v1, soit une réponse explicite dans le guide
d utilisation.

## Résultats

À remplir après la session du 30 octobre.
