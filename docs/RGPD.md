# RGPD & loyauté

## Ce qui est collecté, et pourquoi

| Donnée | Finalité | Base légale | Conservation |
|---|---|---|---|
| Prénom, nom, téléphone, e-mail | exécuter le rendez-vous, prévenir en cas de changement | contrat | jusqu'à la suppression du compte |
| Note libre (« barbe basse ») | exécution de la prestation | contrat |effacée à la demande |
| Adresse IP, user-agent, `visitor_id` | sécurité (rate limit), attribution, mesure d'audience | intérêt légitime | 13 mois, agrégé ensuite |
| Consentements marketing (e-mail / SMS / WhatsApp) | relances, campagnes | consentement, tracé ligne par ligne | jusqu'au retrait |
| Cookies | une seule chose : la session (`zyass_session`, httpOnly, Lax) | — | durée de session |
| Photos de la galerie | vitrine | consentement du modèle/propriétaire | à la demande |

Aucun cookie publicitaire, aucun traceur tiers, aucun pixel social : `connect-src 'self'` dans la CSP
interdit au navigateur d'appeler un autre domaine que le nôtre.

## Journal de consentement

`consents(customer_id, purpose, channel, granted, source, ts, ip, user_agent)` — une ligne par
décision, donc « montrer l'historique d'un oui » est possible. Les fins marketing sont désactivées
par défaut : une case pré-cochée serait un consentement nul, et en plus ça spamme.
`lib/inputs` + les routes écrivent le log ; `POST /api/public/unsubscribe` révoque immédiatement
(`consent_marketing_* = 0`) et est rappelé dans chaque message de prospection.

## Droits, côté client (espace « Mon espace », sans appel au salon)

- **Accès / portabilité** : `GET /api/client/export` → JSON complet (fiche, rendez-vous, points,
  cartes, avis, journal de consentement), téléchargeable en un clic.
- **Effacement** : `POST /api/client/delete {confirm:true}` → les rendez-vous à venir sont annulés
  (les autres clients sont prévenus), la fiche est **anonymisée** (nom `Supprimé`, téléphone, e-mail,
  notes, dates de naissance, consentements marketing remis à zéro, lignes `consents` marketing supprimées).
  L'anonymisation plutôt que la suppression physique garde le chiffre du salon juste — et une ligne
  `requests_deletion` + une entrée `audit_logs` prouvent le traitement.
- **Rectification** : `POST /api/client/profile`.
- Droits vérifiés par `tests/security.test.ts` (le numéro effacé ne permet plus de se connecter).

## Loyauté commerciale (les « zéro » du brief)

- **Zéro fausse rareté** : les compteurs de créneaux, le « bientôt complet », le « prochain créneau »
  viennent du calcul réel ; aucun compte à rebours artificiel, aucun créneau fantôme, aucun faux avis.
  Test : `tests/availability.test.ts` (compteur = liste) + smoke « ZERO FAUSSE RARETÉ ».
- **Zéro demande perdue** : un jour plein propose alternatives + waitlist + téléphone.
- **Avis** : positifs → on suggère Google ; négatifs → formulaire privé et rappel. Jamais de tri
  caché, jamais de publication sans accord explicite (`consentPublish`).
- **Contenu de démonstration** : les 60 avis et les photos générées pour la démo sont marqués
  `channel='demo'` / `visibility='private'` et listés dans `docs/CHECKLIST-MARQUE.md` comme à remplacer.
  Rien de fictif n'est présenté au public comme une preuve sociale.

## Mineurs et données sensibles

Le catalogue inclut des prestations enfants : la fiche ne stocke aucune donnée de santé, la note
libre est explicitement « ce que le client veut bien dire », et `cleanText()` borne la longueur.
Aucun suivi par empreinte fine (pas de fingerprinting, pas de stockage des mots de passe en clair,
pas de géolocalisation autre que l'adresse saisie).
