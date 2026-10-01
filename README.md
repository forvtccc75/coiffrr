> **Interface mobile façon app :** Accueil / Réserver / Mes RDV / Le salon, en-tête compact, actions de réservation au-dessus des onglets, panneau de choix du barbier et installation sur l’écran d’accueil. Desktop conservé, navigation admin séparée. `npm run test:mobile` vérifie le vrai build avec Chromium et WebKit (installer les deux moteurs avec `npx playwright install --with-deps chromium webkit`). Guide unique §19. Aucun catalogue réel n’a été activé.

> **Correctif navigation — 29/09/2026 :** le décor de l’accueil n’intercepte plus les clics. Les JS/CSS/images et pages d’entrée sont servis avant le démarrage du backend, sans accès DB. HTML revalidé, vrais 404 non cachés pour les fichiers absents, récupération bornée des imports en échec. `npm run test:assets` teste le backend volontairement en panne ; `npm run test:navigation` clique les vrais liens sur le build compilé et simule les imports 503/404 (Chromium requis). Guide unique §18. À redéployer, pas de SQL à réinitialiser.

> **Complément — waitlist / galerie / logs :** liste d’attente corrigée et testée, e-mails Brevo d’inscription et d’offre, confirmation explicite, retrait/refus sécurisés. Une vraie photo de devanture Google est livrée et sera importée à la mise en ligne du nouveau code. Voir le guide unique §§15–17. Les logs fournis restent privés dans `uploads/` (exclus du dépôt et du déploiement).

> **Mise à jour 29/09/2026 — projet corrigé directement, aucun ZIP.**
> La base Supabase réelle contient maintenant le salon, un propriétaire et des modèles **inactifs**.
> Accès et mot de passe uniques : **guide PDF privé**, §4. Ne jamais publier `.env.*` ni ce PDF.
> Le déploiement GitHub/Vercel reste à faire pour les nouveaux écrans et l’intégration **Brevo**.
> `EMAIL_PROVIDER=brevo`, `BREVO_API_KEY`, `EMAIL_FROM` vérifié ; `EMAIL_REPLY_TO` facultatif.
> Aperçus HTML hors ligne : `docs/APERCU-EMAILS.html`. Référence complète : `docs/GUIDE-MISE-EN-LIGNE.md`.
> Paiement **sur place uniquement** (`PAYMENTS_PROVIDER=off`). Horaires Planity à confirmer, non publiés sur Google.

# Z.YASS Barber Shop — plateforme de réservation, CRM et automatisation

> **Correctif Vercel 29/09 :** `npm run build` compile désormais le serveur vers `dist/server/app.cjs`.
> Remettre le projet complet sur GitHub en conservant les dossiers et les fichiers de configuration ; les correctifs sont déjà intégrés aux sources.
> `npm run test:vercel` valide l’artefact sans sources TypeScript (16 contrôles, Node natif).


> **Exploitation Z.YASS — paiement au salon (28/09/2026).**
> Guide à jour : `docs/GUIDE-MISE-EN-LIGNE.md` (PDF privé via `npm run guide`).
> Vercel : `PAYMENTS_PROVIDER=off`, `DEMO_MODE=0`, pooler Supabase Session 5432.
> Premier accès `/admin` : `BOOTSTRAP_OWNER_EMAIL` + `BOOTSTRAP_OWNER_PASSWORD` (12+ caractères).
> Le bootstrap initialise un salon vide, jamais des clients ni comptes de démo. Retirer ces variables après connexion.
> Équipe, catalogue et horaires à renseigner dans Réglages ; notifications réelles à brancher avant ouverture.
> SEO production : `PRERENDER_DB=live`, `PRERENDER_STRICT=1`, puis redéployer après mise à jour du catalogue.
> Aucun changement du SQL de structure pour ces ajouts. Aucun cron déclaré dans Vercel ; ordonnanceur externe requis pour les rappels programmés (voir guide §6).


Pas « un joli site de salon ». Un moteur commercial : le salon est **saturé** (plus de demandes que de
créneaux organisables) et son vrai problème n'est pas la visibilité, c'est le temps perdu — appels
perdus, créneaux qui se libèrent et ne se remplissent pas, no-shows, relances à la main, statistiques
dans une tête. Ce dépôt remplace ce travail par un système : **acquisition → réservation fiable →
récupération des trous → fidélisation → mesure**.

Fermé par quatre règles, écrites dans le code et tenues par des tests :

| Règle | Ce qu'elle impose |
|---|---|
| **ZÉRO DEMANDE PERDUE** | un jour plein ne dit jamais « complet » : vraies alternatives (autre heure, autre barbier, autre jour) + waitlist + téléphone |
| **ZÉRO CHAOS** | confirmations, rappels, waitlist, reports, avis, segments, statistiques : automatique, avec interrupteur par moteur |
| **ZÉRO DOUBLE BOOKING** | le serveur décide dans une transaction, verrou + index unique ; le frontend n'est jamais cru |
| **ZÉRO FAUSSE RARETÉ** | la rareté est calculée en temps réel ; aucun créneau fantôme, aucun compte à rebours truqué, aucun avis inventé, aucun spam |

## Démarrer en trois commandes

```bash
npm ci
npm run seed -- --fresh     # base de démo réelle : 56 clients, 293 RDV, 14 prestations, 7 waitlists
npm run dev                 # API sur :8787, site sur :5173 (le site proxifie /api)
```

| Ouverture | Identifiants de démonstration |
|---|---|
| Client `http://localhost:5173/espace` | un numéro de la démo, code à 6 chiffres affiché dans la console (aucun mot de passe) |
| Patron `http://localhost:5173/admin` | `owner@zyass.fr` / `demo-owner` |
| Barbier | `mehdi@zyass.fr` / `demo-staff` (et ne voit **pas** les réglages : RBAC testé) |

Vérifications :

```bash
npm run check          # types + 123 tests + 22 garanties produit + audit du site généré (SEO/a11y/rareté/adaptivité)
npm run verify           # 73 contrôles fonctionnels, sur une base SQLite NEUVE et jetable (rapport JSON)
npm run verify:pg        # les MÊMES 73 contrôles sur Postgres — exiger DATABASE_URL d'une base de test
npm run pg:check         # recette Postgres complète : 52 tables, seed, 123 tests, serveur live, cron, 18 contrôles HTTP
npm run build          # bundle Vite + pré-rendu de 32 pages HTML (titres/canonical/JSON-LD par page + premier paint)
                       # le pré-rendu est autonome : il ne demande ni base, ni secret, ni disque — c'est ce qui le fait passer sur Vercel
npm run smoke -- --json # 22 invariants sur la base de démo, avec chiffres réels
bash scripts/smoke.sh --local   # 18 vérifications HTTP sur l'instance qui tourne (tempête de 10 réservations simultanées, réservation annulée après test)
npm run e2e            # Playwright : 5 projets (iPhone 13, 320 px tactile, 2 tablettes, bureau) × réservation, back-office, adaptivité
npm run e2e:adaptivite # seul le contrôle multi-tailles : 8 tailles (320→1920) × 5 pages, zéro débordement horizontal exigé
```

Résultat sur cette machine : `typecheck` 0 erreur · **123/123** tests · **22/22** garanties ·
**18/18** smoke HTTP rejoués deux fois de suite · audit de site **0 violation** (32 pages pré-rendues) ·
**89/89** tests Playwright passés (5 projets d'appareils, 8 tailles d'écran, réservation Instagram comprise).
Exemples de ce que les tests vérifient pour de vrai : « 633 créneaux libres réels sur 14 jours, 0 artifice »,
« waitlist : position 9/9 → offre 09:30 → RDV », « RBAC anon=401, staff/settings=403 », « IDOR : détail 404 »,
« dix clients sur le même créneau = **une** réservation, aucun 500 », « 09:30 reste 09:30 les jours de
changement d’heure ».

## Ce que le système fait vraiment

**Acquisition.** Deep links vers la réservation déjà pré-remplie depuis Instagram/TikTok/Google :
`/book?service=coupe-barbe&staff=rayan&slot=…&campaign=story-semaine&source=instagram`. L'attribution
survit au parcours, entre dans la fiche client et dans l'entonnoir. Pages par prestation et par barbier,
pré-rendues, avec JSON-LD `HairSalon`/`LocalBusiness`/`Service`/`FAQPage`, sitemap, robots, manifest PWA.

**Réservation.** 14 prestations, 3 barbiers, compétences réelles (la décoloration part chez Rayan, et
un autre barbier reçoit un 400 explicite au lieu d'un créneau impossible). Options qui changent prix
**et** durée. Préavis, horizon de 21 jours, préparation/nettoyage qui bloquent le barbier, acompte
automatique au-delà de 45 € ou après 2 no-shows. Brouillon repris en un clic après abandon.

**Après la réservation.** Confirmation et rappels (J-3, J-1, H-3) jamais la nuit, décalage/annulation
par lien signé, .ics, annulation idempotente, relance d'avis à l'éthique stricte (4-5★ → Google, ≤3★ →
formulaire privé au patron).

**Récupération.** Le client annule → le créneau est retenu et proposé **en 1 clic par SMS** au premier
de la waitlist compatible (FIFO, TTL 12 min) ; refus ou expiration → remise en vente. C'est le module
qui paie l'abonnement.

**CRM et fidélité.** Historique, notes internes, mesures, segments recalculés, clients à risque,
points et paliers, parrainage récompensé à la première visite honorée, cartes cadeaux 10–500 €,
export RGPD et anonymisation en self-service.

**Back-office.** Vue du jour, planning par barbier, files (retards, walk-ins, relances à traiter),
waitlist, analytique (13 rapports), automatisations avec interrupteurs, modèles de messages,
réglages (prestations, équipe, règles, horaires, médias), assistant qui répond sur les chiffres du
salon et **propose** ses actions avant de les exécuter.

## Stack — et pourquoi ce n'est pas celle du brief

Le brief proposait Next.js + Postgres + Stripe + Twilio. Voici les écarts, chacun justifié :

| Choix | Écart assumé | Raison |
|---|---|---|
| **Vite + React + Hono** au lieu de Next.js | oui | Le site a ~15 gabarits et 3 zones dynamiques qui doivent être fraîches à la seconde. Vite sort un bundle plus petit et un HTML pré-rendu ; Hono sert l'API, les assets, les pages statiques et le webhook sur le même port, sans routeur de framework à apprendre. Le SEO local est couvert par le pré-rendu + JSON-LD, pas par RSC |
| **SQLite (`better-sqlite3`) en local/CI, Postgres en prod** | oui | Un seul moteur en prod (Neon/Supabase) mais une démo clonable sans service externe. Le SQL est écrit à la main et traduit par `db/driver.ts` (auto-incrément, paramètres nommés, verrous) ; la CI prouve les deux moteurs sur les mêmes 22 garanties |
| `better-sqlite3` plutôt que `node:sqlite` | oui | `node:sqlite` n'existe pas sur Node 20. Le contrat est le même (transactions synchrones, prepared statements), et c'est ce qui rend `BEGIN IMMEDIATE` trivial |
| **TypeScript strict, zéro ORM** | oui | La garantie « zéro double booking » vit dans la requête et la transaction. Un ORM qui réécrit mes SQL aurait masqué les contraintes partiales et les verrous |
| **`node:test` + smoke maison** au lieu de Jest/Vitest | oui | Le produit se juge sur des invariants métier bout-en-bout ; un seul runtime, aucun plugin, les mêmes tests en CI locale et Postgres |
| **Stripe en mode test + file d'envoi `stdout`** | contraint | Cet environnement n'a aucune clé réelle. Les fournisseurs sont derrière une interface (`payments.ts`, `notify.ts`) avec un adaptateur `demo` : la démo est complète, brancher le vrai ne touche aucune logique métier. Les messages sont journalisés, jamais inventés |
| **Aucune preuve sociale fabriquée** | choix produit | Avis de démo = `channel='demo'` + `visibility='private'`. Seuls les avis réels et vérifiables sortent en public ; une photo réelle de devanture autorisée est importée en production ; les illustrations de démonstration ne prouvent aucun résultat (`docs/CHECKLIST-MARQUE.md`) |

## Organisation

```
client/src/
  router.tsx main.tsx styles.css        shell, routes, design system (encre/or/papier)
  lib/{api,ui}.tsx                      un seul client HTTP (aucun token en localStorage), primitives
  pages/{home,book,waitlist,space,pages}  site public, réservation, waitlist/avis, espace client, pages SEO
  admin/{admin,panels}.tsx              back-office : jour, planning, files, waitlist, CRM, analytics,
                                        avis, marketing, automatisations, assistant, réglages
server/
  app.ts routes.ts index.ts              Hono : sécurité, 90 routes, SPA + pages pré-rendues, bootstrap
  domain/availability.ts booking.ts      moteur de créneaux, transaction d'écriture, acomptes
  domain/{waitlist,notify,automations}   récupération, file de messages, 11 moteurs automatiques
  domain/{loyalty,reviews,analytics,…}   fidélité, avis, rapports, paiements, médias, contexte
  db/{schema,driver,index}.ts            51 tables, 64 index, SQLite/Postgres, verrous, migrations
  lib/{time,security,inputs,secrets}.ts  fuseau Paris, sessions/rate-limit, normalisation, jetons
  seed/index.ts                          démo réaliste (56 clients, 293 RDV, files d'attente, cartes)
scripts/  smoke.ts (22 garanties) · prerender.mts + ssr-lib.mts (SSG partagé) · audit-site.mjs
          (SEO/a11y/rareté/poids) · audit-secrets.mjs · smoke.sh (HTTP) · dev.mjs · gen-icons.mjs
tests/    153 tests node:test : inputs, availability, booking, waitlist, security, notify, env, hours
          (éditeur d'horaires), whatsapp (format Meta, gabarits, file de repli), pg-ssl (politique TLS),
          deep (concurrence, cartes cadeaux, fuseau, plafonds, injection) · render (HTML pré-rendu) ·
          responsive (13 invariants mobile-first) · funnel (vocabulaire d'acquisition) + e2e/ (4 specs × 5 vues,
          dont la reprise d'erreur d'hydratation et la tempête HTTP en direct)
docs/     GUIDE-MISE-EN-LIGNE (LE guide : SQL + Vercel + DATABASE_URL + WhatsApp + admin) ·
          ARCHITECTURE · REGLES-METIER · MODELE-DONNEES · SECURITE · RGPD · ADAPTIVITE (mesuré) ·
          AUDIT-EXIGENCES · CHECKLIST-MARQUE
db/supabase/  01-schema · 02-securite-supabase (RLS + revokes PostgREST) · 03-controles ·
          04-exploitation  — générés par `npm run db:sql`, validés par `npm run sim:supabase`
api/index.ts  vercel.json                fonction serverless (tout le trafic passe par l'app Hono)
```

## Variables d'environnement et SQL Supabase

Tout est réuni dans **un seul document imprimable** : `npm run guide` → `docs/GUIDE-MISE-EN-LIGNE.pdf`
(identité légale vérifiée au registre, variables, secrets générés, cron, les 4 fichiers SQL en entier,
check-list de mise en production, pannes typiques). Le PDF est généré localement et hors dépôt parce qu'il
contient vos secrets ; sans `.env.production.local`, la section secrets bascule sur des placeholders.

`.env.example` est commenté variable par variable — et ne contient **que** ce que le code lit
(`GSC_ANALYTICS` est d'ailleurs lue sans effet : c'est écrit en face). Le strict minimum pour démarrer :
aucun — `npm run dev` fonctionne en configuration par défaut (SQLite local, providers `stdout`, démo active).

En production : `DATABASE_URL`, `APP_URL`, `SESSION_SECRET`, `TOKEN_SECRET`, `CRON_SECRET` (+ `PG_POOL_MAX=5`
sur Vercel). **La liste exhaustive, l'URL exacte du pooler Supabase, les 4 fichiers SQL à coller dans
l'éditeur Supabase, le branchement WhatsApp et les réglages admin** : tout est dans
`docs/GUIDE-MISE-EN-LIGNE.md` (même contenu en PDF via `npm run guide`).
Le SQL est généré depuis le schéma de l'app : `npm run db:sql`, et sa validation se rejoue avec
`npm run sim:supabase` (Postgres local simulant un projet Supabase : rôles `anon`/`authenticated`, droits
par défaut, 01→04, puis les 73 contrôles sur la base durcie).

## Lire dans cet ordre

1. `docs/ARCHITECTURE.md` — comment ça tient, et pourquoi le frontend n'est jamais cru.
2. `docs/REGLES-METIER.md` — les chiffres du salon (préavis, acomptes, waitlist, rappel, fidélité).
3. `docs/SECURITE.md` et `docs/RGPD.md` — la liste des attaques traitées, avec le test qui prouve.
4. `docs/ADAPTIVITE.md` — ce que « mobile-first » veut dire ici, palier par palier, et comment il est mesuré.
5. `docs/AUDIT-EXIGENCES.md` — l'auto-audit des exigences, y compris ce qui reste ouvert.
6. `docs/GUIDE-MISE-EN-LIGNE.md` — **le seul guide d'exploitation** : les trois blocs à coller (env,
   cron, SQL), le pooler en mode session, le cron selon le plan Vercel, WhatsApp de bout en bout,
   l'admin (horaires, marque, exceptions), les pannes typiques et la check-list de mise en production.
7. `docs/AUDIT-EXIGENCES.md` §« campagne fonctionnelle » — chaque fonctionnalité, le contrôle qui la
   prouve, et les défauts que la campagne a fait corriger (le détail des 73 contrôles est rejouable à
   volonté : `npm run verify`).

## Échéances connues, sans maquillage

Paiement en ligne désactivé ; messagerie Brevo/Twilio/Meta à raccorder (aucune clé fournisseur livrée), galerie réelle à compléter et vrais avis à importer, import du
stock de clients depuis l'outil actuel à écrire, UI multi-établissements absente (schéma prêt),
audit d'accessibilité outillé (axe) et test de charge non exécutés sur cette machine. L'adaptivité et
les parcours critiques sont en revanche mesurés dans un vrai navigateur (8 tailles d'écran, cible tactile
au pixel près) ; les encoches d'iPhone restent un contrôle visuel sur matériel. Détail, paliers et
méthode de mesure dans `docs/ADAPTIVITE.md` ; défauts trouvés et corrigés dans `docs/AUDIT-EXIGENCES.md` §13.
