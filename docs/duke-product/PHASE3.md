# Phase 3, mise en service du mandat

Le 28 octobre 2026, en production `mndt.duke-analytics.com`.

## Ce qui est en service

```
creation           un delegant propose un mandat a une personne
perimetre          connecteurs en lecture et types de mission autorises
echeance           date de fin obligatoire
plafond            nombre de missions par jour
contre-signature   owner ou admin, jamais le delegant
retrait            par le delegant, un owner ou un admin
journal            evenements horodates, export CSV et JSON
acces              proprietaire et admins pour le journal, chacun voit ses mandats
```

La page a une carte Mandats : liste, creation, contresignature, retrait,
et deux boutons d'export du journal.

## Preuve, mandat `mnd_2a2537e15ce742ad9aa5`

Scenario : duke propose un mandat a smarion, une mission par jour, type `custom`,
connecteurs `office365` et `attio`, jusqu'au 30 novembre 2026.

| Regle | Appel | Resultat |
|---|---|---|
| creation | POST /mandates | 201, etat `proposed` |
| le delegant ne signe pas son mandat | duke POST sign | 403 `the delegant cannot countersign their own mandate` |
| contresignature | gouvernance POST sign | 200, etat `active`, signe par gouvernance |
| hors perimetre | smarion mission `briefing` | 403 `this mandate does not allow a briefing mission` |
| dans le perimetre | smarion mission `custom` | 201, `done`, mission porte le mandateId |
| plafond | deuxieme mission `custom` | 403 `daily limit reached: 1 of 1 missions today` |
| retrait | duke POST retire | 200, etat `retired` |
| apres retrait | smarion mission `custom` | 403 `the mandate is retired` |
| connecteur absent | mandat sans attio, mission account-review | 403 `this mandate does not allow the attio connector needed by a account-review mission` |
| connecteur present | mandat avec office365 et attio, mission account-review | 201, `done` |
| journal, proprietaire | GET /journal JSON et CSV | 200, 91 lignes JSON, 92 lignes CSV |
| journal, lecteur | contact GET /journal | 403 |
| visibilite | smarion /state | 1 mandat ; contact 0 |

Les refus sont ecrits dans le journal avec leur motif, par exemple
`mission.refused … this mandate does not allow a briefing mission`.

## Compte de gouvernance

La contre-signature exige un owner ou un admin autre que le delegant, et il n'y
avait qu'un owner. Un compte `gouvernance@datanalysis.re` a ete ajoute en admin
par le proprietaire, sans boite mail, uniquement pour la contresignature. C'est
une decision d'exploitation, pas un contournement : elle est dans la table des
membres et dans le journal.

## Limites, dites explicitement

- **Perimetre de connecteurs applique a l admission, pas outil par outil.**
  Le produit verifie que le mandat ouvre les connecteurs dont le type de mission
  a besoin, et refuse sinon. Bloquer un appel d outil precis a l interieur d une
  mission acceptee demande un filtrage des outils MCP par mission dans DSH, qui
  reste a faire.
- **Delegation de personne a personne.** L'agent n'est pas une identite separee
  dans le produit : le delegataire est une personne, et les missions qu'elle
  lance portent le mandat. Un agent nomme viendra apres.
- **Journal plafonne a 500 evenements** par le produit, donc l'export porte sur
  les 500 dernieres lignes. L'archivage long reste a faire.
- **Pas d'escalade ni de rappel** avant echeance, comme prevu dans la spec.
- **Pas de rattachement aux groupes Entra** : les roles restent dans la table des
  membres du produit.

## Fichiers

- `packages/host/mndt/src/mandates.ts` : les regles, pures et testees.
- `packages/host/mndt/src/core/service.ts` et `core/types.ts` : mandat persiste.
- `packages/host/mndt/src/api.ts` : routes, application des regles, journal.
- `packages/host/mndt/tests/mandates.host.spec.ts` : 8 tests, 43 au total.
- `packages/client/ui-mndt/src/client/MndtPage.tsx` : carte Mandats.
