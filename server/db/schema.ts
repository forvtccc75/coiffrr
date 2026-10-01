/**
 * Schéma — un seul modèle pour SQLite (dev/tests) et Postgres (prod Vercel + Neon/Supabase).
 * `{{ID}}` est remplacé par le type de clé autoincrémentée du moteur.
 * Conventions : epoch ms en BIGINT, montants en centimes (INTEGER), JSON en TEXT, booléens 0/1.
 */

const T = `
-- ── SaaS / multi-enseigne ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id {{ID}},
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'pro',
  status TEXT NOT NULL DEFAULT 'active',
  created_ts BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS locations (
  id {{ID}},
  tenant_id BIGINT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  legal_name TEXT,
  brand_json TEXT NOT NULL DEFAULT '{}',
  address_json TEXT NOT NULL DEFAULT '{}',
  hours_json TEXT NOT NULL DEFAULT '{}',
  policy_json TEXT NOT NULL DEFAULT '{}',
  features_json TEXT NOT NULL DEFAULT '{}',
  holidays_json TEXT NOT NULL DEFAULT '[]',
  timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
  phone TEXT,
  email TEXT,
  currency TEXT NOT NULL DEFAULT 'EUR',
  plan_status TEXT NOT NULL DEFAULT 'active',
  created_ts BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_locations_slug ON locations(slug);

CREATE TABLE IF NOT EXISTS users (
  id {{ID}},
  location_id BIGINT,
  email TEXT,
  phone TEXT,
  name TEXT,
  role_key TEXT NOT NULL DEFAULT 'customer',
  password_hash TEXT NOT NULL,
  staff_id BIGINT,
  is_active INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until BIGINT,
  last_login_ts BIGINT,
  created_ts BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users(lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_users_loc ON users(location_id, role_key);

-- ── Équipe, horaires, disponibilités ─────────────────────────────────
CREATE TABLE IF NOT EXISTS staff (
  id {{ID}},
  location_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  role_key TEXT NOT NULL DEFAULT 'staff',
  bio TEXT,
  title TEXT,
  avatar_url TEXT,
  color_hex TEXT NOT NULL DEFAULT '#E8C98A',
  commission_pct INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  accept_new_clients INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_ts BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_staff_slug ON staff(location_id, slug);

CREATE TABLE IF NOT EXISTS staff_skills (
  id {{ID}},
  staff_id BIGINT NOT NULL,
  service_id BIGINT NOT NULL,
  price_cents BIGINT,
  duration_min BIGINT,
  level TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_skill ON staff_skills(staff_id, service_id);

CREATE TABLE IF NOT EXISTS working_hours (
  id {{ID}},
  location_id BIGINT NOT NULL,
  staff_id BIGINT,
  dow BIGINT NOT NULL,
  start_min BIGINT NOT NULL,
  end_min BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_wh ON working_hours(location_id, staff_id, dow);

CREATE TABLE IF NOT EXISTS shift_breaks (
  id {{ID}},
  location_id BIGINT NOT NULL,
  staff_id BIGINT,
  dow BIGINT NOT NULL,
  start_min BIGINT NOT NULL,
  end_min BIGINT NOT NULL,
  label TEXT
);
CREATE INDEX IF NOT EXISTS ix_brk ON shift_breaks(location_id, staff_id, dow);

-- kind: closed | open | extra   (例外 de jour : fermeture, ouverture spéciale, créneaux ouverts à la volée)
CREATE TABLE IF NOT EXISTS day_overrides (
  id {{ID}},
  location_id BIGINT NOT NULL,
  staff_id BIGINT,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_min BIGINT,
  end_min BIGINT,
  reason TEXT,
  created_ts BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_override ON day_overrides(location_id, staff_id, day, kind);
CREATE INDEX IF NOT EXISTS ix_override_day ON day_overrides(location_id, day);

-- blocages ponctuels (pause, absence, congés, maintenance, événement privé)
CREATE TABLE IF NOT EXISTS blocks (
  id {{ID}},
  location_id BIGINT NOT NULL,
  staff_id BIGINT,
  start_ts BIGINT NOT NULL,
  end_ts BIGINT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'busy',
  reason TEXT,
  created_ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_blocks ON blocks(location_id, staff_id, start_ts, end_ts);

-- ── Catalogue ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS services (
  id {{ID}},
  location_id BIGINT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'coupe',
  short_desc TEXT,
  description TEXT,
  base_price_cents BIGINT NOT NULL,
  base_duration_min BIGINT NOT NULL,
  prep_min BIGINT NOT NULL DEFAULT 0,
  cleanup_min BIGINT NOT NULL DEFAULT 5,
  level TEXT NOT NULL DEFAULT 'tous',
  cover_media_id BIGINT,
  gender TEXT NOT NULL DEFAULT 'm',
  age TEXT NOT NULL DEFAULT 'adulte',
  is_active INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER NOT NULL DEFAULT 0,
  price_from_label TEXT,
  problem TEXT,
  solution TEXT,
  seo_title TEXT,
  seo_desc TEXT,
  faq_json TEXT NOT NULL DEFAULT '[]',
  updated_ts BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_service_key ON services(location_id, key);
CREATE INDEX IF NOT EXISTS ix_service_active ON services(location_id, is_active, display_order);

CREATE TABLE IF NOT EXISTS addons (
  id {{ID}},
  location_id BIGINT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price_cents BIGINT NOT NULL,
  duration_min BIGINT NOT NULL,
  category TEXT NOT NULL DEFAULT 'soin',
  is_active INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER NOT NULL DEFAULT 0,
  suggest_after_service_key TEXT,
  hint TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_addon_key ON addons(location_id, key);

-- prestation réservable = service (+ éventuel coiffeur) + suppléments pré-emballés
CREATE TABLE IF NOT EXISTS offerings (
  id {{ID}},
  location_id BIGINT NOT NULL,
  service_id BIGINT NOT NULL,
  staff_id BIGINT,
  addon_ids TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL,
  description TEXT,
  duration_min BIGINT NOT NULL,
  price_cents BIGINT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_popular INTEGER NOT NULL DEFAULT 0,
  max_per_slot INTEGER NOT NULL DEFAULT 0,
  photo_media_id BIGINT,
  display_order INTEGER NOT NULL DEFAULT 0,
  updated_ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_offering ON offerings(location_id, service_id, staff_id, is_active);

CREATE TABLE IF NOT EXISTS media (
  id {{ID}},
  location_id BIGINT NOT NULL,
  path TEXT NOT NULL,
  alt TEXT,
  kind TEXT NOT NULL DEFAULT 'photo',
  label TEXT,
  service_key TEXT,
  price_cents BIGINT,
  duration_min BIGINT,
  before_after INTEGER NOT NULL DEFAULT 0,
  aspect TEXT NOT NULL DEFAULT '4/5',
  ts BIGINT NOT NULL,
  like_count BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_media ON media(location_id, kind, service_key);

-- ── Clients / CRM ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id {{ID}},
  location_id BIGINT NOT NULL,
  user_id BIGINT,
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  phone_norm TEXT,
  email TEXT,
  email_norm TEXT,
  birth_day TEXT,
  gender TEXT,
  notes TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  address_city TEXT,
  preferred_staff_id BIGINT,
  preferred_service_id BIGINT,
  preferred_channel TEXT NOT NULL DEFAULT 'sms',
  language TEXT NOT NULL DEFAULT 'fr',
  consent_marketing_email INTEGER NOT NULL DEFAULT 0,
  consent_marketing_sms INTEGER NOT NULL DEFAULT 0,
  consent_marketing_whatsapp INTEGER NOT NULL DEFAULT 0,
  consent_terms_ts BIGINT,
  source TEXT,
  medium TEXT,
  campaign TEXT,
  landing TEXT,
  device TEXT,
  referrer TEXT,
  referred_by BIGINT,
  referral_code TEXT,
  visits_count BIGINT NOT NULL DEFAULT 0,
  cancelled_count BIGINT NOT NULL DEFAULT 0,
  noshow_count BIGINT NOT NULL DEFAULT 0,
  spent_cents BIGINT NOT NULL DEFAULT 0,
  loyalty_points BIGINT NOT NULL DEFAULT 0,
  loyalty_visits BIGINT NOT NULL DEFAULT 0,
  avg_days_between BIGINT,
  last_visit_ts BIGINT,
  next_visit_ts BIGINT,
  membership_status TEXT NOT NULL DEFAULT 'none',
  priority_until BIGINT,
  risk_score BIGINT NOT NULL DEFAULT 0,
  segment TEXT NOT NULL DEFAULT 'new',
  deleted_ts BIGINT,
  created_ts BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cust_phone ON customers(location_id, phone_norm) WHERE deleted_ts IS NULL AND phone_norm IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cust_email ON customers(location_id, email_norm) WHERE deleted_ts IS NULL AND email_norm IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cust_refcode ON customers(referral_code) WHERE referral_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_cust_seg ON customers(location_id, segment, last_visit_ts);
CREATE INDEX IF NOT EXISTS ix_cust_name ON customers(location_id, last_name, first_name);

CREATE TABLE IF NOT EXISTS consents (
  id {{ID}},
  location_id BIGINT NOT NULL,
  customer_id BIGINT,
  purpose TEXT NOT NULL,
  channel TEXT,
  granted INTEGER NOT NULL,
  source TEXT,
  ip TEXT,
  user_agent TEXT,
  policy_version TEXT NOT NULL DEFAULT 'v1',
  revoked_ts BIGINT,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_consent ON consents(location_id, customer_id, purpose, ts);

CREATE TABLE IF NOT EXISTS customer_measurements (
  id {{ID}},
  customer_id BIGINT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_meas ON customer_measurements(customer_id, key);

-- ── Rendez-vous ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
  id {{ID}},
  location_id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  offering_id BIGINT NOT NULL,
  service_id BIGINT NOT NULL,
  staff_id BIGINT NOT NULL,
  start_ts BIGINT NOT NULL,
  end_ts BIGINT NOT NULL,
  prep_end_ts BIGINT,
  status TEXT NOT NULL DEFAULT 'booked',
  price_cents BIGINT NOT NULL DEFAULT 0,
  deposit_cents BIGINT NOT NULL DEFAULT 0,
  deposit_status TEXT NOT NULL DEFAULT 'none',
  paid_cents BIGINT NOT NULL DEFAULT 0,
  add_on_cents BIGINT NOT NULL DEFAULT 0,
  duration_min BIGINT NOT NULL,
  confirm_required INTEGER NOT NULL DEFAULT 0,
  confirmed_ts BIGINT,
  needs_action INTEGER NOT NULL DEFAULT 0,
  is_walkin INTEGER NOT NULL DEFAULT 0,
  waitlist_offer_id BIGINT,
  gift_card_id BIGINT,
  source TEXT, medium TEXT, campaign TEXT, landing TEXT, device TEXT, referrer TEXT,
  client_ip TEXT,
  internal_note TEXT,
  cancel_reason TEXT,
  cancel_by TEXT,
  created_ts BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL,
  cancelled_ts BIGINT,
  noshow_ts BIGINT,
  completed_ts BIGINT,
  rescheduled_from BIGINT,
  rescheduled_count BIGINT NOT NULL DEFAULT 0,
  review_requested_ts BIGINT,
  review_status TEXT NOT NULL DEFAULT 'none',
  external_uid TEXT,
  reminder_offsets TEXT NOT NULL DEFAULT '[]',
  reminder_cursor BIGINT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_appt_uid ON appointments(external_uid) WHERE external_uid IS NOT NULL;
-- dernier rempart contre le double booking : deux rendez-vous bloquants ne peuvent pas
-- partager le même barbier à la même minute, même si une branche de code oublie de vérifier.
CREATE UNIQUE INDEX IF NOT EXISTS ux_appt_slot ON appointments(location_id, staff_id, start_ts)
  WHERE status IN ('held','pending_payment','booked','confirmed','waiting_client','in_progress');
CREATE INDEX IF NOT EXISTS ix_appt_staff ON appointments(staff_id, start_ts, status);
CREATE INDEX IF NOT EXISTS ix_appt_day ON appointments(location_id, start_ts, status);
CREATE INDEX IF NOT EXISTS ix_appt_cust ON appointments(customer_id, start_ts DESC);
CREATE INDEX IF NOT EXISTS ix_appt_open ON appointments(location_id, status, start_ts);

-- journal d'état du RDV ( traçabilité complète : création, rappel, confirmation, annulation, no-show, replay waitlist )
CREATE TABLE IF NOT EXISTS appointment_events (
  id {{ID}},
  appointment_id BIGINT NOT NULL,
  kind TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  actor_type TEXT NOT NULL DEFAULT 'system',
  actor_id BIGINT,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_aev ON appointment_events(appointment_id, ts);

-- ── Waitlist / file d'attente ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS waitlist (
  id {{ID}},
  location_id BIGINT NOT NULL,
  customer_id BIGINT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  phone_norm TEXT,
  email TEXT,
  service_id BIGINT,
  offering_id BIGINT,
  staff_id BIGINT,
  days TEXT NOT NULL DEFAULT '[]',
  window_start_min BIGINT,
  window_end_min BIGINT,
  flex_json TEXT NOT NULL DEFAULT '{}',
  note TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  queue_rank BIGINT NOT NULL DEFAULT 0,
  consent_contact INTEGER NOT NULL DEFAULT 1,
  source TEXT,
  token TEXT,
  notified_count BIGINT NOT NULL DEFAULT 0,
  created_ts BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL,
  fulfilled_ts BIGINT,
  closed_ts BIGINT
);
CREATE INDEX IF NOT EXISTS ix_wl ON waitlist(location_id, status, priority DESC, created_ts);
CREATE UNIQUE INDEX IF NOT EXISTS ux_wl_open ON waitlist(location_id, phone_norm, service_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS waitlist_offers (
  id {{ID}},
  waitlist_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  staff_id BIGINT NOT NULL,
  offering_id BIGINT NOT NULL,
  service_id BIGINT NOT NULL,
  start_ts BIGINT NOT NULL,
  end_ts BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  channel TEXT NOT NULL DEFAULT 'sms',
  token TEXT NOT NULL UNIQUE,
  expires_ts BIGINT NOT NULL,
  created_ts BIGINT NOT NULL,
  responded_ts BIGINT,
  appointment_id BIGINT,
  reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_offer_slot ON waitlist_offers(location_id, staff_id, start_ts) WHERE status IN ('pending','claimed');
CREATE INDEX IF NOT EXISTS ix_offer_wl ON waitlist_offers(waitlist_id, status);
CREATE INDEX IF NOT EXISTS ix_offer_exp ON waitlist_offers(status, expires_ts);

-- file d'attente walk-in (sans rendez-vous)
CREATE TABLE IF NOT EXISTS walkins (
  id {{ID}},
  location_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  service_id BIGINT,
  staff_id BIGINT,
  status TEXT NOT NULL DEFAULT 'waiting',
  queue_rank BIGINT NOT NULL,
  eta_min BIGINT,
  token TEXT,
  created_ts BIGINT NOT NULL,
  seated_ts BIGINT,
  done_ts BIGINT
);
CREATE INDEX IF NOT EXISTS ix_wi ON walkins(location_id, status, queue_rank);

-- ── Paiements / acomptes / cartes cadeaux / abonnements ──────────────
CREATE TABLE IF NOT EXISTS payments (
  id {{ID}},
  location_id BIGINT NOT NULL,
  appointment_id BIGINT,
  customer_id BIGINT,
  gift_card_id BIGINT,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'demo',
  provider_ref TEXT,
  amount_cents BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  failure_reason TEXT,
  idempotency_key TEXT UNIQUE,
  refund_of BIGINT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_ts BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_pay_appt ON payments(appointment_id, status);

CREATE TABLE IF NOT EXISTS gift_cards (
  id {{ID}},
  location_id BIGINT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  amount_cents BIGINT NOT NULL,
  balance_cents BIGINT NOT NULL,
  buyer_name TEXT,
  buyer_email TEXT,
  recipient_name TEXT,
  message TEXT,
  service_id BIGINT,
  status TEXT NOT NULL DEFAULT 'active',
  send_ts BIGINT,
  redeemed_ts BIGINT,
  redeemer_id BIGINT,
  payment_id BIGINT,
  expiry_ts BIGINT,
  created_ts BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  id {{ID}},
  location_id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  plan_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  price_cents BIGINT NOT NULL,
  visits_included BIGINT NOT NULL,
  visits_used BIGINT NOT NULL DEFAULT 0,
  started_ts BIGINT NOT NULL,
  renews_ts BIGINT,
  ended_ts BIGINT,
  priority INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_member ON memberships(location_id, customer_id, status);

-- ── Fidélité / parrainage / avis ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS loyalty_rewards (
  id {{ID}},
  location_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'discount',
  value_cents BIGINT NOT NULL DEFAULT 0,
  threshold_visits BIGINT NOT NULL DEFAULT 0,
  points_cost BIGINT NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  points_per_visit BIGINT NOT NULL DEFAULT 10,
  birthday_bonus_points BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id {{ID}},
  location_id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  points BIGINT NOT NULL,
  reason TEXT NOT NULL,
  appointment_id BIGINT,
  reward_id BIGINT,
  balance_after BIGINT NOT NULL DEFAULT 0,
  note TEXT,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ll ON loyalty_ledger(customer_id, ts);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ll_once ON loyalty_ledger(appointment_id, reason) WHERE appointment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS referrals (
  id {{ID}},
  location_id BIGINT NOT NULL,
  referrer_id BIGINT NOT NULL,
  referee_id BIGINT,
  code TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'link',
  status TEXT NOT NULL DEFAULT 'invited',
  first_book_ts BIGINT,
  first_visit_ts BIGINT,
  reward_referrer_cents BIGINT NOT NULL DEFAULT 0,
  reward_referee_cents BIGINT NOT NULL DEFAULT 0,
  granted_ts BIGINT,
  fraud_flag INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  created_ts BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ref_pair ON referrals(location_id, referrer_id, referee_id) WHERE referee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_ref_code ON referrals(location_id, code, status);

CREATE TABLE IF NOT EXISTS reviews (
  id {{ID}},
  location_id BIGINT NOT NULL,
  appointment_id BIGINT UNIQUE,
  customer_id BIGINT,
  rating BIGINT,
  title TEXT,
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'requested',
  visibility TEXT NOT NULL DEFAULT 'private',
  channel TEXT NOT NULL DEFAULT 'internal',
  public_url TEXT,
  staff_id BIGINT,
  service_id BIGINT,
  reply_text TEXT,
  reply_ts BIGINT,
  consent_publish INTEGER NOT NULL DEFAULT 0,
  created_ts BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_rev ON reviews(location_id, status, rating);

-- ── Notifications / automatisations / campagnes ─────────────────────
CREATE TABLE IF NOT EXISTS templates (
  id {{ID}},
  location_id BIGINT NOT NULL,
  key TEXT NOT NULL,
  channel TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'fr',
  subject TEXT,
  body_text TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_ts BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tpl ON templates(location_id, key, channel, lang);

CREATE TABLE IF NOT EXISTS notifications (
  id {{ID}},
  location_id BIGINT NOT NULL,
  customer_id BIGINT,
  appointment_id BIGINT,
  waitlist_offer_id BIGINT,
  template_key TEXT,
  kind TEXT NOT NULL,
  channel TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT,
  body_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  idempotency_key TEXT UNIQUE,
  action_token TEXT,
  error TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  send_ts BIGINT,
  created_ts BIGINT NOT NULL,
  sent_ts BIGINT,
  delivered_ts BIGINT,
  read_ts BIGINT,
  clicked_ts BIGINT,
  failed_ts BIGINT,
  campaign_id BIGINT
);
CREATE INDEX IF NOT EXISTS ix_notif_due ON notifications(status, send_ts, id);
CREATE INDEX IF NOT EXISTS ix_notif_cust ON notifications(location_id, customer_id, created_ts DESC);

CREATE TABLE IF NOT EXISTS automations (
  id {{ID}},
  location_id BIGINT NOT NULL,
  key TEXT NOT NULL,
  trigger_key TEXT NOT NULL,
  action_type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 1,
  cooldown_hours BIGINT NOT NULL DEFAULT 0,
  quiet_hours TEXT NOT NULL DEFAULT '{"from":"21:00","to":"08:30"}',
  max_per_week BIGINT NOT NULL DEFAULT 4,
  requires_owner_approval INTEGER NOT NULL DEFAULT 0,
  runs_count BIGINT NOT NULL DEFAULT 0,
  last_run_ts BIGINT,
  updated_ts BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_auto ON automations(location_id, key);

CREATE TABLE IF NOT EXISTS campaigns (
  id {{ID}},
  location_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'manual',
  segment_json TEXT NOT NULL DEFAULT '[]',
  template_key TEXT,
  channel TEXT NOT NULL DEFAULT 'sms',
  offer_text TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  scheduled_ts BIGINT,
  sent_ts BIGINT,
  counts_json TEXT NOT NULL DEFAULT '{}',
  created_by BIGINT,
  approved_by BIGINT,
  created_ts BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL,
  est_revenue_cents BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_camp ON campaigns(location_id, status, scheduled_ts);

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id {{ID}},
  campaign_id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  notification_id BIGINT,
  ts BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cr ON campaign_recipients(campaign_id, customer_id);

-- ── Brouillon de réservation (reprise / relance abandonment) ─────────
CREATE TABLE IF NOT EXISTS booking_drafts (
  id {{ID}},
  location_id BIGINT NOT NULL,
  visitor_id TEXT NOT NULL,
  session_id TEXT,
  offering_id BIGINT,
  staff_id BIGINT,
  addon_ids TEXT NOT NULL DEFAULT '[]',
  slot_start_ts BIGINT,
  first_name TEXT, last_name TEXT, phone TEXT, email TEXT, note TEXT,
  consent_marketing INTEGER NOT NULL DEFAULT 0,
  contact_ts BIGINT,
  source TEXT, medium TEXT, campaign TEXT, landing TEXT, device TEXT, referrer TEXT,
  step TEXT NOT NULL DEFAULT 'service',
  status TEXT NOT NULL DEFAULT 'open',
  recovered_ts BIGINT,
  expires_ts BIGINT NOT NULL,
  created_ts BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_draft_open ON booking_drafts(location_id, status, updated_ts);
CREATE INDEX IF NOT EXISTS ix_draft_visitor ON booking_drafts(visitor_id, status);

-- ── Analytics / acquisition / expérimentation ────────────────────────
CREATE TABLE IF NOT EXISTS funnel_events (
  id {{ID}},
  location_id BIGINT NOT NULL,
  visitor_id TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  step BIGINT NOT NULL DEFAULT 0,
  meta_json TEXT NOT NULL DEFAULT '{}',
  source TEXT, medium TEXT, campaign TEXT, landing TEXT, device TEXT, referrer TEXT,
  appointment_id BIGINT,
  path TEXT,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_funnel ON funnel_events(location_id, kind, ts);
CREATE INDEX IF NOT EXISTS ix_funnel_v ON funnel_events(visitor_id, ts);

CREATE TABLE IF NOT EXISTS experiments (
  id {{ID}},
  location_id BIGINT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  metric TEXT NOT NULL DEFAULT 'booking_rate',
  population_pct BIGINT NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'running',
  started_ts BIGINT NOT NULL,
  ended_ts BIGINT,
  min_sample BIGINT NOT NULL DEFAULT 200,
  created_ts BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_exp ON experiments(location_id, key);

CREATE TABLE IF NOT EXISTS experiment_variants (
  id {{ID}},
  experiment_id BIGINT NOT NULL,
  key TEXT NOT NULL,
  weight BIGINT NOT NULL DEFAULT 50,
  payload_json TEXT NOT NULL DEFAULT '{}',
  is_control INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_expv ON experiment_variants(experiment_id);

CREATE TABLE IF NOT EXISTS experiment_assignments (
  id {{ID}},
  experiment_key TEXT NOT NULL,
  variant_key TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  converted INTEGER NOT NULL DEFAULT 0,
  revenue_cents BIGINT NOT NULL DEFAULT 0,
  ts BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ea ON experiment_assignments(experiment_key, variant_key, visitor_id);
CREATE INDEX IF NOT EXISTS ix_ea_stat ON experiment_assignments(experiment_key, variant_key, converted);

CREATE TABLE IF NOT EXISTS observations (
  id {{ID}},
  location_id BIGINT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  ms BIGINT,
  status TEXT NOT NULL DEFAULT 'ok',
  meta_json TEXT NOT NULL DEFAULT '{}',
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_obs ON observations(location_id, kind, ts);

-- ── Sécurité / audit ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id {{ID}},
  location_id BIGINT,
  actor_type TEXT NOT NULL,
  actor_id BIGINT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id BIGINT,
  ip TEXT,
  user_agent TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit ON audit_logs(location_id, ts);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_ts BIGINT NOT NULL,
  expires_ts BIGINT NOT NULL,
  revoked_ts BIGINT,
  last_seen_ts BIGINT
);
CREATE INDEX IF NOT EXISTS ix_sess_user ON sessions(user_id, expires_ts);

CREATE TABLE IF NOT EXISTS rate_buckets (
  bucket_key TEXT PRIMARY KEY,
  tokens REAL NOT NULL,
  updated_ts BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_flags (
  id {{ID}},
  location_id BIGINT NOT NULL,
  customer_id BIGINT,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'low',
  detail_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open',
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_rf ON risk_flags(location_id, kind, status);

CREATE TABLE IF NOT EXISTS requests_deletion (
  id {{ID}},
  location_id BIGINT NOT NULL,
  customer_id BIGINT,
  email TEXT,
  phone TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  ip TEXT,
  ts BIGINT NOT NULL,
  done_ts BIGINT
);

-- ── Contenu éditorial (SEO / guides / FAQ) ───────────────────────────
CREATE TABLE IF NOT EXISTS content_pages (
  id {{ID}},
  location_id BIGINT NOT NULL,
  slug TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'guide',
  title TEXT NOT NULL,
  summary TEXT,
  body_json TEXT NOT NULL DEFAULT '[]',
  cover_media_id BIGINT,
  service_key TEXT,
  faq_json TEXT NOT NULL DEFAULT '[]',
  seo_title TEXT,
  seo_desc TEXT,
  is_published INTEGER NOT NULL DEFAULT 1,
  reading_min BIGINT NOT NULL DEFAULT 3,
  created_ts BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_content ON content_pages(location_id, slug);

CREATE TABLE IF NOT EXISTS onboarding (
  id {{ID}},
  location_id BIGINT NOT NULL,
  step TEXT NOT NULL,
  done_json TEXT NOT NULL DEFAULT '[]',
  ts BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_actions (
  id {{ID}},
  location_id BIGINT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_ts BIGINT NOT NULL,
  decided_ts BIGINT,
  decided_by BIGINT
);
CREATE INDEX IF NOT EXISTS ix_pa ON pending_actions(location_id, status, created_ts);

CREATE TABLE IF NOT EXISTS loyalty_redemptions (
  id {{ID}},
  customer_id BIGINT NOT NULL,
  reward_id BIGINT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'issued',
  issued_ts BIGINT NOT NULL,
  redeemed_ts BIGINT,
  appointment_id BIGINT
);

CREATE TABLE IF NOT EXISTS appointment_addons (
  id {{ID}},
  appointment_id BIGINT NOT NULL,
  addon_id BIGINT NOT NULL,
  price_cents BIGINT NOT NULL,
  duration_min BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_aa ON appointment_addons(appointment_id);

CREATE TABLE IF NOT EXISTS login_codes (
  id {{ID}},
  target TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'sms',
  code_hash TEXT NOT NULL,
  attempts BIGINT NOT NULL DEFAULT 0,
  consumed INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  created_ts BIGINT NOT NULL,
  expires_ts BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_lc ON login_codes(target, channel);
CREATE INDEX IF NOT EXISTS ix_lc_exp ON login_codes(expires_ts);

CREATE TABLE IF NOT EXISTS scheduler_state (
  key TEXT PRIMARY KEY,
  value BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL
);
`;

const TABLES = [...T.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);

export function ddlFor(kind: 'sqlite' | 'pg'): string[] {
  const idType = kind === 'pg' ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const text = T.replace(/\{\{ID\}\}/g, idType);
  const stmts: string[] = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (/^\s*--/.test(line) || !line.trim()) {
      buf = buf.trim() ? buf + '\n' : buf;
      continue;
    }
    buf += (buf.trim() ? ' ' : '') + line.trim();
    if (buf.trimEnd().endsWith(';')) {
      stmts.push(buf.trimEnd().replace(/;$/, ''));
      buf = '';
    }
  }
  if (buf.trim()) stmts.push(buf.trim());
  return stmts;
}

export const ALL_TABLES = TABLES;

/**
 * Règle d'écriture pour qu'une évolution du produit soit applicable sur une base VIVANTE : une colonne
 * ajoutée à une table déjà peuplée doit être NULLABLE ou porter un DEFAULT — sinon les deux moteurs la
 * refusent (`Cannot add a NOT NULL column with default value NULL`). Le rattrapage la signale alors en
 * clair (210 colonnes du schéma actuel sont dans ce cas : elles n'ont jamais eu à être ajoutées après
 * coup), mais ne peut pas la poser à votre place.
 *
 * Les colonnes que le schéma veut, table par table — sert à rattraper une base DÉJÀ PEUPLEMENT créée
 * à qui il manque des colonnes après une évolution du produit. `CREATE TABLE IF NOT EXISTS` ne fait
 * rien sur une table existante : sans ce rattrapage, une colonne ajoutée dans `schema.ts` n'arrive
 * jamais en production, et l'app meurt sur « column does not exist » seulement chez le client.
 * La colonne `id` est volontairement exclue (on ne peut pas ajouter une clé séquentielle après coup).
 */
export function wantedColumns(kind: 'sqlite' | 'pg'): Array<{ table: string; col: string; def: string }> {
  const idType = kind === 'pg' ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const text = T.replace(/\{\{ID\}\}/g, idType);
  const out: Array<{ table: string; col: string; def: string }> = [];
  const re = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g;
  const CONSTRAINT = /^(PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE|CONSTRAINT)\b/i;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const table = m[1];
    for (const raw of m[2].split('\n')) {
      const line = raw.trim().replace(/,\s*$/, '');
      if (!line || /^--/.test(line)) continue;
      const col = line.split(/\s+/)[0];
      if (CONSTRAINT.test(line) || col === 'id') continue;
      out.push({ table, col, def: line });
    }
  }
  return out;
}
