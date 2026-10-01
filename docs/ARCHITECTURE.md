# Architecture

## Forme générale

Un seul dépôt, une seule origine, deux moitiés qui se parlent en HTTP :

```
client/   Vite + React 18 + React Router (SPA, ~5 000 lignes)
server/   Hono (36 routes publiques, 8 espace client, 42 back-office, 2 internes, 2 master)
          domain/ (moteurs) · db/ (schéma + driver SQLite/Postgres) · lib/ (time, sécurité, entrées)
scripts/  smoke.ts (22 invariants) · prerender.mts (SSG SEO) · dev.mjs · gen-icons.mjs · audit-secrets.mjs
tests/    node:test (46 tests) + tests/e2e (Playwright)
api/      bridge serverless Vercel (12 lignes utiles)
```

Le client n'appelle jamais une API distante : tout est `/api/*` sur le même hostname, cookies
`SameSite=Lax` httpOnly. Conséquence : pas de token dans `localStorage` (donc pas de vol par XSS
stocké), pas de CORS à configurer, et le CDN annule la latence DNS/TLS d'un second domaine.

## Pourquoi Vite + Hono et pas Next.js

| Contrainte du cahier des charges | Réponse du stack choisi |
|---|---|
| Performance mobile, JS minimal | Vite sort un bundle découpé (react séparé, CSS en un fichier) + HTML pré-rendu : le premier paint n'attend pas 200 ko de framework serveur |
| Moteur de disponibilité transactionnel | Un serveur HTTP minimal (Hono, ~14 ko) avec `better-sqlite3`/`pg` en accès direct : aucune couche ORM entre la contrainte d'unicité et l'écriture |
| Serverless (Vercel/Neon/Supabase) | Hono = une fonction `fetch` ; le pont Vercel fait 30 lignes. Next.js aurait imposé son routeur, son cache et son `next/font` pour un site à 15 gabarits |
| Multi‑salon, prêt SaaS | Le schéma est déjà multi‑tenant (`tenants`, `locations`, `location_id` sur chaque table) — un framework applicatif n'y change rien |

Ce que Next.js aurait donné en plus : du RSC et de l'hydratation partielle. Inutile ici : les pages
sont des gabarits avec 3 zones dynamiques (disponibilité, espace client, back‑office), qui doivent
de toute façon être fraîches à la seconde. Le pré-rendu statique + `fetch` à chaud couvre le besoin
SEO sans ajouter de surface d'erreur.

## Le moteur de disponibilité (pièce maîtresse)

`server/domain/availability.ts` :

1. `computeDay(ctx, opts)` construit la journée : horaires du jour ( plage du jour > jours fériés >
   plage hebdo ), occupation par barbier avec **marges** (`prep_min` avant, `cleanup_min` après),
   pas d'alignement (`slotStepMin`), préavis (`leadTimeMin`), fenêtre demandée.
2. `resolveOffering` agrège prestation + options : c'est la durée calculée ici qui réserve le
   créneau, jamais celle affichée par le client.
3. `presentStepFor(durée)` = pas d'**affichage** (15–30 min). Les trois chemins qui acceptent un
   créneau (liste, réservation, décalage) passent par `slotOfferable(day, start, end)` : un créneau
   montré est un créneau prenable. C'est la règle qui a tué le bug « j'ai cliqué, on m'a dit complet ».
4. `smartAlternatives` produit les solutions de repli (autre barbier / autre heure / autre jour) —
   le même code sert à l'écran « jour plein » et au 409 de conflit.
5. Cache mémoïsé par `(location, jour, prestation, barbiers, fenêtre, pas)` + `bumpAvailabilityCache()`
   à chaque écriture. Le cache accélère, il ne peut pas mentir : la clé change dès que le planning bouge.

## Intégrité : zéro double réservation

- Lecture de disponibilité = confort. **La vérité se décide dans la transaction d'écriture.**
- `transaction(fn, lockKey)` : sur SQLite, `BEGIN IMMEDIATE` **et** garde exclusive tenue du `begin`
  au `commit` (`db/index.ts`) : sans elle, une seconde session écrivait à l'intérieur de la
  transaction ouverte par la première — ses écritures étaient validées ou annulées par autrui, et
  la collision d'index remontait en 500. Sur Postgres : `SELECT pg_advisory_xact_lock(location_id)`
  par salon, puis contrainte d'unicité partielle sur `(staff_id, start_ts)` pour les statuts bloquants.
- Réentrance : un `transaction()` déclenché depuis une transaction déjà ouverte n'attend pas la garde
  (AsyncLocalStorage) et s'ouvre en `SAVEPOINT` — un `commit` interne ne valide plus le travail du parent,
  un `rollback` interne ne lui efface plus rien.
- Une collision d'index qui survivrait à la garde (deux instances serverless sur la même minute) est
  **traduite en 409 `creneau_pris` avec alternatives** (`slotSafe`, `domain/booking.ts`) : un conflit de
  créneau est une issue métier, jamais une panne serveur.
- À l'intérieur : revérification du créneau (`slotOfferable`), contrôle du plafond de RDV actifs,
  du doublon (même client, même créneau), du préavis, de l'horizon, des compétences du barbier.
- En cas de conflit : 409 `creneau_pris` + `data.alternatives` (vrais créneaux, pas un message creux).
- Annulation : idempotente (`{ok:true, already:true}` au second clic) — un double-clic ne crée pas
  deux mouvements ni deux offres.

## Attentes et files : le mécanisme de récupération

`annulation → slot libéré → replayWaitlist → offre au premier compatible (FIFO) → RDV « held » +
SMS avec lien signé (TTL 12 min)`. Le créneau n'est jamais rendu public pendant qu'une offre court :
si le client refuse ou laisse expirer, l'offre est annulée et le créneau repart en vente. Le tout est
testé (`tests/booking.test.ts`, `tests/waitlist.test.ts`, smoke « waitlist »).

## Serverless : pas de timer en mémoire

`server/index.ts` contient un `setInterval` de tick, **uniquement en développement** (`!env.isProd`).
En production, `vercel.json` déclenche `/api/internal/cron` (protégé par `CRON_SECRET`) toutes les
10 minutes entre 7 h et 21 h. `tick()` est idempotent : il relit l'état en base (`scheduler_state`),
recale les rappels, marque les no-shows, expire les offres, relance les reports — le rejouer deux fois
ne produit pas deux messages (clé d'idempotence `appt:<id>:<kind>:<canal>` sur `notifications`).

## Notifications

Aucun appel réseau pendant une requête client : `notify()` écrit dans la table `notifications`
(statut `queued`, `send_ts` recalé par les heures de silence), et l'envoi réel est fait par le cron
ou par `POST /api/admin/notifications/:id/resend`. Les fournisseurs (SMTP/Resend, Twilio, WhatsApp,
Stripe) sont derrière une interface avec un implémentation `stdout`/`demo` : la démo est complète
sans clé, et brancher le vrai fournisseur ne touche aucun fichier métier.

## Multi‑salon, multi‑rôles

`tenants` (une marque) → `locations` (un salon) → tout le reste porte `location_id`. Rôles
`owner > manager > staff > customer` (`RANK` dans `lib/security.ts`) ; `requireAdmin(c,'manager')`
est le garde-fou sur chaque route d'écriture sensible ; un client n'adresse jamais une ressource
qu'il ne possède pas (les routes client passent par la session, les liens signés portent l'identité
du client — vérifiée, sinon 403/404, testé : `tests/security.test.ts`).
