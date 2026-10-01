# Sécurité

Modèle : le client est **toujours non fiable**. Tout ce qui a une valeur (créneau, prix, points,
carte cadeau, droits) est redécidé côté serveur, dans une transaction, à partir de la base.

## Surface et garde-fous

| Menace | Contre-mesure (fichier) | Vérifié par |
|---|---|---|
| Double réservation / course | transaction + **garde d'écriture tenue jusqu'au commit** (SQLite) / `pg_advisory_xact_lock` (Postgres) + index unique partiel `ux_appt_slot`, collision traduite en 409 et non en 500 (`db/driver.ts`, `db/index.ts`, `domain/booking.ts`) | `tests/deep.test.ts` (10 requêtes simultanées → un seul 201, zéro 5xx ; insertion SQL directe rejetée), `tests/booking.test.ts`, `scripts/smoke.sh` (sonde HTTP) |
| IDOR (deviner un id) | routes client par session, routes de gestion par jeton signé contenant l'identité du client ; un objet d'un autre → 404 (pas 403 : pas d'énumération) (`routes.ts`) | `tests/security.test.ts`, smoke |
| Force brute connexion | codes 6 chiffres, 10 min, 5 essais, seaux de jetons persistés en base (`lib/security.ts` `rateLimit`) | `tests/security.test.ts` |
| Bourrage de réservation / bot | seaux de jetons **persistés** (`rate_buckets`, clé `rl:<bucket>`) : `book:{ip}` 12/10 min, `wl:{ip}` 8/h, `gift:{ip}` 6/h, `code:<target>` 4/15 min, `login:{ip}` 10/10 min, plafond de RDV actifs, doublon même client-même créneau. La lecture (config, disponibilité) n'est pas plafonnée : on ne punit pas un curieux | `tests/deep.test.ts` (un seau saturé laisse les autres ouverts) |
| XSS stocké | aucun token dans `localStorage` ; `cleanText()` retire les balises et les protocoles à l'écriture ; le rendu React échappe à la lecture | `tests/inputs.test.ts`, `tests/security.test.ts` |
| SQLi | requêtes paramétrées nommées partout (`db/driver.ts`), aucun `template` SQL avec de l'entrée utilisateur | `tests/security.test.ts` |
| XSS par injection de balise | CSP sans `unsafe-inline` côté script (`script-src 'self'`) : le build ne produit **aucun** script inline exécutable (le JSON-LD est un bloc `application/ld+json`, une donnée) ; `style-src` garde `'unsafe-inline'` parce que les styles React en ligne sont inline — retirer cette autorisation casserait toute la mise en page (`lib/security.ts`) | `tests/security.test.ts` (assertion négative : pas d’unsafe-inline pour les scripts) |
| CSRF | cookie `SameSite=Lax` + `HttpOnly` + `Path=/` ; les liens d'action sont des GET **signés** et limité à une seule opération ; CSP `form-action 'self'` | `tests/security.test.ts` |
| Clickjacking / sniffing / fuite de referrer | `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy`, `COOP: same-origin` (`securityHeaders`) | `tests/security.test.ts`, smoke |
| Fuite d'information | erreurs de validation → 422 **sans** code interne ; 5xx → message neutre en prod, détail dans `observations` (`app.ts onError`) | `tests/booking.test.ts` |
| Secret dans le dépôt | `scripts/audit-secrets.mjs` (Stripe live, PEM, JWT, URLs Postgres avec mot de passe…) bloque la CI | `npm run audit:secrets` |
| Abus de cron | `POST /api/internal/cron` exigé `x-cron-secret` ; idempotent | smoke, `tests/security.test.ts` |
| Faux jetons | `signToken/verifyToken` (HMAC, `exp`, `jti`, portée `k`) pour gérer un RDV, réclamer une offre, confirmer | `tests/booking.test.ts`, `tests/waitlist.test.ts` |

## Mots de passe et sessions

- Hachage **scrypt** + sel par utilisateur (`lib/secrets.ts`) ; les mots de passe de démo ne sont
  jamais stockés en clair ni renvoyés.
- Session = opaque en base (`sessions`), pas de JWT à révoquer : suppression immédiate effective.
- Journal de consentement et d'audit séparés : `consents`, `audit_logs` (acteur, action, entité, avant/après).

## Ce que le back-office ne peut pas faire

- Un `staff` ne lit pas les réglages du salon, ne modifie pas l'équipe, pas les prestations, pas les
  automatisations (403). Un `manager` fait tout sauf la destruction de salle d'attente d'autres sites.
- Un client ne voit que ses rendez-vous, ses points, ses cartes ; l'export RGPD ne contient que sa ligne.
- Le back-office d'une `location` n'adresse pas une ressource d'une autre (`user.locationId` comparé au `ctx`).

## Deux verrous ajoutés après mesure (21-24/09)

- **Corps JSON illisible = 400, plus jamais 500.** `Content-Type: application/json` avec un corps vide ou
  cassé levait une `SyntaxError` non rattrapée : réponse 500, et surtout une ligne `observations`
  `status='error'` — la supervision criait « panne serveur » sur des robots qui POSTENT n'importe quoi.
  `onError` (`server/app.ts`) reconnaît maintenant le parseur et répond `400 {error:"corps_invalide"}`,
  tracé en `api_reject`. Verrouillé par `tests/security.test.ts` (test 10, sur `/api/public/booking`,
  `/track` et `/waitlist`).
- **`NODE_ENV=production` éteint le mode démo tout seul.** Le mode démo (seed automatique + comptes
  `owner@zyass.fr` / `demo-owner` + notifications stdout) valait par défaut tant qu'aucune variable
  n'était posée : un déploiement distrait laissait un accès back-office par mot de passe de démonstration
  branché sur la vraie base. `server/lib/env.ts` déduit désormais `demo` de la production, et
  `DEMO_MODE=1` redevient le seul moyen de le rallumer (staging assumé). Quatre tests dans
  `tests/env.test.ts`, dont « une production sans `DATABASE_URL` meurt au lieu de servir SQLite ».

## En production, checklist d'ouverture

1. `SESSION_SECRET`, `TOKEN_SECRET`, `CRON_SECRET` = 32+ octets aléatoires distincts (`openssl rand -hex 32`).
2. `APP_URL` en HTTPS (les liens signés des SMS en dépendent) et `TRUST_PROXY` si derrière un proxy.
3. Activer HSTS au niveau du domaine (Vercel le fait à la demande) et un CSP `report-to` pour surveiller.
4. Limite de débit fournie par l'infrastructure en plus de celle de l'app (Vercel WAF ou règle d'edge).
5. `audit:secrets` bloquant dans la CI, avec les clés réelles hors du dépôt (secrets Vercel).
6. Vérifier que la prod n'est PAS en mode démo : `curl /healthz` doit répondre `"demo":false` (sinon
   les comptes de démonstration sont actifs sur la base du salon).

## Ce que le client voit quand ça casse

- Erreur inattendue en **production** : `{error:"serveur"}` + message générique, sans pile ni détail de
  schéma ; l'incident part dans `observations` (`kind='error'`) et le log serveur.
- Hors production seulement : message d'origine + 6 lignes de pile, pour ne pas debugger à l'aveugle en
  review app. La distinction est prise sur `env.isProd` (`server/app.ts`).
- Fichiers statiques : lecture confinée à `dist/client` (`resolve` + contrôle de préfixe), sondé par
  `scripts/smoke.sh` avec cinq URL de traversée encodée.
