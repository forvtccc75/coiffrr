# Règles métier (le règlement du salon, écrit en dur — et modifiable par le patron)

Valeurs de départ, réglables dans `Réglages` (table `settings`/`locations.policy_json`) et testées
dans `tests/availability.test.ts` / `tests/booking.test.ts`.

## Planning

| Règle | Valeur | Pourquoi |
|---|---|---|
| Pas de grille | 10 min | laisser le client choisir précisément, sans inonder |
| Pas d’affichage client | 15–30 min (`presentStepFor`) | une liste lisible ; le créneau affiché reste réservable |
| Préavis en ligne | 20 min | le temps de prévenir le barbier |
| Horizon de réservation | 21 jours | au-delà, l’agenda bouge trop ; la waitlist prend le relais |
| Préparation / nettoyage | 3 min / 5 min par prestation | occupent le barbier, donc bloquent le créneau |
| RDV actifs max / client | 3 | empêche le bourrage |
| Derrière le dernier client | fermeture − durée − nettoyage | pas de trou de 4 min avant de fermer |

## Temps, fuseau, jours de bascule

- Toutes les heures « métier » sont des **minutes locales du fuseau du salon** (`TIMEZONE`,
  Europe/Paris ici) et sont stockées en epoch ms UTC. Aucun calcul de date en SQL : le serveur convertit
  (`lib/time.ts`), ce qui garde les index exploitables et le comportement identique sur SQLite et Postgres.
- `atLocal(day, minute)` convertit « jour + heure murale » en instant **en recalculant le décalage à
  partir de l'instant trouvé**, et non par une addition naïve depuis minuit : le 29/03 et le 25/10, une
  addition directe décalait l'ouverture d'une heure (09:30 affiché 08:30 ou 10:30). Une minute inexistante
  (heure sautée) retombe sur le dernier instant valable avant la bascule — jamais sur `NaN`, pour ne pas
  empoisonner les intervalles.
- `dayAfter` / `dayAdd` / `dayDiff` sont de l'**arithmétique de calendrier** (via `Date.UTC`), pas `+24 h` :
  la nuit d'automne fait 25 heures, et `+DAY` renvoyait le *même* jour — de quoi faire boucler un planning
  ou une automatisation.
- `endOfDayMs(day)` = minuit local du lendemain (23 h ou 25 h selon le jour) : toutes les bornes de
  journée (planning, heatmaps, blocs, doublon même jour) l'utilisent.
- Vérifié par `tests/deep.test.ts` (grille 09:30→19:50 sur les six jours encadrant chaque bascule,
  longueurs de journée, cohérence du `.ics` en UTC).

## Annulation, report, no-show

- Annulation libre jusqu’à **4 h** avant (modifiable). Passé ce délai : on appelle, on ne bloque pas.
- Acompte **25 %** (plancher 10 €) demandé au-delà de **45 €** de prestation, et pour les
  récidivistes (≥ 2 no-show) — `depositPlan()` dans `domain/booking.ts`. Encaissé, restitué, jamais
  inventé : le solde est calculé côté serveur.
- Annulation = idempotente. Le créneau est remis en jeu **immédiatement** (voir waitlist).
- No-show constaté par le barbier → `no_show`, compteur client +1, événement journalisé, message
  pédagogique (pas de pénalité silencieuse). Après 2 : acompte automatique aux réservations suivantes.
- Décalage et changement de prestation par lien signé : la durée est revérifiée (`duree_incompatible`),
  le créneau aussi.

## Confirmation et rappels

`confirm` J-1 (si activé) · rappels J-3, J-1, H-3 · rappel d'appel pour les créneaux serrés.
Un rappel n'est jamais envoyé entre **21 h et 8 h** : `respectQuietHours()` reporte `send_ts`.
Un même message ne part pas deux fois : clé d'idempotence `(rdv, kind, canal)`.

## Waitlist (zéro demande perdue)

- Entrée : nom, téléphone, prestation, jours souhaités, créneau matin/après‑soir/soiré, souplesse
  (autre barbier, autre jour, +N jours), note, consentement de contact.
- Position **réelle** rendue (`{rank,total}`), jamais une position fabriquée ; `estimatedNext` provient
  du vrai calendrier.
- Offres FIFO au premier compatible ; TTL **12 min** ; lien de réclamation signé (le SMS porte le jeton,
  vérifié par `tests/notify.test.ts`) ; refus → le créneau repart en vente, testé.
- Une entrée sans consentement de contact reste en file avec `consent_contact = 0` et **ne reçoit
  jamais** de message (test dédié).

## Fidélité, parrainage, cartes cadeaux

- Points : 25 pts par visite, palier 5 visites → taille de barbe offerte (15 €). Le compteur
  n'avance qu'à la complétion du RDV, jamais à la réservation.
- Parrainage : code perso du client, récompense versée à la **première visite honorée** du filleul
  (pas à l'inscription) ; classement dans le back-office.
- Cartes cadeaux : 10 à 500 €, paiement Stripe (testé en mode test), code à 12 caractères,
  solde multi-usages, durée légale 1 an ; achat → e-mail au bénéficiaire avec le code.

## Avis (éthique, pas de manipulation)

- Demande après RDV honoré, **une seule fois** (idempotence + plafond marketing hebdomadaire).
- 4-5 ★ → on propose Google (lien direct). ≤ 3 ★ → formulaire privé au patron, rappel téléphonique.
- Public sur le site : uniquement les avis collectés avec consentement de publication, ou repris
  d'un profil vérifiable (Planity/Google) avec la source affichée. Les avis de démonstration sont
  `channel='demo'` + `visibility='private'` : **jamais** visibles comme preuve sociale.
- Aucune note agrégée inventée : `aggregateRating` du JSON-LD n'est émis que si une note réelle existe.

## Priorités (celles du brief, dans l'ordre)

1 fiabilité du rendez-vous · 2 simplicité client · 3 temps gagné par le barbier · 4 moins de no-show ·
5 récupération des créneaux · 6 acquisition · 7 rebooking · 8 fidélité · 9 panier moyen · 10 analytics.
Chaque arbitrage de code suit cet ordre : par exemple, la rareté affichée est vraie (1) même si une
fausse rareté convertirait mieux (6).
