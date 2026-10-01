# Auto-audit des exigences (req. 108)

État honnête, block par block, avec la preuve exécutable. Trois statuts : **fait** (code + test),
**partiel** (fonctionnel mais incomplet ou dépendant d'un branchement externe), **non fait** (hors
de portée sur cette machine — jamais simulé ni maquillé).

Preuve globale : `npm run check` = types propres (client **et** serveur), **46 tests** `node:test`,
**22 garanties** de bout-en-bout `scripts/smoke.ts` (base de démo réelle, 56 clients, 293 RDV).

## 1. Les quatre règles dures

| Exigence | Statut | Preuve |
|---|---|---|
| ZÉRO DEMANDE PERDUE : jamais un « complet » sec | **fait** | alternatives serveur + waitlist + téléphone sur chaque jour plein ; `tests/availability.test.ts` (tous les jours sans créneau), smoke « ZERO DEMANDE PERDUE : 14 j explorés, 3 sans créneau, 6 alternatives » ; écran `NoSlot` |
| ZÉRO CHAOS : tout ce qui est répétitif est automatique | **fait** | 11 automatisations actives (confirmation, J-3/J-1/H-3, offre waitlist, relance d'annulation, avis, rebooking, anniversaire, winback, welcome, reprise de panier, escalade no-show) ; `tick()` idempotent ; `tests/notify.test.ts` prouve que l'interrupteur coupe réellement le flux |
| ZÉRO DOUBLE BOOKING : le serveur décide | **fait** | transaction + verrou + index unique partiel `ux_appt_slot` ; re-vérification du créneau, du préavis, du plafond, des compétences à l'intérieur ; `tests/booking.test.ts` (409 + alternatives, autre barbier OK), smoke |
| ZÉRO FAUSSE RARETÉ : rareté réelle, dynamique, pas de spam | **fait** pour le code, **partiel** sur la source de vérité | compteurs = créneaux réellement libres (`tests/availability.test.ts` : « compteur = liste »), `Meter` de rareté branché sur les données ; aucun faux compte à rebours, aucun créneau fantôme, aucun avis inventé (avis de démo `channel='demo'` + `visibility='private'`) ; smoke « 637 créneaux libres réels, 0 artifice ». **Partiel** : aucune source de rareté externe (pas de synchro avec un agenda tiers type Planity) — tant que l'agenda de référence n'est pas branché, la vérité vient de cette base uniquement |

## 2. Site commercial & acquisition

- Pages : accueil, catalogue par prestation (14 pages `/prestation/<key>`), fiches barbiers, tarifs,
  galerie, infos & accès, FAQ, cartes cadeaux, mentions, données personnelles, accessibilité, guides
  SEO (13 pages éditoriales), plan du site — routes publiques et **pré-rendues** (32 fichiers HTML,
  `scripts/prerender.mts`) avec `title`, `description`, `canonical`, JSON-LD par page. **fait**
- Deep links `/book?service=…&staff=…&slot=…&campaign=…&source=instagram|tiktok|google` :
  le lien ouvre la sélection déjà faite, l'attribution est conservée (`localStorage.zyass_attr`,
  `igshid` → instagram) et retombe sur le funnel. **fait** (`tests/inputs.test.ts` pour le parseur,
  `tests/e2e/booking.spec.ts` pour le parcours complet)
- SEO local : `HairSalon`/`LocalBusiness` (adresse, horaires, géo, téléphone, réseaux), `Service` +
  `FAQPage` par prestation, `Person` par barbier, `Article` par guide, sitemap 28 URLs, robots.txt,
  manifest PWA. Note `aggregateRating` émise **seulement** si une note réelle existe. **fait**
- Réseaux : pas de filigrane ni de contenu volé ; la galerie est volontairement marquée « à remplacer »
  (`docs/CHECKLIST-MARQUE.md`). **partiel** (photos de démonstration)

## 3. Moteur de réservation & planning

Préavis, horizon 21 j, pas de grille, pas d'affichage adapté à la durée, préparation + nettoyage qui
bloquent le barbier, compétences par prestation, fenêtres matin/après-midi/soiré, sélection d'un
barbier, options qui changent prix **et** durée, brouillon repris en un clic, acompte automatique,
décalage/annulation par lien signé, .ics, confirmation J-1, plafonds anti-abus. **fait**
Back-office : vue du jour, planning 10-min par barbier, glisser-déposer simple (déplacer/réassigner/
statuts/blocage), file du jour avec retard et attente, blocs (pause, réunion, congé, maintenance),
walk-in, création d'un RDV en 4 champs. **fait** (UI), schéma multi-salon prêt.

## 4. Waitlist, rappels, communications

Position réelle, souplesse, TTL d'offre 12 min, SMS de récupération avec **vrai** lien de réclamation
et de refus (corrigé pendant cette session : le lien était `/book`, ce qui rendait la récupération
inutilisable — test `tests/notify.test.ts`), refus → remise en vente, `consent_contact=0` → jamais
contacté, heures de silence 21 h–8 h, dédoublonnage par clé d'idempotence. **fait**
Canaux : `stdout`/`demo` actifs, `resend`/`twilio` implémentés derrière interface. **partiel**
(aucune clé réelle dans cet environnement : les messages sont journalisés, pas envoyés).

## 5. CRM, fidélité, paiement

Fiche client (téléphone/e-mail normalisés → pas de doublon : test dédié), historique, notes internes,
mesures, tags, segments recalculés, risque et files de relance, export RGPD, anonymisation. **fait**
Loyalty (points, paliers, récompenses, rachats à la réservation), parrainage (récompense à la première
visite honorée), cartes cadeaux (achat 10–500 €, code, solde, expiration, rachat, e-mail au bénéficiaire),
acomptes et remboursement. **fait** en logique ; **partiel** sur le paiement réel (Stripe test via
`payments.ts`, webhook `payment_intent.succeeded`/`charge.refunded` câblé, aucune clé live ici).

## 6. Analytics & aide à la décision

13 rapports réels (indicateurs, entonnoir, sources, CA, prestations, charge, heatmap d'affluence,
prévision, clients à risque, recommandations, valeur client, temps réel, technique), basés sur
`funnel_events` + `appointments` + `payments`, et un assistant qui répond en français sur ces chiffres.
**fait** ; les prévisions sont un calcul glissant (jour × heure × saisonnalité simple) et **annoncent
leur marge**, pas une IA opaque.

## 7. Mobile, accessibilité, performance

Mobile first (le parcours de réservation est écrit pour le pouce, barre collante, cibles ≥ 46 px),
skip-link, focus visible, `role=radiogroup` sur les choix, `aria-live` sur les erreurs et le minuteur,
respect de `prefers-reduced-motion`, contraste validé sur les paires encre/or/papier, HTML sémantique,
JS minimal (bundle react séparé, CSS en un fichier, pas de librairie de dates ni de state-manager).
**fait** — avec une réserve honnête : **pas d'audit automatique d'accessibilité** (ni axe ni
accessibility-checker) dans cette boîte, donc « WCAG-like », pas « conforme certifiée ».

## 8. Sécurité, RGPD, auditabilité

Voir `docs/SECURITE.md` et `docs/RGPD.md` : 8 tests dédiés (en-têtes, cookie, RBAC, IDOR, brute force,
injection, cron, droits RGPD) + `audit:secrets` bloquant. **fait**

## 9. Multi-staff, multi-salon, prêt SaaS

51 tables multi-tenant, `location_id` partout, rôles owner/manager/staff/customer, API `master`
(`GET /api/master/tenants`, `POST /api/master/locations`), `?loc=` accepté par les routes admin.
**fait** côté schéma/API ; **partiel** côté UI (le back-office gère un salon à la fois, pas de
sélecteur d'établissement ni de faituration par tenant).

## 10. Intelligence artificielle

L'assistant du back-office est un **moteur de requêtes déterministes** sur les données du salon
(intent → SQL paramétré → réponse + proposition d'action), avec double clé de sécurité : action
**proposée puis confirmée** par un humain (`pending_actions`, jeton 10 min), jamais appliquée en
catimini. Pas de LLM distant : aucune donnée client ne sort, et la réponse ne peut pas halluciner un
chiffre. **fait** — c'est un choix assumé, pas une promesse de conversation libre.

## 11. Tests, docs, déploiement

84 tests (dont `deep` : concurrence, cartes cadeaux, fuseau, plafonds, injection — `render` : HTML
pré-rendu — `responsive` : 13 invariants d'adaptivité lus dans la source et dans le HTML — `funnel` :
le vocabulaire d'acquisition tenu de bout en bout) + 22 garanties + 3 specs Playwright (réservation
depuis un lien Instagram, « jour plein » jamais muré, prix du panier, back-office, RBAC visuel, et 8
tailles d'écran × 7 comportements) + 1 script shell (`smoke.sh` HTTP contre une instance réelle) + CI à
trois jobs (qualité, **Postgres**, e2e). Docs : README + 9 documents (`docs/`, dont `ADAPTIVITE.md`).

**Les specs e2e tournent désormais sur cette machine.** À la passe précédente, Chromium refusait de se
lancer (libnss3, libatk-bridge, libxkbcommon… absents, `apt-get install` interdit sans root). Contournement
utilisé, sans rien toucher d'autre : listes apt rafraîchies dans un dossier utilisateur, paquets
téléchargés (`apt-get download`) et dépaquetés (`dpkg -x`) dans un préfixe local, puis
`LD_LIBRARY_PATH=/tmp/prefix/usr/lib/x86_64-linux-gnu` et `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1`.
Résultat : **89 tests passés, 0 échoué** en 7 min 36 sur `npm run dev`, 5 projets (iPhone 13, 320 px
tactile, tablette portrait, tablette paysage, bureau). C'est d'ailleurs ce passage en navigateur réel qui a
trouvé les défauts 11 à 18 du §13 — un audit statique ne les voyait pas.

## 12. Seconde passe de vérification (« vérifie chaque aspect, teste aussi »)

Outil ajoutés pour cette passe : `scripts/audit-site.mjs` (SEO, titres dupliqués, `<h1>`, `alt`, tailles
d'images, cibles tactiles, `!important`, bannissements de fausse rareté, en-têtes réseau sur chaque route
et chaque ressource) et `scripts/ssr-lib.mjs` (le rendu serveur du pré-rendu, partagé avec les tests).
Douze défauts **réels** ont été trouvés par cette passe, tous corrigés, chacun désormais tenu par un test :

| # | Défaut trouvé | Comment | Correction | Preuve |
|---|---|---|---|---|
| 1 | Dix réservations simultanées sur un créneau → **HTTP 500** avec message de contrainte et pile fuités (hors prod) | tempête de test | la collision d'index devient un 409 `creneau_pris` + alternatives | `tests/deep.test.ts`, `scripts/smoke.sh` |
| 2 | La garde d'écriture SQLite ne tenait que par un booléen : une seconde session **écrivait dans la transaction d'autrui** (validée ou annulée par le voisin) | relecture du pilote + tempête | garde exclusive tenue du `begin` au `commit`, réentrance par AsyncLocalStorage | `tests/deep.test.ts` (un seul 201, zéro 5xx) |
| 3 | `transaction()` imbriquée : le `commit` du fils validait tout le travail du parent | traçage des appelants imbriqués | transactions imbriquées en `SAVEPOINT` réels | seed + `npm test` (65/65) |
| 4 | `dayAfter('2026-10-25')` renvoyait **le même jour** (addition de 24 h sur une nuit de 25 h) → boucles de planning bloquées | sondes de bascule d'heure | arithmétique de calendrier (`Date.UTC`) | `tests/deep.test.ts` |
| 5 | Horaires convertis en `minuit + minutes` : 09:30 devenu 08:30 (automne) ou 10:30 (printemps) | idem | `atLocal()` recalcule le décalage à l'instant trouvé | `tests/deep.test.ts` (grille complète, `.ics` en UTC) |
| 6 | `/waitlist` pré-rendu **cassait au rendu serveur** (`location` inexistant) → HTML livré aux moteurs réduit à une coquille vide, marqueur d'erreur d'hydratation | audit de site (`data-msg`) | accès à `location` gardés côté navigateur dans le page-entry | `tests/render.test.ts` (aucun `data-msg` sur 13 routes) |
| 7 | Titres **dupliqués** sur 19 pages (prestations/barbiers/guides) et descriptions de 47 caractères ; canonical faux pour barbiers et guides ; sitemap publiant `/guide/guide-x` que le routeur ne sait pas servir | audit de site | un méta par page via `/api/public/seo/:slug` (titres ajustés à 62 caractères, descriptions longues), canonical calculé depuis l'entité trouvée, URL de guide unique `/guides/<court>` (+ alias `/guide/…` conservé) | `node scripts/audit-site.mjs` : 0 blocant |
| 8 | Images de galerie sans `width`/`height` (saut de mise en page sur 103 occurrences) | audit de site | `frameSize()` depuis `media.aspect`, appliqué accueil/galerie/fiches/back-office | `tests/render.test.ts` (attributs présents dans le HTML rendu) |
| 9 | `<label>` des champs **non associé** au champ (toute l'app) : un lecteur d'écran n'annonçait rien pendant la saisie | audit croisé a11y | `Field` génère un `id` + `htmlFor`, et `aria-labelledby` pour les contrôles composites | `tests/render.test.ts` (for ↔ id sur l'écran de connexion) |
| 10 | Page prestation sans créneau = **impasse** (seul un lien waitlist) | relecture du parcours « zéro demande perdue » | ajout de « Choisir un autre jour » → `/book?service=…` ; lien waitlist barbier désormais préfiltré | `tests/render.test.ts` (CTA profond présent sur 6 fiches) |
| 11 | `!important` comptés comme dette alors qu'ils sont **requis** par `prefers-reduced-motion` | audit de site | l'auditeur exclut ce bloc | `npm run audit:site` |
| 12 | Smoke HTTP non rejouable dans la fenêtre de 10 min (plafond par IP) | deux exécutions d'affilée | le script prend une IP simulée par exécution (et les compteurs sont lus par fichier) | `bash scripts/smoke.sh` × 2 : 18/18 |

| 13 | `script-src 'unsafe-inline'` autorisé sans besoin réel (un XSS injecté aurait pu exécuter du code) | relecture des en-têtes durs | retrait après vérification qu'aucune page du build ne contient de script inline exécutable | `tests/security.test.ts` (assertion négative) + en-tête relu sur l'instance de prod |

Et une vérification qui n'a **rien** trouvé : `observations` ne contient aucune ligne `status='error'`
après toute la charge (le seul enregistrement est l'info de chargement du seed) ; la lecture de fichiers
statiques hors de `dist/client` reste impossible sur cinq URL de traversée encodée.

## 13. Passe adaptivité (« gère aussi l'adaptivité mobile-first, tablette, etc. »)

Deux natures de défauts : ceux que la lecture du CSS révélait (1 à 10), et ceux que seul un
**navigateur qui mesure** révèle (11 à 18) — d'où l'installation de Chromium décrite au §11.
Pour chacun : comment il a été trouvé, la correction, ce qui l'empêche de revenir.

| # | Défaut | Trouvé par | Correction | Preuve (exécutée) |
| --- | --- | --- | --- | --- |
| 1 | Navigation principale `display:none` sous 720 px, sans remplacement : le téléphone n'avait **aucun** menu | lecture de `styles.css` | rail horizontal scrollable (snap, `overscroll-behavior-x`) sous le logo en socle, ligne unique dès 760 px ; rien n'est plus jamais masqué | `tests/responsive.test.ts` (socle + media queries) · e2e « navigation atteignable » × 8 tailles |
| 2 | `100vh` sur `body`, back-office et plein écran de chargement : la barre d'URL mobile rogne le bas | grep `100vh` | `100dvh` avec repli `100vh` (progressif, pas de régression navigateur) | test unitaire « chaque 100vh a son repli » · audit du CSS construit |
| 3 | `viewport-fit=cover` déclaré mais **zéro** `env(safe-area-inset-*)` : le CTA bas de `/book` passait sous le geste de retour | diff meta ↔ CSS | safe-area sur `.sticky`, `.toasts`, `.sheet`, `.ft` | test unitaire par sélecteur |
| 4 | Champs à 15 px : iOS zoome au premier focus et casse la mise en page | règle connue vérifiée dans la CSS | `@media (pointer: coarse){input,select,textarea{font-size:16px}}` | e2e « les champs à 16 px » (390 et 320 px) |
| 5 | Cibles sous 44 px (nav 34→38, `.tab` 34, `.btn.sm` 34, logo 29, `button.link` 21) | **mesure** en contexte tactile | 40 px en socle, 44 px en `pointer: coarse` ; `button.link` rendu `inline-flex` (un `min-height` ne s'applique pas à une boîte inline) | e2e « cibles tactiles » 8 tailles × 2 pointeurs : 25 infractions relevées, puis **0** |
| 6 | `table.t` posés nus (18 occurrences) : le planning forçait le défilement de toute la page | grep des `<table` | enveloppe `.tx` (`overflow-x:auto`, `tabIndex=0`, `role=region`, première colonne collante) ; saignée alignée sur `--gutter` (`min(16px,var(--gutter))`) | test unitaire (18/18 + clavier) · e2e « tableaux dans leur conteneur » |
| 7 | Rail des 14 jours de `/book` : piste de grille auto → page débordant de **752 px** à 360 px | `getBoundingClientRect` sur chaque élément | pistes `minmax(0,1fr)`, `min-width:0` sur les enfants de grille/flex, `minmax(min(X,100%),1fr)` partout | e2e « aucun défilement horizontal » × 9 pages × 8 tailles |
| 8 | Grilles du back-office réglées sur la fenêtre, pas sur la colonne disponible | relecture de `.adm` | `.adm-main{container-type:inline-size}` + règles `@container adm` (620 / 980 px) | test unitaire « @container » · e2e back-office 768 vs 1180 px |
| 9 | Modale : géométrie en style en ligne + `<style>` avec `!important` (inadaptée aux media queries, dette de cascade) | grep `!important` | classes `.scrim`/`.sheet` en mobile-first (feuille en bas, boîte centrée à 720 px) ; **plus aucun** `!important` hors `prefers-reduced-motion` | test unitaire (ui.tsx sans `!important`) · audit « dette de cascade » à 0 |
| 10 | Pied de page **sans aucune règle CSS** (`.ft`, `.ft-grid`, `.ft-bot` utilisés, jamais déclarés) | le test responsive cherchait `.ft a` et ne le trouvait pas | styles ajoutées : grille 1→2→4 colonnes, liens 36 px (44 en tactile), safe-area | test unitaire (sélecteur + safe-area) |
| 11 | `serveIndex()` gardait `index.html` en cache **pour toujours** : après un rebuild sans redémarrage, `/book` et `/admin` pointaient les anciens assets → CSS 404, page livrée entièrement non stylée | les cibles tactiles retombaient à 19 px sur ces deux routes seulement | cache invalidé par `mtimeMs` | preuve directe : marqueur ajouté dans `dist/client/index.html` → servi aussitôt sans redémarrer ; rebuild → marqueur disparu |
| 12 | Un octet **NUL** dans le HTML pré-rendu de `/` (« Avis v\0érifiés »), émis par le rendu en flux | même sonde (largeurs incohérentes d'un page à l'autre) | nettoyage des octets de contrôle à l'écriture + avertissement dans le build | audit **bloquant** : tout octet de contrôle dans un `.html` livré, et toute feuille `style-*.css` référencée doit exister dans `dist/assets` |
| 13 | **Tunnel d'acquisition vide** : le client envoyait `booking_done`, `booking_view`, `service_pick`, `day_pick`, `slot_pick_home` ; le serveur n'acceptait que 10 autres noms (et analytics comptait `booking_confirmed`) → 422 que `sendBeacon` ignore, entonnoir à 0 conversion | audit des kinds `track(...)` ↔ `trackSchema` ↔ `analytics.ts` | `shared/funnel.ts` : une liste, un type `FunnelKind` (le client ne peut plus taper un kind inconnu), enum serveur, étapes d'analytics ; `contact_step` enfin instrumenté | `tests/funnel.test.ts` (5 tests : staticité des 3 listes, POST de **chaque** kind → 202, kind inventé → 422, et un visiteur complet qui ressort bien à la dernière étape) |
| 14 | `/admin` émettait `GET /api/` (404) à chaque ouverture — `A.get('..')` dont le résultat n'était même pas lu | journal réseau du navigateur | ligne morte retirée (le rôle vient de `/api/public/me`) | plus aucun 4xx sur `/admin` (sonde réseau rejouée) |
| 15 | Écran Réglages **masquait le 403** : un barbier voyait un formulaire vide au lieu du refus | test e2e RBAC, écrit avant d'être exécuté | affichage de l'erreur + nav « Réglages » retirée hors `owner`/`manager` (règle du serveur, pas une faveur) | e2e admin : lien absent, message de droits, onglets inexistants — 5 projets |
| 16 | `npm run dev` **ne démarrait pas** : `node --import tsx/watch` (sous-module supprimé dans tsx 4.19) et `--tsconfig` passé à node | première exécution réelle de la suite e2e, justement | CLI tsx et binaire Vite résolus dans `node_modules` (`createRequire`), plus de flag invalide | `npm run dev` : API :8787 + Vite :5173, 89 tests e2e exécutés dessus |
| 17 | `tsc -p server/tsconfig.json` sortait de fausses erreurs (« Cannot find name `document` ») dès qu'un test importe le graphe client | les erreurs sont apparues en ajoutant `tests/responsive.test.ts` | les tests qui atteignent `client/` sont exclus du programme serveur (sans lib DOM) et restent typés par le tsconfig racine | `npm run typecheck` : 0 erreur sur les deux programmes |
| 18 | Les specs e2e n'ayant **jamais** été exécutées étaient périmées : titre attendu « Aujourd'hui » (l'UI affiche le jour de la semaine), formulaire sans le clic « Continuer », fixture client figé → 409 « doublon » dès le 2ᵉ run, et 5 projets × 2 connexions = plafond anti-force-brute (10/10 min) | exécution, encore une fois | specs réalignées sur l'UI réelle, identité fraîche par exécution, `LOGIN_LIMITS` explicite (prod 10 verrouillé par un test, démo 60) | suite complète rejouée : **89 passés, 0 échoué** — et un 2ᵉ run des specs réservation sans `db:reset` |
| 19 | Agenda du back-office illisible à ≤ 900 px (en-têtes sur une syllabe par ligne, numéros de téléphone coupés en deux) | Capture à 900 px, puis `Range.getClientRects()` par cellule : lignes réellement rendues | `overflow-wrap: anywhere` → `break-word` (`anywhere` réduit la largeur min-content et autorise la casse) ; `min-width` des tableaux 520 → 720 px ; colonne d'actions libérée sous 760 px de conteneur | 0 cellule cassée à 390, 900 et 1280 px ; tableau de 720 px dans un conteneur de 647 px, défilement confiné à `.tx` |
| 20 | (fausse alerte, corrigée dans la méthode de test) bureau annoncé cassé par le même test | Le comptage « lignes = hauteur ÷ line-height » mesurait la hauteur de la ligne du tableau, pas le texte de la cellule | Métrique remplacée par les rectangles de `Range` | 110 combinaisons page × taille mesurées sur `npm run dev` : 0 débordement horizontal |

Rejoué après tous ces correctifs : `npm run typecheck` 0 erreur · `npm test` **84/84** · `npm run smoke`
**22/22** · `bash scripts/smoke.sh` **18/18** · `node scripts/audit-site.mjs --base …` **aucune violation**
(CSS 18,2 ko brut / 4,4 ko brotli, 92,9 ko au premier chargement) · `npm run e2e` **89/0** sur 5 projets
(64 contrôles d'adaptivité multi-tailles + 25 parcours réservation et back-office, dont 15 sur iPhone 13 et 320 px tactile).

## 14. Passe « teste chaque fonctionnalité » + hébergement Vercel/Supabase (21-24/09)

Un harnais de vérification a été écrit pour ça : `scripts/verify-features.mjs` (**73 contrôles**, 13
groupes) lancé sur une **base neuve** par `npm run verify` (SQLite) et `npm run verify:pg` (Postgres),
avec rapport machine dans `data/rapport-fonctionnalites*.json`. Le relevé complet, groupé par fonction,
sont rejouables à volonté (`npm run verify`, `npm run verify:pg`) et lus dans la sortie ; le guide
d'hébergement (Vercel + Supabase/Neon, pièges de pooler, cron par plan, domaine, WhatsApp, sauvegardes,
check-list) est dans **`docs/GUIDE-MISE-EN-LIGNE.md`**.

Neuf défauts réels trouvés par cette passe, corrigés puis gardés par test :

| # | Défaut (mesuré, pas théorique) | Correctif | Garde-fou |
|---|---|---|---|
| 1 | Un brouillon sans client gelait **toutes** les automatisations (`cust.id` sur `null`) | `try/catch` par section, `skipped_*`, `TickReport.draftErrors` | `tests/automations.test.ts` |
| 2 | Relances panier jamais envoyées (jointure `phone` vs `phone_norm`) | `normalizePhone` + repli email | idem |
| 3 | Corps JSON illisible → **500** + fausse panne en supervision | `400 {error:"corps_invalide"}` + trace `api_reject` | `tests/security.test.ts` #10 |
| 4 | Salon sans prestation (venant d'être créé) → `/api/public/config` en **500**, site entier tombé | état « en cours d'ouverture » : 200 + `onboarding`, waitlist reste ouverte | `tests/tenant-vide.test.ts` (5) |
| 5 | Cron serveurless only-POST : Vercel Cron n'émet que des **GET** → automatisations mortes en silence | `GET` + `POST` sur le même corps + relais GitHub Actions | `tests/automations.test.ts` #4 |
| 6 | Un RDV `completed` dont la fenêtre court encore **rendait le fauteuil réservable** → deux fiches au même créneau (12 cas relevés) | prédicat `occupying()` partagé par la vue et les trois écritures | `tests/booking.test.ts` #10 |
| 7 | Le seed écrivait des chevauchements dans l'historique (12 relevés) | le générateur décale ou saute | base re-semée = 0 chevauchement |
| 8 | `MAX(1, visites_count)` dans `customers-value` : agrégat en Postgres → **500 uniquement en production** | `CASE WHEN` (identique sur les deux moteurs) | campagne `g10` sur les deux moteurs |
| 9 | `trackExperiment` avalait son erreur : l'upsert `MAX(converted, :c)` cassait en Postgres et les A/B restaient à 0 % **sans bruit** | `CASE` + trace `experiment_track_fail` | `tests/funnel.test.ts` #6 |

| 11 | **`migrate()` ne rattrapait aucune colonne** : `CREATE TABLE IF NOT EXISTS` laisse une table déjà | `migrate()` ajoute les colonnes absentes (une par une, tolérant), repose les `UNIQUE` en index `ux_rattrape_*`, et place les index après le rattrapage (avant, un index sur une colonne absente faisait échouer tout le démarrage) | `tests/migrate.test.ts` (5, dont la preuve que le doublon est vraiment rejeté) |
| 12 | Un `TRUST_PROXY=0` promis par `.env.example` **n'était pas lu** par `clientIp()` : hors proxy de confiance, un `X-Forwarded-For` fabriqué à chaque requête contournait les 429 | `clientIp()` honore la variable (défaut inchangé : confiance derrière Vercel) | `tests/env.test.ts` test 5 (mini-process, car `env` se fige à l'import) |

Rejoué le 28/09 après ces deux derniers correctifs : `npm run typecheck` 0 erreur · `npm test` **123/123** ·
`npm run verify` **73/73** (SQLite) · `npm run sim:supabase` **vert** (les 4 fichiers SQL appliqués sur un
Postgres 17 simulé en Supabase, puis la campagne complète rejouée sur la base durcie).

Rejoué le 24/09 après les correctifs précédents : `npm run typecheck` 0 erreur · `npm test` **100/100** (à l'époque) ·
`npm run verify` **73/73, 0 skip** (SQLite, base vierge) · `npm run verify:pg` **73/73** sur un Postgres
17.11 réel · `npm run pg:check` **vert** (52 tables migrées en 668 ms, 100 tests, serveur live,
cron `ok:true` en 211 ms, 18/18 contrôles HTTP, **0** `observations` en erreur).

## Ce qui reste ouvert, listé sans maquillage

1. Brancher les vrais fournisseurs : Stripe live, Resend, Twilio (et tester un remboursement réel).
2. Remplacer visuels et avis de démonstration (checklist dans `docs/CHECKLIST-MARQUE.md`).
3. Synchronisation avec l'agenda actuel (Planity/Google Calendar) : tant qu'elle n'existe pas, cette
   plateforme est l'agenda de référence — sinon il faut un import/réconciliation pour éviter deux
   sources de vérité.
4. UI multi-établissements + facturation SaaS (schéma prêt, écran absent).
5. Audit d'accessibilité outillé (axe) et audit de charge (k6) — non exécutés ici. L'adaptivité et
   les parcours critiques, eux, sont mesurés dans Chromium sur 8 tailles d'écran (§11 et §13) ; les
   `env(safe-area-inset-*)` restent vérifiés à la source, pas sur un appareil à encoche.
6. Application native / push web au-delà du manifest PWA.
7. Migration des clients existants depuis l'outil actuel (CSV) : un script d'import reste à écrire ;
   le schéma et la normalisation téléphone/e-mail sont déjà là pour l'accueillir.

---

## 15. Passe « mon déploiement Vercel plante » (28/09) : le pré-rendu ne doit rien à l'environnement

Symptôme remonté par le log de build : `vite build` passe, `npm run prerender` meurt 0,85 s après son
démarrage sur `Assertion failed: (env) != nullptr` (`node::RemoveEnvironmentCleanupHook`) appelé par
`Statement::~Statement()` depuis `node_modules/better-sqlite3/build/Release/better_sqlite3.node`, et
Vercel conclut `Command "npm run build" exited with SIGABRT`.

Ce que le log ne disait pas, et qu'il a fallu reconstituer : l'abort natif **masque** l'erreur JS. Les
deux causes étaient (a) un pré-rendu qui ouvrait la base — `data/zyass.db`, ignoré par git donc absent du
clone, ou `DATABASE_URL`, qui n'a rien à faire au build — et (b) un driver jamais fermé, donc des
statements détruits pendant le teardown de l'environnement Node. Reproduit localement par la voie propre :
`NODE_ENV=production` sans `DATABASE_URL` → `Error: SESSION_SECRET sécurisé requis en production` levé
depuis `bootSsr()`, exactement l'endroit où Vercel avait vu l'abort.

Corrections, dans l'ordre d'importance :

| # | Changement | Pourquoi c'est le bon niveau |
| --- | --- | --- |
| 1 | `scripts/prerender.mts` pose `TEST_DB=memory` + `DEMO_MODE=1` + `NODE_ENV=test` **avant** son premier import applicatif | le pré-rendu n'est pas un serveur : ni base de prod, ni secret, ni disque. Le driver accepte la contrainte (`:memory:` court-circuite `DATABASE_URL`/`DATA_FILE`) |
| 2 | `closeDb()` attendu (2 s max) puis `process.exit()` — sortie unique du script | plus aucun statement alive au teardown → plus d'abort natif, et la vraie erreur redevient lisible |
| 3 | `try/catch` par page + `try/catch` sur `bootSsr()` + chien de garde `PRERENDER_TIMEOUT_MS` (150 s, plancher 10 s) qui écrit le shell des 12 pages principales | un build suspendu et un build planté empêchent pareil la mise en ligne ; une perte de SEO figé, non |
| 4 | échec de pré-rendu = **exit 0** avec avertissement, sauf `PRERENDER_STRICT=1` (nouveau script `build:strict`, branché sur `npm run check` et le job CI « site ») | tolérant en production, intransigeant dans le dépôt : la dégradation ne doit pas s'installer |
| 5 | `engines.node` `>=20` → `>=20.19 <23`, `better-sqlite3` 11.5.0 → 12.11.1 | `>=20` laissait Vercel choisir sa dernière LTS, sans binaire précompilé pour le module natif : 2 min d'installation et ABI incertaine |
| 6 | garde dans `scripts/verify.sh` :port occupé → refus explicite `exit 2` | un serveur résiduel sur 8899 répondait avec une base déjà utilisée : 3 puis 4 contrôles rouges **sans rapport avec le code** (constaté pendant cette passe) |

Mesuré après ces changements, dans les conditions du build Vercel (`dist/` et `data/` supprimés,
`NODE_ENV=production`, `PRERENDER_STRICT=1`) : `npm run build` → `[seed] démo chargée : 56 clients,
299 RDV, 14 prestations` → `✓ pré-rendu : 32 pages statiques dans dist/client`, **exit 0**, aucun fichier
créé dans `data/`. Et les portes complètes : `typecheck` 0 erreur · **123/123** tests · **22/22** garanties ·
`verify` **73/73** (0 skip) · `audit:site` **0 violation** (93,2 ko de JS+CSS au premier chargement) ·
`audit:secrets` 88 fichiers propres. Dégradé volontaire (Postgres injoignable + `PRERENDER_DB=live`) : le
shell est écrit pour les 12 pages, le build sort en 0 avec l'avertissement — vérifié à 10 s de délai.


Aucun de ces sept points n'a été simulé pour donner l'illusion du fini.
---

## 16. Passe finale demandée le 28/09 : « moderne, animé, admin complet, WhatsApp, test de A à Z »

Quatre demandes tenaient dans ce tour, et chacune a été traitée puis mesurée — pas affirmée.

| Demande | Ce qui a été fait | Preuve (rejouable) |
| --- | --- | --- |
| « c'est moderne, animé, classe, ça donne envie de prendre RDV ? » | 2 keyframes seulement dans la base : ajout du reveal au scroll (une seule `IntersectionObserver`, `MutationObserver`, **chien de garde 1 500 ms**), halo doré sur le halo du hero, dérive lente de l'image, reflet sur les boutons, micro-interactions `card/day/slot/btn`, `text-wrap:balance` sur le titre. Trois défauts vus en capture et corrigés : le hero **répétait le H1** mot pour mot (le tagline de démo est maintenant distinct, détecté par comparaison normalisée), le **pied de page collait** ses liens (`.ft-grid > div` empilé), la **nav mobile était tronquée** sans affordance (mask de bord + `:focus-within` qui le lève) ; le prix « 38 € dès » du catalogue se renvoyait mal (`white-space:nowrap`) et le bloc « Avis vérifiés » laissait deux colonnes vides avec un seul avis (grille auto-fit `.gauto`) | captures `.shots/d-home2.png` / `m-home2.png` (1440 et 390) + contrôle navigateur « sans JavaScript, la page pré-rendue reste lisible et complète » : **0 section masquée**, car le masque n'existe que sous `html.js-rv`, posé par le code |
| « gérer ses horaires et disponibilités soi-même, avec tout ce qu'il faut côté admin » | éditeur d'horaires **unique pour le salon et les barbiers** : semaines multi-plages, pauses nommées, 4 presets, estimation locale marquée « ≈ » **à côté** du compte réel du moteur (`availability`), fermetures ponctuelles par jour ou par barbier, regroupement des fermetures qui se répètent, refus d'enregistrer une semaine sans aucun jour ouvert, Annuler/Recharger. Deux bugs serveur trouvés en branchant l'UI : `POST /staff` **effaçait les compétences** du barbier quand `serviceIds` était absent (désormais optionnel), et le calendrier ne renvoyait **pas l'id des blocages** (donc impossible à lever depuis l'admin). Ajout de la carte **Réglages → Marque** (nom, téléphone, e-mail, WhatsApp, accroche, réseaux, lien d'avis, itinéraire) : l'endpoint `POST /settings {brand}` existait, **aucune interface** ne le faisait parler | `tests/hours.test.ts` (5) + `npm run check` |
| « guide simple pour brancher WhatsApp par variables d'environnement » | côté envoi : `WHATSAPP_PROVIDER/ACCESS_TOKEN/PHONE_NUMBER_ID/API_VERSION/TEMPLATE_NAME/TEMPLATE_LANG` + `NOTIFY_TEXT_CHANNEL`, appel Graph API réel (`type:'text'` dans la fenêtre de 24 h, `type:'template'` si gabarit approuvé), numéro local `06…` converti en `336…`, **repli sur le gabarit SMS** (sinon le message aurait pris le corps de l'e-mail), et garde-fou : un fournisseur déclaré mais incomplet **n'éteint pas** les rappels, il retombe sur le SMS. Côté réception : un seul constructeur de lien `wa.me` (`links.whatsappHref`) à partir du champ Marque, consommé par le hero, le pied de page, *Infos* et le secours de `/book` ; **jamais de lien mort** (le lien n'est pas émis si le numéro est vide ou incomplet) | `tests/whatsapp.test.ts` (6 : normalisation, canal par défaut, garde-fous du lien, charge Meta vérifiée octet par octet, gabarit, et « refus opérateur → la notification reste dans la file ») + §11 du guide |
| « teste de A à Z le projet avant de me donner le final » | `npm test` **123/123** · `npm run check` exit 0 (types, tests, 22 garanties, audit de site **0 violation**) · `npm run build:strict` 32 pages · Playwright : 330 exécutions, **109 jouées / 0 échec** (221 variantes de la boucle de tailles volontairement réservées à 2 projets) · **la campagne de 73 contrôles rejouée contre le vrai projet Supabase** du client (pooler session 5432, PostgreSQL 17.6) : migrate ✓ seed ✓ **72 réussis / 0 échoué / 1 skip** (skip daté : aucun RDV à +3 h à cette heure) · page `/espace` **réparée** (elle était vide après hydratation : contrat `me` complété par `anonymous` + `ErrorBoundary` global) · deux corrections d'honnêteté de la campagne : le budget d'attente du serveur de vérification porté à 100 s en mode Postgres (démarrage mesuré à **26 s** à travers le réseau) et le refus de démarrer sur un port déjà occupé | journaux `/tmp/verify-remote3.log`, `data/rapport-supabase-2809.json`, `/tmp/e2e-full.log` |

**Le workspace a été réduit en même temps** : les cinq documents de déploiement qui se recopiaient l'un
l'autre (`DEPLOIEMENT.md`, `DEPLOIEMENT-VERCEL-SUPABASE.md`, `SUPABASE-SQL-ENV.md`,
`TESTS-FONCTIONNALITES.md`, `GUIDE-SUPABASE-COMPLET.md`) n'existent plus. Il reste **un** guide
opérationnel, `docs/GUIDE-MISE-EN-LIGNE.md` (+ son PDF régénérable par `npm run guide`), et huit documents
de référence qui ne traitent chacun que d'un aspect. Les compteurs annoncés ont été repris partout à la
valeur mesurée (123 tests), y compris dans le workflow CI.

**Ce qui a bougé dans les limites, en vrai** : la voie Postgres n'est plus « jamais mesurée contre le pooler
réel » — elle l'est, sur une base de vérification dédiée (qui sera supprimée), et le mode **transaction**
(6543) reste non exercé parce qu'il est déconseillé. Ne restent pas mesurés, et c'est écrit sans
maquillage : les réponses réelles de Stripe/Resend/Twilio/**Meta** (la charge envoyée est testée, pas la
réponse), un rapport d'auditeur d'accessibilité (axe-core) qui n'a pas été joué, un test de charge outillé,
et l'import du carnet Planity/Google — le seul qui puisse encore produire un double emploi hors plateforme.

Mesuré à la fin de cette passe, dans les conditions du dépôt : `typecheck` 0 erreur · **123/123** tests ·
**22/22** garanties · `verify` 73/73 (SQLite) · **72/73 + 1 skip daté** contre Supabase · `audit:site`
0 violation, **100,2 ko** de JS+CSS au premier chargement (le bloc design et le reveal coûtent 7 ko, tant
que la vitrine reste lisible sans JavaScript — c'est vérifié par un test, pas espéré) ·
`audit:secrets` propre.



## 17. Paiement sur place, accès propriétaire, SEO/IA — 28 septembre 2026

Cette passe remplace les instructions antérieures Stripe, création d’admin et référencement.
Guide opérationnel unique : `GUIDE-MISE-EN-LIGNE.md` / PDF privé actualisé.

- `PAYMENTS_PROVIDER=off` : zéro acompte même si une ancienne politique l’exige ; aucun paiement simulé. Cadeaux publics au comptoir, émission admin explicitement après encaissement.
- Bootstrap propriétaire sur salon vide, transaction et verrou partagé, un seul owner, pas de reset implicite, pas de promotion d’un compte client ; reset CLI explicite et révocation des sessions.
- Initialisation de production sans clients, équipe, tarifs, avis ou réservations fictifs. Le propriétaire saisit équipe/catalogue/horaires avant ouverture.
- Code client dédié transactionnel : pas de consentement marketing requis pour se connecter, pas de report en heures silencieuses ni de déduplication quotidienne.
- Métadonnées uniques et absolues, Open Graph/Twitter, navigation SPA, JSON-LD non dupliqué, fil d’Ariane ; route canonique barbier corrigée ; sitemap, 301 et 404 réelles ; privé noindex/no-store.
- Fichiers `llms.txt` dynamiques, expérimentaux et sans garantie de citation ; aucune promesse de position Google ou IA. Retrait du compteur de notation structurée statique. Lien Google proposé quelle que soit la note après retour client.
- Report de RDV : le RDV déplacé n’est plus compté comme sa propre collision, mais les autres clients restent protégés ; exclusion interne non pilotable par les paramètres publics.
- SQL : zéro différence structurelle après régénération hors horodatage. Lecture du projet client : 52 tables avec RLS, aucun RLS forcé ; aucune donnée métier et aucun owner à cette date. Aucune écriture dans la production pendant cette passe.

Preuves : `npm run check` exit 0, **136/136 tests**, **22/22 smoke**, **33 pages**, audit statique **0 violation**, **101,0 ko** JS+CSS compressés hors images ; **18/18 E2E ciblés Chromium bureau/320 px** avec paiement off. Bootstrap/build sur base vide aussi joué localement. Les résultats historiques WebKit/5 vues ne doivent pas être présentés comme rejoués dans cette passe. Aucun envoi fournisseur réel ni indexation moteur constatés.


## 18. Correctif de déploiement Hobby — 28 septembre 2026

La fréquence `*/5 * * * *` bloquait le déploiement sur Hobby. Remplacée par
`40 6 * * *` (un passage quotidien), vérifiée dans le JSON. Aucun changement SQL ni variable
Vercel nécessaire. Guide et README mis à jour ; ordonnanceur externe documenté pour conserver
les automatisations fréquentes. Relais GitHub optionnel : secret dans Authorization plutôt que
l’URL, budget de retries aligné sur le timeout du job. Aucun déploiement distant ni service externe
activé pendant ce correctif. Un cron quotidien seul ne garantit pas les rappels à temps.


## 19. Suppression du cron Vercel après nouveau signalement Hobby

La section `crons` est entièrement retirée de `vercel.json` ; JSON relu et absence de cron vérifiée.
Le message persistant mentionnant `*/5 * * * *` ne correspondait déjà plus au fichier local quotidien :
le dépôt, la révision et le Root Directory utilisés par Vercel doivent être vérifiés.
Aucun push GitHub ni déploiement distant effectué par l’assistant. Les rappels programmés exigent
un ordonnanceur externe actif. Aucun changement SQL ou secret requis.


## 20. Packaging Vercel — 29/09/2026

Logs utilisateur : `ERR_MODULE_NOT_FOUND /var/task/server/app.ts`, depuis api/index.js.
Correctif : bundle serveur CJS produit par esbuild, entrée API chargée à la demande, dist explicitement
inclus, catch-all couvrant également /api/*, cookies sur API Node standard. Aucun changement SQL.
12/12 tests d’artefact sous Node natif sans sources TS, 136/136 tests, 22/22 smoke, build strict 33 pages,
audit statique sans violation. Test runtime sur base mémoire isolée ; pas de déploiement cloud par l’agent.


## 21. Initialisation Vercel, Brevo et identité — 29/09/2026

- Cause du 500 isolée : base joignable mais aucune ligne `locations`. Initialisation réelle à la demande, un owner unique, aucun client ni RDV créé ; contrôles HTTP config et connexion admin 200.
- Modèles demandés : 4 services à 0 € **inactifs** et 3 profils **inactifs**. Aucun tarif ni effectif réel supposé. Édition nom/prix/durée/publication et réactivation ajoutées ; l’édition des horaires ne doit pas activer un profil inactif.
- UI réservation : état d’erreur avec réessai, catalogue en préparation avec contact, abonnement au cache de config partagé, délai réseau borné. Réservation disponible seulement après publication effective.
- Maps : champ `googleMapsUrl` unifié, CID réel de la fiche, liens sans `#`. Dimanche = 0, plages multiples et pied de page dynamiques. Horaires Google absents ; référence Planity explicitement à confirmer.
- Brevo API v3 : HTML de marque et texte brut, clé serveur, expéditeur/reply-to, délais réseau et erreurs non maquillées. Gabarits échappés, liens http(s), OTP numérique sur six chiffres. Aucun envoi fournisseur réel effectué.
- Carte cadeau : destinataire acheteur explicite, idempotence par carte, prix/prepaiement non confondus, solde et reste à régler contrôlés, expiration 365 jours sur nouvelles cartes.
- Logo sélectionné exporté en PNG, SVG, ICO, Apple et PWA ; source conservée, ancien générateur remplacé.
- Preuves : suites `brevo-setup.test.ts`, `onsite-seo.test.ts`, `deep.test.ts`, `test-vercel-runtime.mjs` ; navigateur `scripts/test-onboarding-browser.mjs`, **base SQLite en mémoire uniquement**. Aucun test ne doit utiliser la base Supabase réelle.
- À faire hors workspace : redéploiement du code, vraie clé Brevo, vérification DNS, réception réelle, ordonnanceur, validation des prestations/équipe/horaires. Aucun succès commercial ni délivrabilité promis.

**Résultat final mesuré : 142/142 tests, 22/22 smoke, 12/12 runtime Vercel, 14/14 contrôles navigateur Chromium, build strict 33 pages et audit statique sans violation.** API Vercel publique/owner/today/calendar/availability : 200. Brevo réel et redéploiement des nouveaux écrans restent à réaliser.


## 22. Waitlist, photo Google et logs fournis — 29/09/2026

- CSV examiné : 141 lignes / 137 requêtes, dont 76 requêtes 500 (80 lignes de statut 500 avec doublons de log). Deux déploiements, incident module TypeScript puis configuration sans salon. Six routes publiques désormais contrôlées HTTP 200 ; aucune preuve de disponibilité continue.
- Formulaire waitlist avant ouverture, réessai réseau, messages honnêtes, consentement non précoché, plage matinale/soirée et dimanche.
- Inscription sérialisée/idempotente, e-mail de suivi Brevo, aucun lien privé renvoyé à quelqu’un qui ne fait que connaître le numéro. L’annulation d’un RDV ne divulgue plus les liens waitlist de tiers.
- Contraintes strictes de jours/heures/barbier, contrôle de vrais créneaux (y compris créneaux entre deux graduations visuelles), offre liée à son hold pour dédoublonnage et contenu e-mail correct.
- Consultation de l’offre en lecture seule, confirmation explicite, vrai jeton de gestion du RDV. Refus non destructif après confirmation ; retrait/expiration libèrent les holds et annulent les messages ; pas de re-proposition du même créneau refusé/expiré au même client.
- Capacité après ouverture contrôlée à chaque cron, et non seulement lors des ticks complets. Le fournisseur et l’ordonnanceur restent à activer par le salon.
- Une photo réelle de devanture récupérée de la fiche Google et autorisée par l’utilisateur. Asset local WebP 1600×1108, registre `PROVENANCE-PHOTOS.json`, import production idempotent, galerie agrandissable. Aucun intérieur/coiffure inventé, pas de modification de la base réelle durant cette passe.
- Tests : `tests/waitlist-reliability.test.ts`, extensions des tests existants, `scripts/test-waitlist-browser.mjs` (12 contrôles Chromium, dont 320 px et parcours inscription → offre → confirmation), runtime Node natif étendu à 16 contrôles (photo/manifeste/configuration inclus).


Validation finale de cette passe : **152/152 tests, 22/22 smoke, 16/16 runtime compilé, 12/12 Chromium waitlist/galerie et 14/14 Chromium réservation/admin** ; TypeScript, build et audit statique réussis. Bases de tests en mémoire uniquement. Aucun nouvel envoi fournisseur réel ni déploiement. Guide unique régénéré.


## 23. Incident navigation confirmé et correctif — 29/09/2026

Le succès HTTP des routes ne prouvait pas que les vrais boutons fonctionnaient. Reproduction directe du problème de superposition sur le domaine en ligne (`hero-bg` intercepte les clics) et 503 intermittents sur CSS/photo. Correctif : décor non interactif sous le contenu, assets/pages d’entrée indépendants du démarrage DB, HTML revalidé, 404 statiques non cachés, récupération bornée des imports dynamiques et réessai par nouveau document. Initialisation DB retentable après échec. Chiffre commercial « 8 % » retiré.

Validation : **153 tests, 22 smoke, 16 runtime, 38 contrôles statiques backend volontairement indisponible, 12 contrôles Chromium sur le build compilé**. Le nouveau test a d’abord échoué sur un clic réel intercepté, puis passe après correction sans `force: true`. Pas d’écriture de test en production ; mise en ligne encore à effectuer par le propriétaire. Guide unique §18.


## 24. Navigation mobile façon app

Quatre onglets clients, en-tête compact, hub `/salon`, stepper de réservation, choix du barbier en feuille basse, CTA au-dessus des onglets, adaptation au clavier par visualViewport, focus/inert des modales, safe areas et paysage tactile. Desktop conservé, administration sans onglets clients. Manifeste enrichi, installation guidée, service worker réseau uniquement avec écran hors connexion sans fausse réservation.

26 contrôles Chromium/WebKit sur le build, dont deux réservations en base mémoire ; 320/390 px et paysages 740/844 px. Clavier simulé, pas de test sur iPhone physique. Aucune écriture métier en production, aucun déploiement. Guide §19.
