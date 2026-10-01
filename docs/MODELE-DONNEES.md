# Modèle de données

51 tables, 64 index, dans `server/db/schema.ts` (SQL écrit à la main, pas d'ORM).
Un seul schéma, deux moteurs : le texte est traduit SQLite ⇄ Postgres par `db/driver.ts`
(`{{ID}}` → `INTEGER PRIMARY KEY AUTOINCREMENT` / `GENERATED ALWAYS AS IDENTITY`, `:nom` → `$1`).
`npm run migrate` est idempotent.

## Noyau réservation

```
tenants ─1:N─ locations ─1:N─ staff ─N:M─ services      (staff_skills)
                          ├─ working_hours / day_overrides / shift_breaks / blocks
                          ├─ offerings  (service × staff × durée × prix : ce qui est réellement vendu)
                          ├─ addons ─N:M─ appointment_addons
                          └─ appointments ─1:N─ appointment_events
```

- `appointments.status` : `held · pending_payment · booked · confirmed · waiting_client ·
  in_progress · completed · cancelled · no_show`. Les statuts **bloquants** sont énumérés une seule
  fois (`BLOCKING` dans `domain/availability.ts`) — plus de liste divergente entre le moteur et l'API.
- Contrainte d'unicité partielle `ux_appt_slot` : `UNIQUE (location_id, staff_id, start_ts) WHERE status IN
  (les six statuts bloquants)`. Un même barbier ne peut pas avoir deux RDV bloquants à la même minute,
  **même si une branche de code oublie de vérifier** (admin, import, walk-in, webhooks). Dernier rempart,
  après la transaction.
- `appointment_events` = journal immuable (créé, déplacé, rappelé, annulé, no-show, offre waitlist) :
  le patron peut comprendre n'importe quel RDV six mois plus tard.

## Clients et consentement

`customers` (avec `phone_norm`/`email_norm` canaux de dédoublonnage — la normalisation est testée,
c'est elle qui évite deux fiches pour un même client), `consents` (journal : finalité, canal,
accord, source, IP, user-agent — preuve RGPD), `customer_measurements` (habitudes de coupe),
`risk_flags`, `requests_deletion` (demandes d'export/suppression tracées jusqu'à l'exécution).

## Récupération et files

`waitlist` (jours, fenêtre, souplesse, `consent_contact`, compteur de notifications) →
`waitlist_offers` (créneau proposé, jeton signé, expiration, statut `pending · claimed · declined ·
expired`). Un offre = une ligne de `appointments` en `held` : le créneau est réellement retenu.

## Argent

`payments` (provider, intention, montant, statut, webhook brut reçu), `gift_cards` (montant, solde,
code, expiration, acheteur/bénéficiaire), `loyalty_ledger` + `loyalty_rewards` + `loyalty_redemptions`,
`memberships`, `referrals`. Les montants sont en **centimes entiers** partout — jamais de flottant.

## Automatisation et messagerie

`automations` (déclencheur, type d'action, config JSON, actif, cooldown, plafond hebdo, validation
manuelle requise), `templates` (par clé × canal × langue), `notifications` (file + historique :
`status`, `send_ts`, `sent_ts`, `delivered_ts`, `clicked_ts`, `idempotency_key` UNIQUE),
`scheduler_state` (dernier tick par moteur, pour rejouer sans répéter).

## Acquisition et mesure

`funnel_events` (`kind`, `visitor_id`, service, source/medium/campagne, session), `booking_drafts`
(panier abandonné → reprise en 1 clic, relancé une seule fois), `campaigns` + `campaign_recipients`,
`experiments` + `experiment_variants` + `experiment_assignments`, `walkins` (file d'attente physique).

## Back-office et sûreté

`audit_logs` (acteur, action, entité, avant/après), `observations` (erreurs 5xx et dégradation du
rate-limit : ce que le patron doit voir), `sessions`, `rate_buckets` (seaux de jetons persistés —
ils survivent à un froid de function), `login_codes` (hash + expiration + consommation),
`content_pages` (pages éditoriales + guides SEO, `body_json` + FAQ + SEO), `media`, `onboarding`.

## Ce qui est volontairement absent

Pas de table `availability` pré-calculée : la disponibilité est **dérivée**, elle ne peut donc pas
être fausse après un changement d'horaire. Pas de vue matérialisée de CA : les requêtes d'analytics
agrègent `appointments`/`payments` avec des index dédiés (30 jours ≈ quelques ms en local).
