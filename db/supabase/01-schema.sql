-- ---------------------------------------------------------------------------
-- 01 - SCHEMA Postgres : 116 instructions, 51 tables
-- A executer en une fois dans l'editeur SQL de Supabase, sur une base vide.
-- Ce n'est pas obligatoire : l'app applique elle-meme ce schema a chaque demarrage
-- (getDriver() -> migrate(), server/db/index.ts). Ce fichier sert pour une installation manuelle,
-- un import depuis un autre Postgres, ou pour relire le schema sans lire le code.
-- Le schema n utilise aucune extension (pas de btree_gist) et aucun trigger : rien a installer avant.
-- Genere par npm run db:sql (script scripts/emit-sql.mts) le 2026-09-28 15:45 UTC.
-- Ne pas editer a la main : la source est server/db/schema.ts.
-- ---------------------------------------------------------------------------
BEGIN;

CREATE TABLE IF NOT EXISTS tenants ( id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'pro', status TEXT NOT NULL DEFAULT 'active', created_ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS locations ( id BIGSERIAL PRIMARY KEY, tenant_id BIGINT NOT NULL, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, legal_name TEXT, brand_json TEXT NOT NULL DEFAULT '{}', address_json TEXT NOT NULL DEFAULT '{}', hours_json TEXT NOT NULL DEFAULT '{}', policy_json TEXT NOT NULL DEFAULT '{}', features_json TEXT NOT NULL DEFAULT '{}', holidays_json TEXT NOT NULL DEFAULT '[]', timezone TEXT NOT NULL DEFAULT 'Europe/Paris', phone TEXT, email TEXT, currency TEXT NOT NULL DEFAULT 'EUR', plan_status TEXT NOT NULL DEFAULT 'active', created_ts BIGINT NOT NULL, updated_ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS users ( id BIGSERIAL PRIMARY KEY, location_id BIGINT, email TEXT, phone TEXT, name TEXT, role_key TEXT NOT NULL DEFAULT 'customer', password_hash TEXT NOT NULL, staff_id BIGINT, is_active INTEGER NOT NULL DEFAULT 1, failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until BIGINT, last_login_ts BIGINT, created_ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS staff ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL, role_key TEXT NOT NULL DEFAULT 'staff', bio TEXT, title TEXT, avatar_url TEXT, color_hex TEXT NOT NULL DEFAULT '#E8C98A', commission_pct INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, accept_new_clients INTEGER NOT NULL DEFAULT 1, display_order INTEGER NOT NULL DEFAULT 0, created_ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS staff_skills ( id BIGSERIAL PRIMARY KEY, staff_id BIGINT NOT NULL, service_id BIGINT NOT NULL, price_cents BIGINT, duration_min BIGINT, level TEXT )
;
CREATE TABLE IF NOT EXISTS working_hours ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, staff_id BIGINT, dow BIGINT NOT NULL, start_min BIGINT NOT NULL, end_min BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS shift_breaks ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, staff_id BIGINT, dow BIGINT NOT NULL, start_min BIGINT NOT NULL, end_min BIGINT NOT NULL, label TEXT )
;
CREATE TABLE IF NOT EXISTS day_overrides ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, staff_id BIGINT, day TEXT NOT NULL, kind TEXT NOT NULL, start_min BIGINT, end_min BIGINT, reason TEXT, created_ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS blocks ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, staff_id BIGINT, start_ts BIGINT NOT NULL, end_ts BIGINT NOT NULL, kind TEXT NOT NULL DEFAULT 'busy', reason TEXT, created_ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS services ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'coupe', short_desc TEXT, description TEXT, base_price_cents BIGINT NOT NULL, base_duration_min BIGINT NOT NULL, prep_min BIGINT NOT NULL DEFAULT 0, cleanup_min BIGINT NOT NULL DEFAULT 5, level TEXT NOT NULL DEFAULT 'tous', cover_media_id BIGINT, gender TEXT NOT NULL DEFAULT 'm', age TEXT NOT NULL DEFAULT 'adulte', is_active INTEGER NOT NULL DEFAULT 1, display_order INTEGER NOT NULL DEFAULT 0, price_from_label TEXT, problem TEXT, solution TEXT, seo_title TEXT, seo_desc TEXT, faq_json TEXT NOT NULL DEFAULT '[]', updated_ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS addons ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, description TEXT, price_cents BIGINT NOT NULL, duration_min BIGINT NOT NULL, category TEXT NOT NULL DEFAULT 'soin', is_active INTEGER NOT NULL DEFAULT 1, display_order INTEGER NOT NULL DEFAULT 0, suggest_after_service_key TEXT, hint TEXT )
;
CREATE TABLE IF NOT EXISTS offerings ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, service_id BIGINT NOT NULL, staff_id BIGINT, addon_ids TEXT NOT NULL DEFAULT '[]', name TEXT NOT NULL, description TEXT, duration_min BIGINT NOT NULL, price_cents BIGINT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, is_popular INTEGER NOT NULL DEFAULT 0, max_per_slot INTEGER NOT NULL DEFAULT 0, photo_media_id BIGINT, display_order INTEGER NOT NULL DEFAULT 0, updated_ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS media ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, path TEXT NOT NULL, alt TEXT, kind TEXT NOT NULL DEFAULT 'photo', label TEXT, service_key TEXT, price_cents BIGINT, duration_min BIGINT, before_after INTEGER NOT NULL DEFAULT 0, aspect TEXT NOT NULL DEFAULT '4/5', ts BIGINT NOT NULL, like_count BIGINT NOT NULL DEFAULT 0 )
;
CREATE TABLE IF NOT EXISTS customers ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, user_id BIGINT, first_name TEXT, last_name TEXT, phone TEXT, phone_norm TEXT, email TEXT, email_norm TEXT, birth_day TEXT, gender TEXT, notes TEXT, tags TEXT NOT NULL DEFAULT '[]', address_city TEXT, preferred_staff_id BIGINT, preferred_service_id BIGINT, preferred_channel TEXT NOT NULL DEFAULT 'sms', language TEXT NOT NULL DEFAULT 'fr', consent_marketing_email INTEGER NOT NULL DEFAULT 0, consent_marketing_sms INTEGER NOT NULL DEFAULT 0, consent_marketing_whatsapp INTEGER NOT NULL DEFAULT 0, consent_terms_ts BIGINT, source TEXT, medium TEXT, campaign TEXT, landing TEXT, device TEXT, referrer TEXT, referred_by BIGINT, referral_code TEXT, visits_count BIGINT NOT NULL DEFAULT 0, cancelled_count BIGINT NOT NULL DEFAULT 0, noshow_count BIGINT NOT NULL DEFAULT 0, spent_cents BIGINT NOT NULL DEFAULT 0, loyalty_points BIGINT NOT NULL DEFAULT 0, loyalty_visits BIGINT NOT NULL DEFAULT 0, avg_days_between BIGINT, last_visit_ts BIGINT, next_visit_ts BIGINT, membership_status TEXT NOT NULL DEFAULT 'none', priority_until BIGINT, risk_score BIGINT NOT NULL DEFAULT 0, segment TEXT NOT NULL DEFAULT 'new', deleted_ts BIGINT, created_ts BIGINT NOT NULL, updated_ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS consents ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, customer_id BIGINT, purpose TEXT NOT NULL, channel TEXT, granted INTEGER NOT NULL, source TEXT, ip TEXT, user_agent TEXT, policy_version TEXT NOT NULL DEFAULT 'v1', revoked_ts BIGINT, ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS customer_measurements ( id BIGSERIAL PRIMARY KEY, customer_id BIGINT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS appointments ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, customer_id BIGINT NOT NULL, offering_id BIGINT NOT NULL, service_id BIGINT NOT NULL, staff_id BIGINT NOT NULL, start_ts BIGINT NOT NULL, end_ts BIGINT NOT NULL, prep_end_ts BIGINT, status TEXT NOT NULL DEFAULT 'booked', price_cents BIGINT NOT NULL DEFAULT 0, deposit_cents BIGINT NOT NULL DEFAULT 0, deposit_status TEXT NOT NULL DEFAULT 'none', paid_cents BIGINT NOT NULL DEFAULT 0, add_on_cents BIGINT NOT NULL DEFAULT 0, duration_min BIGINT NOT NULL, confirm_required INTEGER NOT NULL DEFAULT 0, confirmed_ts BIGINT, needs_action INTEGER NOT NULL DEFAULT 0, is_walkin INTEGER NOT NULL DEFAULT 0, waitlist_offer_id BIGINT, gift_card_id BIGINT, source TEXT, medium TEXT, campaign TEXT, landing TEXT, device TEXT, referrer TEXT, client_ip TEXT, internal_note TEXT, cancel_reason TEXT, cancel_by TEXT, created_ts BIGINT NOT NULL, updated_ts BIGINT NOT NULL, cancelled_ts BIGINT, noshow_ts BIGINT, completed_ts BIGINT, rescheduled_from BIGINT, rescheduled_count BIGINT NOT NULL DEFAULT 0, review_requested_ts BIGINT, review_status TEXT NOT NULL DEFAULT 'none', external_uid TEXT, reminder_offsets TEXT NOT NULL DEFAULT '[]', reminder_cursor BIGINT NOT NULL DEFAULT 0 )
;
CREATE TABLE IF NOT EXISTS appointment_events ( id BIGSERIAL PRIMARY KEY, appointment_id BIGINT NOT NULL, kind TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}', actor_type TEXT NOT NULL DEFAULT 'system', actor_id BIGINT, ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS waitlist ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, customer_id BIGINT, name TEXT NOT NULL, phone TEXT NOT NULL, phone_norm TEXT, email TEXT, service_id BIGINT, offering_id BIGINT, staff_id BIGINT, days TEXT NOT NULL DEFAULT '[]', window_start_min BIGINT, window_end_min BIGINT, flex_json TEXT NOT NULL DEFAULT '{}', note TEXT, priority INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', queue_rank BIGINT NOT NULL DEFAULT 0, consent_contact INTEGER NOT NULL DEFAULT 1, source TEXT, token TEXT, notified_count BIGINT NOT NULL DEFAULT 0, created_ts BIGINT NOT NULL, updated_ts BIGINT NOT NULL, fulfilled_ts BIGINT, closed_ts BIGINT )
;
CREATE TABLE IF NOT EXISTS waitlist_offers ( id BIGSERIAL PRIMARY KEY, waitlist_id BIGINT NOT NULL, location_id BIGINT NOT NULL, staff_id BIGINT NOT NULL, offering_id BIGINT NOT NULL, service_id BIGINT NOT NULL, start_ts BIGINT NOT NULL, end_ts BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', channel TEXT NOT NULL DEFAULT 'sms', token TEXT NOT NULL UNIQUE, expires_ts BIGINT NOT NULL, created_ts BIGINT NOT NULL, responded_ts BIGINT, appointment_id BIGINT, reason TEXT )
;
CREATE TABLE IF NOT EXISTS walkins ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, name TEXT NOT NULL, phone TEXT, service_id BIGINT, staff_id BIGINT, status TEXT NOT NULL DEFAULT 'waiting', queue_rank BIGINT NOT NULL, eta_min BIGINT, token TEXT, created_ts BIGINT NOT NULL, seated_ts BIGINT, done_ts BIGINT )
;
CREATE TABLE IF NOT EXISTS payments ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, appointment_id BIGINT, customer_id BIGINT, gift_card_id BIGINT, kind TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'demo', provider_ref TEXT, amount_cents BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', failure_reason TEXT, idempotency_key TEXT UNIQUE, refund_of BIGINT, meta_json TEXT NOT NULL DEFAULT '{}', created_ts BIGINT NOT NULL, updated_ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS gift_cards ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, code TEXT NOT NULL UNIQUE, amount_cents BIGINT NOT NULL, balance_cents BIGINT NOT NULL, buyer_name TEXT, buyer_email TEXT, recipient_name TEXT, message TEXT, service_id BIGINT, status TEXT NOT NULL DEFAULT 'active', send_ts BIGINT, redeemed_ts BIGINT, redeemer_id BIGINT, payment_id BIGINT, expiry_ts BIGINT, created_ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS memberships ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, customer_id BIGINT NOT NULL, plan_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', price_cents BIGINT NOT NULL, visits_included BIGINT NOT NULL, visits_used BIGINT NOT NULL DEFAULT 0, started_ts BIGINT NOT NULL, renews_ts BIGINT, ended_ts BIGINT, priority INTEGER NOT NULL DEFAULT 0 )
;
CREATE TABLE IF NOT EXISTS loyalty_rewards ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, name TEXT NOT NULL, description TEXT, kind TEXT NOT NULL DEFAULT 'discount', value_cents BIGINT NOT NULL DEFAULT 0, threshold_visits BIGINT NOT NULL DEFAULT 0, points_cost BIGINT NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, points_per_visit BIGINT NOT NULL DEFAULT 10, birthday_bonus_points BIGINT NOT NULL DEFAULT 0 )
;
CREATE TABLE IF NOT EXISTS loyalty_ledger ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, customer_id BIGINT NOT NULL, points BIGINT NOT NULL, reason TEXT NOT NULL, appointment_id BIGINT, reward_id BIGINT, balance_after BIGINT NOT NULL DEFAULT 0, note TEXT, ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS referrals ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, referrer_id BIGINT NOT NULL, referee_id BIGINT, code TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'link', status TEXT NOT NULL DEFAULT 'invited', first_book_ts BIGINT, first_visit_ts BIGINT, reward_referrer_cents BIGINT NOT NULL DEFAULT 0, reward_referee_cents BIGINT NOT NULL DEFAULT 0, granted_ts BIGINT, fraud_flag INTEGER NOT NULL DEFAULT 0, ip TEXT, created_ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS reviews ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, appointment_id BIGINT UNIQUE, customer_id BIGINT, rating BIGINT, title TEXT, comment TEXT, status TEXT NOT NULL DEFAULT 'requested', visibility TEXT NOT NULL DEFAULT 'private', channel TEXT NOT NULL DEFAULT 'internal', public_url TEXT, staff_id BIGINT, service_id BIGINT, reply_text TEXT, reply_ts BIGINT, consent_publish INTEGER NOT NULL DEFAULT 0, created_ts BIGINT NOT NULL, updated_ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS templates ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, key TEXT NOT NULL, channel TEXT NOT NULL, lang TEXT NOT NULL DEFAULT 'fr', subject TEXT, body_text TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, updated_ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS notifications ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, customer_id BIGINT, appointment_id BIGINT, waitlist_offer_id BIGINT, template_key TEXT, kind TEXT NOT NULL, channel TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT, body_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', idempotency_key TEXT UNIQUE, action_token TEXT, error TEXT, meta_json TEXT NOT NULL DEFAULT '{}', send_ts BIGINT, created_ts BIGINT NOT NULL, sent_ts BIGINT, delivered_ts BIGINT, read_ts BIGINT, clicked_ts BIGINT, failed_ts BIGINT, campaign_id BIGINT )
;
CREATE TABLE IF NOT EXISTS automations ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, key TEXT NOT NULL, trigger_key TEXT NOT NULL, action_type TEXT NOT NULL, name TEXT NOT NULL, description TEXT, config_json TEXT NOT NULL DEFAULT '{}', is_active INTEGER NOT NULL DEFAULT 1, cooldown_hours BIGINT NOT NULL DEFAULT 0, quiet_hours TEXT NOT NULL DEFAULT '{"from":"21:00","to":"08:30"}', max_per_week BIGINT NOT NULL DEFAULT 4, requires_owner_approval INTEGER NOT NULL DEFAULT 0, runs_count BIGINT NOT NULL DEFAULT 0, last_run_ts BIGINT, updated_ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS campaigns ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'manual', segment_json TEXT NOT NULL DEFAULT '[]', template_key TEXT, channel TEXT NOT NULL DEFAULT 'sms', offer_text TEXT, status TEXT NOT NULL DEFAULT 'draft', scheduled_ts BIGINT, sent_ts BIGINT, counts_json TEXT NOT NULL DEFAULT '{}', created_by BIGINT, approved_by BIGINT, created_ts BIGINT NOT NULL, updated_ts BIGINT NOT NULL, est_revenue_cents BIGINT NOT NULL DEFAULT 0 )
;
CREATE TABLE IF NOT EXISTS campaign_recipients ( id BIGSERIAL PRIMARY KEY, campaign_id BIGINT NOT NULL, customer_id BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', notification_id BIGINT, ts BIGINT )
;
CREATE TABLE IF NOT EXISTS booking_drafts ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, visitor_id TEXT NOT NULL, session_id TEXT, offering_id BIGINT, staff_id BIGINT, addon_ids TEXT NOT NULL DEFAULT '[]', slot_start_ts BIGINT, first_name TEXT, last_name TEXT, phone TEXT, email TEXT, note TEXT, consent_marketing INTEGER NOT NULL DEFAULT 0, contact_ts BIGINT, source TEXT, medium TEXT, campaign TEXT, landing TEXT, device TEXT, referrer TEXT, step TEXT NOT NULL DEFAULT 'service', status TEXT NOT NULL DEFAULT 'open', recovered_ts BIGINT, expires_ts BIGINT NOT NULL, created_ts BIGINT NOT NULL, updated_ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS funnel_events ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, visitor_id TEXT NOT NULL, session_id TEXT, kind TEXT NOT NULL, step BIGINT NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}', source TEXT, medium TEXT, campaign TEXT, landing TEXT, device TEXT, referrer TEXT, appointment_id BIGINT, path TEXT, ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS experiments ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, hypothesis TEXT NOT NULL, metric TEXT NOT NULL DEFAULT 'booking_rate', population_pct BIGINT NOT NULL DEFAULT 100, status TEXT NOT NULL DEFAULT 'running', started_ts BIGINT NOT NULL, ended_ts BIGINT, min_sample BIGINT NOT NULL DEFAULT 200, created_ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS experiment_variants ( id BIGSERIAL PRIMARY KEY, experiment_id BIGINT NOT NULL, key TEXT NOT NULL, weight BIGINT NOT NULL DEFAULT 50, payload_json TEXT NOT NULL DEFAULT '{}', is_control INTEGER NOT NULL DEFAULT 0 )
;
CREATE TABLE IF NOT EXISTS experiment_assignments ( id BIGSERIAL PRIMARY KEY, experiment_key TEXT NOT NULL, variant_key TEXT NOT NULL, visitor_id TEXT NOT NULL, converted INTEGER NOT NULL DEFAULT 0, revenue_cents BIGINT NOT NULL DEFAULT 0, ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS observations ( id BIGSERIAL PRIMARY KEY, location_id BIGINT, kind TEXT NOT NULL, name TEXT NOT NULL, ms BIGINT, status TEXT NOT NULL DEFAULT 'ok', meta_json TEXT NOT NULL DEFAULT '{}', ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS audit_logs ( id BIGSERIAL PRIMARY KEY, location_id BIGINT, actor_type TEXT NOT NULL, actor_id BIGINT, action TEXT NOT NULL, entity TEXT, entity_id BIGINT, ip TEXT, user_agent TEXT, meta_json TEXT NOT NULL DEFAULT '{}', ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS sessions ( id TEXT PRIMARY KEY, user_id BIGINT NOT NULL, ip TEXT, user_agent TEXT, created_ts BIGINT NOT NULL, expires_ts BIGINT NOT NULL, revoked_ts BIGINT, last_seen_ts BIGINT )
;
CREATE TABLE IF NOT EXISTS rate_buckets ( bucket_key TEXT PRIMARY KEY, tokens REAL NOT NULL, updated_ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS risk_flags ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, customer_id BIGINT, kind TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'low', detail_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'open', ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS requests_deletion ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, customer_id BIGINT, email TEXT, phone TEXT, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', ip TEXT, ts BIGINT NOT NULL, done_ts BIGINT )
;
CREATE TABLE IF NOT EXISTS content_pages ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, slug TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'guide', title TEXT NOT NULL, summary TEXT, body_json TEXT NOT NULL DEFAULT '[]', cover_media_id BIGINT, service_key TEXT, faq_json TEXT NOT NULL DEFAULT '[]', seo_title TEXT, seo_desc TEXT, is_published INTEGER NOT NULL DEFAULT 1, reading_min BIGINT NOT NULL DEFAULT 3, created_ts BIGINT NOT NULL, updated_ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS onboarding ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, step TEXT NOT NULL, done_json TEXT NOT NULL DEFAULT '[]', ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS pending_actions ( id BIGSERIAL PRIMARY KEY, location_id BIGINT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', reason TEXT, status TEXT NOT NULL DEFAULT 'pending', created_ts BIGINT NOT NULL, decided_ts BIGINT, decided_by BIGINT )
;
CREATE TABLE IF NOT EXISTS loyalty_redemptions ( id BIGSERIAL PRIMARY KEY, customer_id BIGINT NOT NULL, reward_id BIGINT NOT NULL, code TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'issued', issued_ts BIGINT NOT NULL, redeemed_ts BIGINT, appointment_id BIGINT )
;
CREATE TABLE IF NOT EXISTS appointment_addons ( id BIGSERIAL PRIMARY KEY, appointment_id BIGINT NOT NULL, addon_id BIGINT NOT NULL, price_cents BIGINT NOT NULL, duration_min BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS login_codes ( id BIGSERIAL PRIMARY KEY, target TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'sms', code_hash TEXT NOT NULL, attempts BIGINT NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0, ip TEXT, created_ts BIGINT NOT NULL, expires_ts BIGINT NOT NULL )
;
CREATE TABLE IF NOT EXISTS scheduler_state ( key TEXT PRIMARY KEY, value BIGINT NOT NULL, updated_ts BIGINT NOT NULL )
;

CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_ts BIGINT NOT NULL);

-- Rattrapage : ajoute les colonnes absentes (evolution du produit sur une base installee).
-- Un echec sur une colonne (NOT NULL sans defaut sur table peuplee) ne bloque pas les autres :
-- la colonne est signalee dans le NOTICE, a traiter a la main. Les contraintes UNIQUE/PRIMARY KEY en
-- ligne sont retirees si necessaire, puis remplacees par un index unique eqivalent.
DO $$
DECLARE r record; v_def text; plain text; n_added int := 0; n_relief int := 0; v_failed text := '';
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('tenants', 'name', 'name TEXT NOT NULL'),
    ('tenants', 'plan', 'plan TEXT NOT NULL DEFAULT ''pro'''),
    ('tenants', 'status', 'status TEXT NOT NULL DEFAULT ''active'''),
    ('tenants', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('locations', 'tenant_id', 'tenant_id BIGINT NOT NULL'),
    ('locations', 'slug', 'slug TEXT NOT NULL UNIQUE'),
    ('locations', 'name', 'name TEXT NOT NULL'),
    ('locations', 'legal_name', 'legal_name TEXT'),
    ('locations', 'brand_json', 'brand_json TEXT NOT NULL DEFAULT ''{}'''),
    ('locations', 'address_json', 'address_json TEXT NOT NULL DEFAULT ''{}'''),
    ('locations', 'hours_json', 'hours_json TEXT NOT NULL DEFAULT ''{}'''),
    ('locations', 'policy_json', 'policy_json TEXT NOT NULL DEFAULT ''{}'''),
    ('locations', 'features_json', 'features_json TEXT NOT NULL DEFAULT ''{}'''),
    ('locations', 'holidays_json', 'holidays_json TEXT NOT NULL DEFAULT ''[]'''),
    ('locations', 'timezone', 'timezone TEXT NOT NULL DEFAULT ''Europe/Paris'''),
    ('locations', 'phone', 'phone TEXT'),
    ('locations', 'email', 'email TEXT'),
    ('locations', 'currency', 'currency TEXT NOT NULL DEFAULT ''EUR'''),
    ('locations', 'plan_status', 'plan_status TEXT NOT NULL DEFAULT ''active'''),
    ('locations', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('locations', 'updated_ts', 'updated_ts BIGINT NOT NULL'),
    ('users', 'location_id', 'location_id BIGINT'),
    ('users', 'email', 'email TEXT'),
    ('users', 'phone', 'phone TEXT'),
    ('users', 'name', 'name TEXT'),
    ('users', 'role_key', 'role_key TEXT NOT NULL DEFAULT ''customer'''),
    ('users', 'password_hash', 'password_hash TEXT NOT NULL'),
    ('users', 'staff_id', 'staff_id BIGINT'),
    ('users', 'is_active', 'is_active INTEGER NOT NULL DEFAULT 1'),
    ('users', 'failed_attempts', 'failed_attempts INTEGER NOT NULL DEFAULT 0'),
    ('users', 'locked_until', 'locked_until BIGINT'),
    ('users', 'last_login_ts', 'last_login_ts BIGINT'),
    ('users', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('staff', 'location_id', 'location_id BIGINT NOT NULL'),
    ('staff', 'name', 'name TEXT NOT NULL'),
    ('staff', 'slug', 'slug TEXT NOT NULL'),
    ('staff', 'role_key', 'role_key TEXT NOT NULL DEFAULT ''staff'''),
    ('staff', 'bio', 'bio TEXT'),
    ('staff', 'title', 'title TEXT'),
    ('staff', 'avatar_url', 'avatar_url TEXT'),
    ('staff', 'color_hex', 'color_hex TEXT NOT NULL DEFAULT ''#E8C98A'''),
    ('staff', 'commission_pct', 'commission_pct INTEGER NOT NULL DEFAULT 0'),
    ('staff', 'is_active', 'is_active INTEGER NOT NULL DEFAULT 1'),
    ('staff', 'accept_new_clients', 'accept_new_clients INTEGER NOT NULL DEFAULT 1'),
    ('staff', 'display_order', 'display_order INTEGER NOT NULL DEFAULT 0'),
    ('staff', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('staff_skills', 'staff_id', 'staff_id BIGINT NOT NULL'),
    ('staff_skills', 'service_id', 'service_id BIGINT NOT NULL'),
    ('staff_skills', 'price_cents', 'price_cents BIGINT'),
    ('staff_skills', 'duration_min', 'duration_min BIGINT'),
    ('staff_skills', 'level', 'level TEXT'),
    ('working_hours', 'location_id', 'location_id BIGINT NOT NULL'),
    ('working_hours', 'staff_id', 'staff_id BIGINT'),
    ('working_hours', 'dow', 'dow BIGINT NOT NULL'),
    ('working_hours', 'start_min', 'start_min BIGINT NOT NULL'),
    ('working_hours', 'end_min', 'end_min BIGINT NOT NULL'),
    ('shift_breaks', 'location_id', 'location_id BIGINT NOT NULL'),
    ('shift_breaks', 'staff_id', 'staff_id BIGINT'),
    ('shift_breaks', 'dow', 'dow BIGINT NOT NULL'),
    ('shift_breaks', 'start_min', 'start_min BIGINT NOT NULL'),
    ('shift_breaks', 'end_min', 'end_min BIGINT NOT NULL'),
    ('shift_breaks', 'label', 'label TEXT'),
    ('day_overrides', 'location_id', 'location_id BIGINT NOT NULL'),
    ('day_overrides', 'staff_id', 'staff_id BIGINT'),
    ('day_overrides', 'day', 'day TEXT NOT NULL'),
    ('day_overrides', 'kind', 'kind TEXT NOT NULL'),
    ('day_overrides', 'start_min', 'start_min BIGINT'),
    ('day_overrides', 'end_min', 'end_min BIGINT'),
    ('day_overrides', 'reason', 'reason TEXT'),
    ('day_overrides', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('blocks', 'location_id', 'location_id BIGINT NOT NULL'),
    ('blocks', 'staff_id', 'staff_id BIGINT'),
    ('blocks', 'start_ts', 'start_ts BIGINT NOT NULL'),
    ('blocks', 'end_ts', 'end_ts BIGINT NOT NULL'),
    ('blocks', 'kind', 'kind TEXT NOT NULL DEFAULT ''busy'''),
    ('blocks', 'reason', 'reason TEXT'),
    ('blocks', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('services', 'location_id', 'location_id BIGINT NOT NULL'),
    ('services', 'key', 'key TEXT NOT NULL'),
    ('services', 'name', 'name TEXT NOT NULL'),
    ('services', 'category', 'category TEXT NOT NULL DEFAULT ''coupe'''),
    ('services', 'short_desc', 'short_desc TEXT'),
    ('services', 'description', 'description TEXT'),
    ('services', 'base_price_cents', 'base_price_cents BIGINT NOT NULL'),
    ('services', 'base_duration_min', 'base_duration_min BIGINT NOT NULL'),
    ('services', 'prep_min', 'prep_min BIGINT NOT NULL DEFAULT 0'),
    ('services', 'cleanup_min', 'cleanup_min BIGINT NOT NULL DEFAULT 5'),
    ('services', 'level', 'level TEXT NOT NULL DEFAULT ''tous'''),
    ('services', 'cover_media_id', 'cover_media_id BIGINT'),
    ('services', 'gender', 'gender TEXT NOT NULL DEFAULT ''m'''),
    ('services', 'age', 'age TEXT NOT NULL DEFAULT ''adulte'''),
    ('services', 'is_active', 'is_active INTEGER NOT NULL DEFAULT 1'),
    ('services', 'display_order', 'display_order INTEGER NOT NULL DEFAULT 0'),
    ('services', 'price_from_label', 'price_from_label TEXT'),
    ('services', 'problem', 'problem TEXT'),
    ('services', 'solution', 'solution TEXT'),
    ('services', 'seo_title', 'seo_title TEXT'),
    ('services', 'seo_desc', 'seo_desc TEXT'),
    ('services', 'faq_json', 'faq_json TEXT NOT NULL DEFAULT ''[]'''),
    ('services', 'updated_ts', 'updated_ts BIGINT NOT NULL'),
    ('addons', 'location_id', 'location_id BIGINT NOT NULL'),
    ('addons', 'key', 'key TEXT NOT NULL'),
    ('addons', 'name', 'name TEXT NOT NULL'),
    ('addons', 'description', 'description TEXT'),
    ('addons', 'price_cents', 'price_cents BIGINT NOT NULL'),
    ('addons', 'duration_min', 'duration_min BIGINT NOT NULL'),
    ('addons', 'category', 'category TEXT NOT NULL DEFAULT ''soin'''),
    ('addons', 'is_active', 'is_active INTEGER NOT NULL DEFAULT 1'),
    ('addons', 'display_order', 'display_order INTEGER NOT NULL DEFAULT 0'),
    ('addons', 'suggest_after_service_key', 'suggest_after_service_key TEXT'),
    ('addons', 'hint', 'hint TEXT'),
    ('offerings', 'location_id', 'location_id BIGINT NOT NULL'),
    ('offerings', 'service_id', 'service_id BIGINT NOT NULL'),
    ('offerings', 'staff_id', 'staff_id BIGINT'),
    ('offerings', 'addon_ids', 'addon_ids TEXT NOT NULL DEFAULT ''[]'''),
    ('offerings', 'name', 'name TEXT NOT NULL'),
    ('offerings', 'description', 'description TEXT'),
    ('offerings', 'duration_min', 'duration_min BIGINT NOT NULL'),
    ('offerings', 'price_cents', 'price_cents BIGINT NOT NULL'),
    ('offerings', 'is_active', 'is_active INTEGER NOT NULL DEFAULT 1'),
    ('offerings', 'is_popular', 'is_popular INTEGER NOT NULL DEFAULT 0'),
    ('offerings', 'max_per_slot', 'max_per_slot INTEGER NOT NULL DEFAULT 0'),
    ('offerings', 'photo_media_id', 'photo_media_id BIGINT'),
    ('offerings', 'display_order', 'display_order INTEGER NOT NULL DEFAULT 0'),
    ('offerings', 'updated_ts', 'updated_ts BIGINT NOT NULL'),
    ('media', 'location_id', 'location_id BIGINT NOT NULL'),
    ('media', 'path', 'path TEXT NOT NULL'),
    ('media', 'alt', 'alt TEXT'),
    ('media', 'kind', 'kind TEXT NOT NULL DEFAULT ''photo'''),
    ('media', 'label', 'label TEXT'),
    ('media', 'service_key', 'service_key TEXT'),
    ('media', 'price_cents', 'price_cents BIGINT'),
    ('media', 'duration_min', 'duration_min BIGINT'),
    ('media', 'before_after', 'before_after INTEGER NOT NULL DEFAULT 0'),
    ('media', 'aspect', 'aspect TEXT NOT NULL DEFAULT ''4/5'''),
    ('media', 'ts', 'ts BIGINT NOT NULL'),
    ('media', 'like_count', 'like_count BIGINT NOT NULL DEFAULT 0'),
    ('customers', 'location_id', 'location_id BIGINT NOT NULL'),
    ('customers', 'user_id', 'user_id BIGINT'),
    ('customers', 'first_name', 'first_name TEXT'),
    ('customers', 'last_name', 'last_name TEXT'),
    ('customers', 'phone', 'phone TEXT'),
    ('customers', 'phone_norm', 'phone_norm TEXT'),
    ('customers', 'email', 'email TEXT'),
    ('customers', 'email_norm', 'email_norm TEXT'),
    ('customers', 'birth_day', 'birth_day TEXT'),
    ('customers', 'gender', 'gender TEXT'),
    ('customers', 'notes', 'notes TEXT'),
    ('customers', 'tags', 'tags TEXT NOT NULL DEFAULT ''[]'''),
    ('customers', 'address_city', 'address_city TEXT'),
    ('customers', 'preferred_staff_id', 'preferred_staff_id BIGINT'),
    ('customers', 'preferred_service_id', 'preferred_service_id BIGINT'),
    ('customers', 'preferred_channel', 'preferred_channel TEXT NOT NULL DEFAULT ''sms'''),
    ('customers', 'language', 'language TEXT NOT NULL DEFAULT ''fr'''),
    ('customers', 'consent_marketing_email', 'consent_marketing_email INTEGER NOT NULL DEFAULT 0'),
    ('customers', 'consent_marketing_sms', 'consent_marketing_sms INTEGER NOT NULL DEFAULT 0'),
    ('customers', 'consent_marketing_whatsapp', 'consent_marketing_whatsapp INTEGER NOT NULL DEFAULT 0'),
    ('customers', 'consent_terms_ts', 'consent_terms_ts BIGINT'),
    ('customers', 'source', 'source TEXT'),
    ('customers', 'medium', 'medium TEXT'),
    ('customers', 'campaign', 'campaign TEXT'),
    ('customers', 'landing', 'landing TEXT'),
    ('customers', 'device', 'device TEXT'),
    ('customers', 'referrer', 'referrer TEXT'),
    ('customers', 'referred_by', 'referred_by BIGINT'),
    ('customers', 'referral_code', 'referral_code TEXT'),
    ('customers', 'visits_count', 'visits_count BIGINT NOT NULL DEFAULT 0'),
    ('customers', 'cancelled_count', 'cancelled_count BIGINT NOT NULL DEFAULT 0'),
    ('customers', 'noshow_count', 'noshow_count BIGINT NOT NULL DEFAULT 0'),
    ('customers', 'spent_cents', 'spent_cents BIGINT NOT NULL DEFAULT 0'),
    ('customers', 'loyalty_points', 'loyalty_points BIGINT NOT NULL DEFAULT 0'),
    ('customers', 'loyalty_visits', 'loyalty_visits BIGINT NOT NULL DEFAULT 0'),
    ('customers', 'avg_days_between', 'avg_days_between BIGINT'),
    ('customers', 'last_visit_ts', 'last_visit_ts BIGINT'),
    ('customers', 'next_visit_ts', 'next_visit_ts BIGINT'),
    ('customers', 'membership_status', 'membership_status TEXT NOT NULL DEFAULT ''none'''),
    ('customers', 'priority_until', 'priority_until BIGINT'),
    ('customers', 'risk_score', 'risk_score BIGINT NOT NULL DEFAULT 0'),
    ('customers', 'segment', 'segment TEXT NOT NULL DEFAULT ''new'''),
    ('customers', 'deleted_ts', 'deleted_ts BIGINT'),
    ('customers', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('customers', 'updated_ts', 'updated_ts BIGINT NOT NULL'),
    ('consents', 'location_id', 'location_id BIGINT NOT NULL'),
    ('consents', 'customer_id', 'customer_id BIGINT'),
    ('consents', 'purpose', 'purpose TEXT NOT NULL'),
    ('consents', 'channel', 'channel TEXT'),
    ('consents', 'granted', 'granted INTEGER NOT NULL'),
    ('consents', 'source', 'source TEXT'),
    ('consents', 'ip', 'ip TEXT'),
    ('consents', 'user_agent', 'user_agent TEXT'),
    ('consents', 'policy_version', 'policy_version TEXT NOT NULL DEFAULT ''v1'''),
    ('consents', 'revoked_ts', 'revoked_ts BIGINT'),
    ('consents', 'ts', 'ts BIGINT NOT NULL'),
    ('customer_measurements', 'customer_id', 'customer_id BIGINT NOT NULL'),
    ('customer_measurements', 'key', 'key TEXT NOT NULL'),
    ('customer_measurements', 'value', 'value TEXT NOT NULL'),
    ('customer_measurements', 'ts', 'ts BIGINT NOT NULL'),
    ('appointments', 'location_id', 'location_id BIGINT NOT NULL'),
    ('appointments', 'customer_id', 'customer_id BIGINT NOT NULL'),
    ('appointments', 'offering_id', 'offering_id BIGINT NOT NULL'),
    ('appointments', 'service_id', 'service_id BIGINT NOT NULL'),
    ('appointments', 'staff_id', 'staff_id BIGINT NOT NULL'),
    ('appointments', 'start_ts', 'start_ts BIGINT NOT NULL'),
    ('appointments', 'end_ts', 'end_ts BIGINT NOT NULL'),
    ('appointments', 'prep_end_ts', 'prep_end_ts BIGINT'),
    ('appointments', 'status', 'status TEXT NOT NULL DEFAULT ''booked'''),
    ('appointments', 'price_cents', 'price_cents BIGINT NOT NULL DEFAULT 0'),
    ('appointments', 'deposit_cents', 'deposit_cents BIGINT NOT NULL DEFAULT 0'),
    ('appointments', 'deposit_status', 'deposit_status TEXT NOT NULL DEFAULT ''none'''),
    ('appointments', 'paid_cents', 'paid_cents BIGINT NOT NULL DEFAULT 0'),
    ('appointments', 'add_on_cents', 'add_on_cents BIGINT NOT NULL DEFAULT 0'),
    ('appointments', 'duration_min', 'duration_min BIGINT NOT NULL'),
    ('appointments', 'confirm_required', 'confirm_required INTEGER NOT NULL DEFAULT 0'),
    ('appointments', 'confirmed_ts', 'confirmed_ts BIGINT'),
    ('appointments', 'needs_action', 'needs_action INTEGER NOT NULL DEFAULT 0'),
    ('appointments', 'is_walkin', 'is_walkin INTEGER NOT NULL DEFAULT 0'),
    ('appointments', 'waitlist_offer_id', 'waitlist_offer_id BIGINT'),
    ('appointments', 'gift_card_id', 'gift_card_id BIGINT'),
    ('appointments', 'source', 'source TEXT, medium TEXT, campaign TEXT, landing TEXT, device TEXT, referrer TEXT'),
    ('appointments', 'client_ip', 'client_ip TEXT'),
    ('appointments', 'internal_note', 'internal_note TEXT'),
    ('appointments', 'cancel_reason', 'cancel_reason TEXT'),
    ('appointments', 'cancel_by', 'cancel_by TEXT'),
    ('appointments', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('appointments', 'updated_ts', 'updated_ts BIGINT NOT NULL'),
    ('appointments', 'cancelled_ts', 'cancelled_ts BIGINT'),
    ('appointments', 'noshow_ts', 'noshow_ts BIGINT'),
    ('appointments', 'completed_ts', 'completed_ts BIGINT'),
    ('appointments', 'rescheduled_from', 'rescheduled_from BIGINT'),
    ('appointments', 'rescheduled_count', 'rescheduled_count BIGINT NOT NULL DEFAULT 0'),
    ('appointments', 'review_requested_ts', 'review_requested_ts BIGINT'),
    ('appointments', 'review_status', 'review_status TEXT NOT NULL DEFAULT ''none'''),
    ('appointments', 'external_uid', 'external_uid TEXT'),
    ('appointments', 'reminder_offsets', 'reminder_offsets TEXT NOT NULL DEFAULT ''[]'''),
    ('appointments', 'reminder_cursor', 'reminder_cursor BIGINT NOT NULL DEFAULT 0'),
    ('appointment_events', 'appointment_id', 'appointment_id BIGINT NOT NULL'),
    ('appointment_events', 'kind', 'kind TEXT NOT NULL'),
    ('appointment_events', 'data_json', 'data_json TEXT NOT NULL DEFAULT ''{}'''),
    ('appointment_events', 'actor_type', 'actor_type TEXT NOT NULL DEFAULT ''system'''),
    ('appointment_events', 'actor_id', 'actor_id BIGINT'),
    ('appointment_events', 'ts', 'ts BIGINT NOT NULL'),
    ('waitlist', 'location_id', 'location_id BIGINT NOT NULL'),
    ('waitlist', 'customer_id', 'customer_id BIGINT'),
    ('waitlist', 'name', 'name TEXT NOT NULL'),
    ('waitlist', 'phone', 'phone TEXT NOT NULL'),
    ('waitlist', 'phone_norm', 'phone_norm TEXT'),
    ('waitlist', 'email', 'email TEXT'),
    ('waitlist', 'service_id', 'service_id BIGINT'),
    ('waitlist', 'offering_id', 'offering_id BIGINT'),
    ('waitlist', 'staff_id', 'staff_id BIGINT'),
    ('waitlist', 'days', 'days TEXT NOT NULL DEFAULT ''[]'''),
    ('waitlist', 'window_start_min', 'window_start_min BIGINT'),
    ('waitlist', 'window_end_min', 'window_end_min BIGINT'),
    ('waitlist', 'flex_json', 'flex_json TEXT NOT NULL DEFAULT ''{}'''),
    ('waitlist', 'note', 'note TEXT'),
    ('waitlist', 'priority', 'priority INTEGER NOT NULL DEFAULT 0'),
    ('waitlist', 'status', 'status TEXT NOT NULL DEFAULT ''active'''),
    ('waitlist', 'queue_rank', 'queue_rank BIGINT NOT NULL DEFAULT 0'),
    ('waitlist', 'consent_contact', 'consent_contact INTEGER NOT NULL DEFAULT 1'),
    ('waitlist', 'source', 'source TEXT'),
    ('waitlist', 'token', 'token TEXT'),
    ('waitlist', 'notified_count', 'notified_count BIGINT NOT NULL DEFAULT 0'),
    ('waitlist', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('waitlist', 'updated_ts', 'updated_ts BIGINT NOT NULL'),
    ('waitlist', 'fulfilled_ts', 'fulfilled_ts BIGINT'),
    ('waitlist', 'closed_ts', 'closed_ts BIGINT'),
    ('waitlist_offers', 'waitlist_id', 'waitlist_id BIGINT NOT NULL'),
    ('waitlist_offers', 'location_id', 'location_id BIGINT NOT NULL'),
    ('waitlist_offers', 'staff_id', 'staff_id BIGINT NOT NULL'),
    ('waitlist_offers', 'offering_id', 'offering_id BIGINT NOT NULL'),
    ('waitlist_offers', 'service_id', 'service_id BIGINT NOT NULL'),
    ('waitlist_offers', 'start_ts', 'start_ts BIGINT NOT NULL'),
    ('waitlist_offers', 'end_ts', 'end_ts BIGINT NOT NULL'),
    ('waitlist_offers', 'status', 'status TEXT NOT NULL DEFAULT ''pending'''),
    ('waitlist_offers', 'channel', 'channel TEXT NOT NULL DEFAULT ''sms'''),
    ('waitlist_offers', 'token', 'token TEXT NOT NULL UNIQUE'),
    ('waitlist_offers', 'expires_ts', 'expires_ts BIGINT NOT NULL'),
    ('waitlist_offers', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('waitlist_offers', 'responded_ts', 'responded_ts BIGINT'),
    ('waitlist_offers', 'appointment_id', 'appointment_id BIGINT'),
    ('waitlist_offers', 'reason', 'reason TEXT'),
    ('walkins', 'location_id', 'location_id BIGINT NOT NULL'),
    ('walkins', 'name', 'name TEXT NOT NULL'),
    ('walkins', 'phone', 'phone TEXT'),
    ('walkins', 'service_id', 'service_id BIGINT'),
    ('walkins', 'staff_id', 'staff_id BIGINT'),
    ('walkins', 'status', 'status TEXT NOT NULL DEFAULT ''waiting'''),
    ('walkins', 'queue_rank', 'queue_rank BIGINT NOT NULL'),
    ('walkins', 'eta_min', 'eta_min BIGINT'),
    ('walkins', 'token', 'token TEXT'),
    ('walkins', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('walkins', 'seated_ts', 'seated_ts BIGINT'),
    ('walkins', 'done_ts', 'done_ts BIGINT'),
    ('payments', 'location_id', 'location_id BIGINT NOT NULL'),
    ('payments', 'appointment_id', 'appointment_id BIGINT'),
    ('payments', 'customer_id', 'customer_id BIGINT'),
    ('payments', 'gift_card_id', 'gift_card_id BIGINT'),
    ('payments', 'kind', 'kind TEXT NOT NULL'),
    ('payments', 'provider', 'provider TEXT NOT NULL DEFAULT ''demo'''),
    ('payments', 'provider_ref', 'provider_ref TEXT'),
    ('payments', 'amount_cents', 'amount_cents BIGINT NOT NULL'),
    ('payments', 'status', 'status TEXT NOT NULL DEFAULT ''pending'''),
    ('payments', 'failure_reason', 'failure_reason TEXT'),
    ('payments', 'idempotency_key', 'idempotency_key TEXT UNIQUE'),
    ('payments', 'refund_of', 'refund_of BIGINT'),
    ('payments', 'meta_json', 'meta_json TEXT NOT NULL DEFAULT ''{}'''),
    ('payments', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('payments', 'updated_ts', 'updated_ts BIGINT NOT NULL'),
    ('gift_cards', 'location_id', 'location_id BIGINT NOT NULL'),
    ('gift_cards', 'code', 'code TEXT NOT NULL UNIQUE'),
    ('gift_cards', 'amount_cents', 'amount_cents BIGINT NOT NULL'),
    ('gift_cards', 'balance_cents', 'balance_cents BIGINT NOT NULL'),
    ('gift_cards', 'buyer_name', 'buyer_name TEXT'),
    ('gift_cards', 'buyer_email', 'buyer_email TEXT'),
    ('gift_cards', 'recipient_name', 'recipient_name TEXT'),
    ('gift_cards', 'message', 'message TEXT'),
    ('gift_cards', 'service_id', 'service_id BIGINT'),
    ('gift_cards', 'status', 'status TEXT NOT NULL DEFAULT ''active'''),
    ('gift_cards', 'send_ts', 'send_ts BIGINT'),
    ('gift_cards', 'redeemed_ts', 'redeemed_ts BIGINT'),
    ('gift_cards', 'redeemer_id', 'redeemer_id BIGINT'),
    ('gift_cards', 'payment_id', 'payment_id BIGINT'),
    ('gift_cards', 'expiry_ts', 'expiry_ts BIGINT'),
    ('gift_cards', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('memberships', 'location_id', 'location_id BIGINT NOT NULL'),
    ('memberships', 'customer_id', 'customer_id BIGINT NOT NULL'),
    ('memberships', 'plan_key', 'plan_key TEXT NOT NULL'),
    ('memberships', 'status', 'status TEXT NOT NULL DEFAULT ''active'''),
    ('memberships', 'price_cents', 'price_cents BIGINT NOT NULL'),
    ('memberships', 'visits_included', 'visits_included BIGINT NOT NULL'),
    ('memberships', 'visits_used', 'visits_used BIGINT NOT NULL DEFAULT 0'),
    ('memberships', 'started_ts', 'started_ts BIGINT NOT NULL'),
    ('memberships', 'renews_ts', 'renews_ts BIGINT'),
    ('memberships', 'ended_ts', 'ended_ts BIGINT'),
    ('memberships', 'priority', 'priority INTEGER NOT NULL DEFAULT 0'),
    ('loyalty_rewards', 'location_id', 'location_id BIGINT NOT NULL'),
    ('loyalty_rewards', 'name', 'name TEXT NOT NULL'),
    ('loyalty_rewards', 'description', 'description TEXT'),
    ('loyalty_rewards', 'kind', 'kind TEXT NOT NULL DEFAULT ''discount'''),
    ('loyalty_rewards', 'value_cents', 'value_cents BIGINT NOT NULL DEFAULT 0'),
    ('loyalty_rewards', 'threshold_visits', 'threshold_visits BIGINT NOT NULL DEFAULT 0'),
    ('loyalty_rewards', 'points_cost', 'points_cost BIGINT NOT NULL DEFAULT 0'),
    ('loyalty_rewards', 'is_active', 'is_active INTEGER NOT NULL DEFAULT 1'),
    ('loyalty_rewards', 'points_per_visit', 'points_per_visit BIGINT NOT NULL DEFAULT 10'),
    ('loyalty_rewards', 'birthday_bonus_points', 'birthday_bonus_points BIGINT NOT NULL DEFAULT 0'),
    ('loyalty_ledger', 'location_id', 'location_id BIGINT NOT NULL'),
    ('loyalty_ledger', 'customer_id', 'customer_id BIGINT NOT NULL'),
    ('loyalty_ledger', 'points', 'points BIGINT NOT NULL'),
    ('loyalty_ledger', 'reason', 'reason TEXT NOT NULL'),
    ('loyalty_ledger', 'appointment_id', 'appointment_id BIGINT'),
    ('loyalty_ledger', 'reward_id', 'reward_id BIGINT'),
    ('loyalty_ledger', 'balance_after', 'balance_after BIGINT NOT NULL DEFAULT 0'),
    ('loyalty_ledger', 'note', 'note TEXT'),
    ('loyalty_ledger', 'ts', 'ts BIGINT NOT NULL'),
    ('referrals', 'location_id', 'location_id BIGINT NOT NULL'),
    ('referrals', 'referrer_id', 'referrer_id BIGINT NOT NULL'),
    ('referrals', 'referee_id', 'referee_id BIGINT'),
    ('referrals', 'code', 'code TEXT NOT NULL'),
    ('referrals', 'channel', 'channel TEXT NOT NULL DEFAULT ''link'''),
    ('referrals', 'status', 'status TEXT NOT NULL DEFAULT ''invited'''),
    ('referrals', 'first_book_ts', 'first_book_ts BIGINT'),
    ('referrals', 'first_visit_ts', 'first_visit_ts BIGINT'),
    ('referrals', 'reward_referrer_cents', 'reward_referrer_cents BIGINT NOT NULL DEFAULT 0'),
    ('referrals', 'reward_referee_cents', 'reward_referee_cents BIGINT NOT NULL DEFAULT 0'),
    ('referrals', 'granted_ts', 'granted_ts BIGINT'),
    ('referrals', 'fraud_flag', 'fraud_flag INTEGER NOT NULL DEFAULT 0'),
    ('referrals', 'ip', 'ip TEXT'),
    ('referrals', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('reviews', 'location_id', 'location_id BIGINT NOT NULL'),
    ('reviews', 'appointment_id', 'appointment_id BIGINT UNIQUE'),
    ('reviews', 'customer_id', 'customer_id BIGINT'),
    ('reviews', 'rating', 'rating BIGINT'),
    ('reviews', 'title', 'title TEXT'),
    ('reviews', 'comment', 'comment TEXT'),
    ('reviews', 'status', 'status TEXT NOT NULL DEFAULT ''requested'''),
    ('reviews', 'visibility', 'visibility TEXT NOT NULL DEFAULT ''private'''),
    ('reviews', 'channel', 'channel TEXT NOT NULL DEFAULT ''internal'''),
    ('reviews', 'public_url', 'public_url TEXT'),
    ('reviews', 'staff_id', 'staff_id BIGINT'),
    ('reviews', 'service_id', 'service_id BIGINT'),
    ('reviews', 'reply_text', 'reply_text TEXT'),
    ('reviews', 'reply_ts', 'reply_ts BIGINT'),
    ('reviews', 'consent_publish', 'consent_publish INTEGER NOT NULL DEFAULT 0'),
    ('reviews', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('reviews', 'updated_ts', 'updated_ts BIGINT NOT NULL'),
    ('templates', 'location_id', 'location_id BIGINT NOT NULL'),
    ('templates', 'key', 'key TEXT NOT NULL'),
    ('templates', 'channel', 'channel TEXT NOT NULL'),
    ('templates', 'lang', 'lang TEXT NOT NULL DEFAULT ''fr'''),
    ('templates', 'subject', 'subject TEXT'),
    ('templates', 'body_text', 'body_text TEXT NOT NULL'),
    ('templates', 'is_active', 'is_active INTEGER NOT NULL DEFAULT 1'),
    ('templates', 'updated_ts', 'updated_ts BIGINT NOT NULL'),
    ('notifications', 'location_id', 'location_id BIGINT NOT NULL'),
    ('notifications', 'customer_id', 'customer_id BIGINT'),
    ('notifications', 'appointment_id', 'appointment_id BIGINT'),
    ('notifications', 'waitlist_offer_id', 'waitlist_offer_id BIGINT'),
    ('notifications', 'template_key', 'template_key TEXT'),
    ('notifications', 'kind', 'kind TEXT NOT NULL'),
    ('notifications', 'channel', 'channel TEXT NOT NULL'),
    ('notifications', 'recipient', 'recipient TEXT NOT NULL'),
    ('notifications', 'subject', 'subject TEXT'),
    ('notifications', 'body_text', 'body_text TEXT NOT NULL'),
    ('notifications', 'status', 'status TEXT NOT NULL DEFAULT ''queued'''),
    ('notifications', 'idempotency_key', 'idempotency_key TEXT UNIQUE'),
    ('notifications', 'action_token', 'action_token TEXT'),
    ('notifications', 'error', 'error TEXT'),
    ('notifications', 'meta_json', 'meta_json TEXT NOT NULL DEFAULT ''{}'''),
    ('notifications', 'send_ts', 'send_ts BIGINT'),
    ('notifications', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('notifications', 'sent_ts', 'sent_ts BIGINT'),
    ('notifications', 'delivered_ts', 'delivered_ts BIGINT'),
    ('notifications', 'read_ts', 'read_ts BIGINT'),
    ('notifications', 'clicked_ts', 'clicked_ts BIGINT'),
    ('notifications', 'failed_ts', 'failed_ts BIGINT'),
    ('notifications', 'campaign_id', 'campaign_id BIGINT'),
    ('automations', 'location_id', 'location_id BIGINT NOT NULL'),
    ('automations', 'key', 'key TEXT NOT NULL'),
    ('automations', 'trigger_key', 'trigger_key TEXT NOT NULL'),
    ('automations', 'action_type', 'action_type TEXT NOT NULL'),
    ('automations', 'name', 'name TEXT NOT NULL'),
    ('automations', 'description', 'description TEXT'),
    ('automations', 'config_json', 'config_json TEXT NOT NULL DEFAULT ''{}'''),
    ('automations', 'is_active', 'is_active INTEGER NOT NULL DEFAULT 1'),
    ('automations', 'cooldown_hours', 'cooldown_hours BIGINT NOT NULL DEFAULT 0'),
    ('automations', 'quiet_hours', 'quiet_hours TEXT NOT NULL DEFAULT ''{"from":"21:00","to":"08:30"}'''),
    ('automations', 'max_per_week', 'max_per_week BIGINT NOT NULL DEFAULT 4'),
    ('automations', 'requires_owner_approval', 'requires_owner_approval INTEGER NOT NULL DEFAULT 0'),
    ('automations', 'runs_count', 'runs_count BIGINT NOT NULL DEFAULT 0'),
    ('automations', 'last_run_ts', 'last_run_ts BIGINT'),
    ('automations', 'updated_ts', 'updated_ts BIGINT NOT NULL'),
    ('campaigns', 'location_id', 'location_id BIGINT NOT NULL'),
    ('campaigns', 'name', 'name TEXT NOT NULL'),
    ('campaigns', 'kind', 'kind TEXT NOT NULL DEFAULT ''manual'''),
    ('campaigns', 'segment_json', 'segment_json TEXT NOT NULL DEFAULT ''[]'''),
    ('campaigns', 'template_key', 'template_key TEXT'),
    ('campaigns', 'channel', 'channel TEXT NOT NULL DEFAULT ''sms'''),
    ('campaigns', 'offer_text', 'offer_text TEXT'),
    ('campaigns', 'status', 'status TEXT NOT NULL DEFAULT ''draft'''),
    ('campaigns', 'scheduled_ts', 'scheduled_ts BIGINT'),
    ('campaigns', 'sent_ts', 'sent_ts BIGINT'),
    ('campaigns', 'counts_json', 'counts_json TEXT NOT NULL DEFAULT ''{}'''),
    ('campaigns', 'created_by', 'created_by BIGINT'),
    ('campaigns', 'approved_by', 'approved_by BIGINT'),
    ('campaigns', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('campaigns', 'updated_ts', 'updated_ts BIGINT NOT NULL'),
    ('campaigns', 'est_revenue_cents', 'est_revenue_cents BIGINT NOT NULL DEFAULT 0'),
    ('campaign_recipients', 'campaign_id', 'campaign_id BIGINT NOT NULL'),
    ('campaign_recipients', 'customer_id', 'customer_id BIGINT NOT NULL'),
    ('campaign_recipients', 'status', 'status TEXT NOT NULL DEFAULT ''pending'''),
    ('campaign_recipients', 'notification_id', 'notification_id BIGINT'),
    ('campaign_recipients', 'ts', 'ts BIGINT'),
    ('booking_drafts', 'location_id', 'location_id BIGINT NOT NULL'),
    ('booking_drafts', 'visitor_id', 'visitor_id TEXT NOT NULL'),
    ('booking_drafts', 'session_id', 'session_id TEXT'),
    ('booking_drafts', 'offering_id', 'offering_id BIGINT'),
    ('booking_drafts', 'staff_id', 'staff_id BIGINT'),
    ('booking_drafts', 'addon_ids', 'addon_ids TEXT NOT NULL DEFAULT ''[]'''),
    ('booking_drafts', 'slot_start_ts', 'slot_start_ts BIGINT'),
    ('booking_drafts', 'first_name', 'first_name TEXT, last_name TEXT, phone TEXT, email TEXT, note TEXT'),
    ('booking_drafts', 'consent_marketing', 'consent_marketing INTEGER NOT NULL DEFAULT 0'),
    ('booking_drafts', 'contact_ts', 'contact_ts BIGINT'),
    ('booking_drafts', 'source', 'source TEXT, medium TEXT, campaign TEXT, landing TEXT, device TEXT, referrer TEXT'),
    ('booking_drafts', 'step', 'step TEXT NOT NULL DEFAULT ''service'''),
    ('booking_drafts', 'status', 'status TEXT NOT NULL DEFAULT ''open'''),
    ('booking_drafts', 'recovered_ts', 'recovered_ts BIGINT'),
    ('booking_drafts', 'expires_ts', 'expires_ts BIGINT NOT NULL'),
    ('booking_drafts', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('booking_drafts', 'updated_ts', 'updated_ts BIGINT NOT NULL'),
    ('funnel_events', 'location_id', 'location_id BIGINT NOT NULL'),
    ('funnel_events', 'visitor_id', 'visitor_id TEXT NOT NULL'),
    ('funnel_events', 'session_id', 'session_id TEXT'),
    ('funnel_events', 'kind', 'kind TEXT NOT NULL'),
    ('funnel_events', 'step', 'step BIGINT NOT NULL DEFAULT 0'),
    ('funnel_events', 'meta_json', 'meta_json TEXT NOT NULL DEFAULT ''{}'''),
    ('funnel_events', 'source', 'source TEXT, medium TEXT, campaign TEXT, landing TEXT, device TEXT, referrer TEXT'),
    ('funnel_events', 'appointment_id', 'appointment_id BIGINT'),
    ('funnel_events', 'path', 'path TEXT'),
    ('funnel_events', 'ts', 'ts BIGINT NOT NULL'),
    ('experiments', 'location_id', 'location_id BIGINT NOT NULL'),
    ('experiments', 'key', 'key TEXT NOT NULL'),
    ('experiments', 'name', 'name TEXT NOT NULL'),
    ('experiments', 'hypothesis', 'hypothesis TEXT NOT NULL'),
    ('experiments', 'metric', 'metric TEXT NOT NULL DEFAULT ''booking_rate'''),
    ('experiments', 'population_pct', 'population_pct BIGINT NOT NULL DEFAULT 100'),
    ('experiments', 'status', 'status TEXT NOT NULL DEFAULT ''running'''),
    ('experiments', 'started_ts', 'started_ts BIGINT NOT NULL'),
    ('experiments', 'ended_ts', 'ended_ts BIGINT'),
    ('experiments', 'min_sample', 'min_sample BIGINT NOT NULL DEFAULT 200'),
    ('experiments', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('experiment_variants', 'experiment_id', 'experiment_id BIGINT NOT NULL'),
    ('experiment_variants', 'key', 'key TEXT NOT NULL'),
    ('experiment_variants', 'weight', 'weight BIGINT NOT NULL DEFAULT 50'),
    ('experiment_variants', 'payload_json', 'payload_json TEXT NOT NULL DEFAULT ''{}'''),
    ('experiment_variants', 'is_control', 'is_control INTEGER NOT NULL DEFAULT 0'),
    ('experiment_assignments', 'experiment_key', 'experiment_key TEXT NOT NULL'),
    ('experiment_assignments', 'variant_key', 'variant_key TEXT NOT NULL'),
    ('experiment_assignments', 'visitor_id', 'visitor_id TEXT NOT NULL'),
    ('experiment_assignments', 'converted', 'converted INTEGER NOT NULL DEFAULT 0'),
    ('experiment_assignments', 'revenue_cents', 'revenue_cents BIGINT NOT NULL DEFAULT 0'),
    ('experiment_assignments', 'ts', 'ts BIGINT NOT NULL'),
    ('observations', 'location_id', 'location_id BIGINT'),
    ('observations', 'kind', 'kind TEXT NOT NULL'),
    ('observations', 'name', 'name TEXT NOT NULL'),
    ('observations', 'ms', 'ms BIGINT'),
    ('observations', 'status', 'status TEXT NOT NULL DEFAULT ''ok'''),
    ('observations', 'meta_json', 'meta_json TEXT NOT NULL DEFAULT ''{}'''),
    ('observations', 'ts', 'ts BIGINT NOT NULL'),
    ('audit_logs', 'location_id', 'location_id BIGINT'),
    ('audit_logs', 'actor_type', 'actor_type TEXT NOT NULL'),
    ('audit_logs', 'actor_id', 'actor_id BIGINT'),
    ('audit_logs', 'action', 'action TEXT NOT NULL'),
    ('audit_logs', 'entity', 'entity TEXT'),
    ('audit_logs', 'entity_id', 'entity_id BIGINT'),
    ('audit_logs', 'ip', 'ip TEXT'),
    ('audit_logs', 'user_agent', 'user_agent TEXT'),
    ('audit_logs', 'meta_json', 'meta_json TEXT NOT NULL DEFAULT ''{}'''),
    ('audit_logs', 'ts', 'ts BIGINT NOT NULL'),
    ('sessions', 'user_id', 'user_id BIGINT NOT NULL'),
    ('sessions', 'ip', 'ip TEXT'),
    ('sessions', 'user_agent', 'user_agent TEXT'),
    ('sessions', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('sessions', 'expires_ts', 'expires_ts BIGINT NOT NULL'),
    ('sessions', 'revoked_ts', 'revoked_ts BIGINT'),
    ('sessions', 'last_seen_ts', 'last_seen_ts BIGINT'),
    ('rate_buckets', 'bucket_key', 'bucket_key TEXT PRIMARY KEY'),
    ('rate_buckets', 'tokens', 'tokens REAL NOT NULL'),
    ('rate_buckets', 'updated_ts', 'updated_ts BIGINT NOT NULL'),
    ('risk_flags', 'location_id', 'location_id BIGINT NOT NULL'),
    ('risk_flags', 'customer_id', 'customer_id BIGINT'),
    ('risk_flags', 'kind', 'kind TEXT NOT NULL'),
    ('risk_flags', 'severity', 'severity TEXT NOT NULL DEFAULT ''low'''),
    ('risk_flags', 'detail_json', 'detail_json TEXT NOT NULL DEFAULT ''{}'''),
    ('risk_flags', 'status', 'status TEXT NOT NULL DEFAULT ''open'''),
    ('risk_flags', 'ts', 'ts BIGINT NOT NULL'),
    ('requests_deletion', 'location_id', 'location_id BIGINT NOT NULL'),
    ('requests_deletion', 'customer_id', 'customer_id BIGINT'),
    ('requests_deletion', 'email', 'email TEXT'),
    ('requests_deletion', 'phone', 'phone TEXT'),
    ('requests_deletion', 'kind', 'kind TEXT NOT NULL'),
    ('requests_deletion', 'status', 'status TEXT NOT NULL DEFAULT ''open'''),
    ('requests_deletion', 'ip', 'ip TEXT'),
    ('requests_deletion', 'ts', 'ts BIGINT NOT NULL'),
    ('requests_deletion', 'done_ts', 'done_ts BIGINT'),
    ('content_pages', 'location_id', 'location_id BIGINT NOT NULL'),
    ('content_pages', 'slug', 'slug TEXT NOT NULL'),
    ('content_pages', 'kind', 'kind TEXT NOT NULL DEFAULT ''guide'''),
    ('content_pages', 'title', 'title TEXT NOT NULL'),
    ('content_pages', 'summary', 'summary TEXT'),
    ('content_pages', 'body_json', 'body_json TEXT NOT NULL DEFAULT ''[]'''),
    ('content_pages', 'cover_media_id', 'cover_media_id BIGINT'),
    ('content_pages', 'service_key', 'service_key TEXT'),
    ('content_pages', 'faq_json', 'faq_json TEXT NOT NULL DEFAULT ''[]'''),
    ('content_pages', 'seo_title', 'seo_title TEXT'),
    ('content_pages', 'seo_desc', 'seo_desc TEXT'),
    ('content_pages', 'is_published', 'is_published INTEGER NOT NULL DEFAULT 1'),
    ('content_pages', 'reading_min', 'reading_min BIGINT NOT NULL DEFAULT 3'),
    ('content_pages', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('content_pages', 'updated_ts', 'updated_ts BIGINT NOT NULL'),
    ('onboarding', 'location_id', 'location_id BIGINT NOT NULL'),
    ('onboarding', 'step', 'step TEXT NOT NULL'),
    ('onboarding', 'done_json', 'done_json TEXT NOT NULL DEFAULT ''[]'''),
    ('onboarding', 'ts', 'ts BIGINT NOT NULL'),
    ('pending_actions', 'location_id', 'location_id BIGINT NOT NULL'),
    ('pending_actions', 'kind', 'kind TEXT NOT NULL'),
    ('pending_actions', 'payload_json', 'payload_json TEXT NOT NULL DEFAULT ''{}'''),
    ('pending_actions', 'reason', 'reason TEXT'),
    ('pending_actions', 'status', 'status TEXT NOT NULL DEFAULT ''pending'''),
    ('pending_actions', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('pending_actions', 'decided_ts', 'decided_ts BIGINT'),
    ('pending_actions', 'decided_by', 'decided_by BIGINT'),
    ('loyalty_redemptions', 'customer_id', 'customer_id BIGINT NOT NULL'),
    ('loyalty_redemptions', 'reward_id', 'reward_id BIGINT NOT NULL'),
    ('loyalty_redemptions', 'code', 'code TEXT NOT NULL UNIQUE'),
    ('loyalty_redemptions', 'status', 'status TEXT NOT NULL DEFAULT ''issued'''),
    ('loyalty_redemptions', 'issued_ts', 'issued_ts BIGINT NOT NULL'),
    ('loyalty_redemptions', 'redeemed_ts', 'redeemed_ts BIGINT'),
    ('loyalty_redemptions', 'appointment_id', 'appointment_id BIGINT'),
    ('appointment_addons', 'appointment_id', 'appointment_id BIGINT NOT NULL'),
    ('appointment_addons', 'addon_id', 'addon_id BIGINT NOT NULL'),
    ('appointment_addons', 'price_cents', 'price_cents BIGINT NOT NULL'),
    ('appointment_addons', 'duration_min', 'duration_min BIGINT NOT NULL'),
    ('login_codes', 'target', 'target TEXT NOT NULL'),
    ('login_codes', 'channel', 'channel TEXT NOT NULL DEFAULT ''sms'''),
    ('login_codes', 'code_hash', 'code_hash TEXT NOT NULL'),
    ('login_codes', 'attempts', 'attempts BIGINT NOT NULL DEFAULT 0'),
    ('login_codes', 'consumed', 'consumed INTEGER NOT NULL DEFAULT 0'),
    ('login_codes', 'ip', 'ip TEXT'),
    ('login_codes', 'created_ts', 'created_ts BIGINT NOT NULL'),
    ('login_codes', 'expires_ts', 'expires_ts BIGINT NOT NULL'),
    ('scheduler_state', 'key', 'key TEXT PRIMARY KEY'),
    ('scheduler_state', 'value', 'value BIGINT NOT NULL'),
    ('scheduler_state', 'updated_ts', 'updated_ts BIGINT NOT NULL')
  ) AS v(tbl, col, def)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NULL THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.col) THEN CONTINUE; END IF;
    v_def := r.def;
    BEGIN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN %s', r.tbl, v_def);
      n_added := n_added + 1;
    EXCEPTION WHEN OTHERS THEN
      plain := btrim(regexp_replace(v_def, '\s+(UNIQUE|PRIMARY KEY)(\s+AUTOINCREMENT)?', '', 'gi'));
      IF plain = v_def THEN
        v_failed := v_failed || ' ' || r.tbl || '.' || r.col;
      ELSE
        BEGIN
          EXECUTE format('ALTER TABLE public.%I ADD COLUMN %I %s', r.tbl, r.col,
                         btrim(replace(plain, r.col || ' ', '')));
          IF v_def ~* '(UNIQUE|PRIMARY KEY)' THEN
            EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS ux_rattrape_%s_%s ON public.%I (%I)',
                           r.tbl, r.col, r.tbl, r.col);
          END IF;
          n_added := n_added + 1;
          n_relief := n_relief + 1;
        EXCEPTION WHEN OTHERS THEN
          v_failed := v_failed || ' ' || r.tbl || '.' || r.col;
        END;
      END IF;
    END;
  END LOOP;
  RAISE NOTICE 'rattrapage colonnes : % ajoutee(s)%', n_added,
    CASE WHEN n_relief > 0 THEN ' (dont ' || n_relief || ' avec contrainte en ligne reportee sur un index unique ux_rattrape_*)' ELSE '' END;
  IF v_failed <> '' THEN
    RAISE WARNING 'colonnes non ajoutables telles quelles (NOT NULL sans defaut sur table peuplee) :% -- a traiter a la main, avec un DEFAULT le temps de l ALTER', v_failed;
  ELSE
    RAISE NOTICE 'aucune colonne en echec';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_locations_slug ON locations(slug)
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users(lower(email)) WHERE email IS NOT NULL
;
CREATE INDEX IF NOT EXISTS ix_users_loc ON users(location_id, role_key)
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_staff_slug ON staff(location_id, slug)
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_skill ON staff_skills(staff_id, service_id)
;
CREATE INDEX IF NOT EXISTS ix_wh ON working_hours(location_id, staff_id, dow)
;
CREATE INDEX IF NOT EXISTS ix_brk ON shift_breaks(location_id, staff_id, dow)
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_override ON day_overrides(location_id, staff_id, day, kind)
;
CREATE INDEX IF NOT EXISTS ix_override_day ON day_overrides(location_id, day)
;
CREATE INDEX IF NOT EXISTS ix_blocks ON blocks(location_id, staff_id, start_ts, end_ts)
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_service_key ON services(location_id, key)
;
CREATE INDEX IF NOT EXISTS ix_service_active ON services(location_id, is_active, display_order)
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_addon_key ON addons(location_id, key)
;
CREATE INDEX IF NOT EXISTS ix_offering ON offerings(location_id, service_id, staff_id, is_active)
;
CREATE INDEX IF NOT EXISTS ix_media ON media(location_id, kind, service_key)
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cust_phone ON customers(location_id, phone_norm) WHERE deleted_ts IS NULL AND phone_norm IS NOT NULL
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cust_email ON customers(location_id, email_norm) WHERE deleted_ts IS NULL AND email_norm IS NOT NULL
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cust_refcode ON customers(referral_code) WHERE referral_code IS NOT NULL
;
CREATE INDEX IF NOT EXISTS ix_cust_seg ON customers(location_id, segment, last_visit_ts)
;
CREATE INDEX IF NOT EXISTS ix_cust_name ON customers(location_id, last_name, first_name)
;
CREATE INDEX IF NOT EXISTS ix_consent ON consents(location_id, customer_id, purpose, ts)
;
CREATE INDEX IF NOT EXISTS ix_meas ON customer_measurements(customer_id, key)
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_appt_uid ON appointments(external_uid) WHERE external_uid IS NOT NULL
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_appt_slot ON appointments(location_id, staff_id, start_ts) WHERE status IN ('held','pending_payment','booked','confirmed','waiting_client','in_progress')
;
CREATE INDEX IF NOT EXISTS ix_appt_staff ON appointments(staff_id, start_ts, status)
;
CREATE INDEX IF NOT EXISTS ix_appt_day ON appointments(location_id, start_ts, status)
;
CREATE INDEX IF NOT EXISTS ix_appt_cust ON appointments(customer_id, start_ts DESC)
;
CREATE INDEX IF NOT EXISTS ix_appt_open ON appointments(location_id, status, start_ts)
;
CREATE INDEX IF NOT EXISTS ix_aev ON appointment_events(appointment_id, ts)
;
CREATE INDEX IF NOT EXISTS ix_wl ON waitlist(location_id, status, priority DESC, created_ts)
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_wl_open ON waitlist(location_id, phone_norm, service_id) WHERE status = 'active'
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_offer_slot ON waitlist_offers(location_id, staff_id, start_ts) WHERE status IN ('pending','claimed')
;
CREATE INDEX IF NOT EXISTS ix_offer_wl ON waitlist_offers(waitlist_id, status)
;
CREATE INDEX IF NOT EXISTS ix_offer_exp ON waitlist_offers(status, expires_ts)
;
CREATE INDEX IF NOT EXISTS ix_wi ON walkins(location_id, status, queue_rank)
;
CREATE INDEX IF NOT EXISTS ix_pay_appt ON payments(appointment_id, status)
;
CREATE INDEX IF NOT EXISTS ix_member ON memberships(location_id, customer_id, status)
;
CREATE INDEX IF NOT EXISTS ix_ll ON loyalty_ledger(customer_id, ts)
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_ll_once ON loyalty_ledger(appointment_id, reason) WHERE appointment_id IS NOT NULL
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_ref_pair ON referrals(location_id, referrer_id, referee_id) WHERE referee_id IS NOT NULL
;
CREATE INDEX IF NOT EXISTS ix_ref_code ON referrals(location_id, code, status)
;
CREATE INDEX IF NOT EXISTS ix_rev ON reviews(location_id, status, rating)
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_tpl ON templates(location_id, key, channel, lang)
;
CREATE INDEX IF NOT EXISTS ix_notif_due ON notifications(status, send_ts, id)
;
CREATE INDEX IF NOT EXISTS ix_notif_cust ON notifications(location_id, customer_id, created_ts DESC)
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_auto ON automations(location_id, key)
;
CREATE INDEX IF NOT EXISTS ix_camp ON campaigns(location_id, status, scheduled_ts)
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cr ON campaign_recipients(campaign_id, customer_id)
;
CREATE INDEX IF NOT EXISTS ix_draft_open ON booking_drafts(location_id, status, updated_ts)
;
CREATE INDEX IF NOT EXISTS ix_draft_visitor ON booking_drafts(visitor_id, status)
;
CREATE INDEX IF NOT EXISTS ix_funnel ON funnel_events(location_id, kind, ts)
;
CREATE INDEX IF NOT EXISTS ix_funnel_v ON funnel_events(visitor_id, ts)
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_exp ON experiments(location_id, key)
;
CREATE INDEX IF NOT EXISTS ix_expv ON experiment_variants(experiment_id)
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_ea ON experiment_assignments(experiment_key, variant_key, visitor_id)
;
CREATE INDEX IF NOT EXISTS ix_ea_stat ON experiment_assignments(experiment_key, variant_key, converted)
;
CREATE INDEX IF NOT EXISTS ix_obs ON observations(location_id, kind, ts)
;
CREATE INDEX IF NOT EXISTS ix_audit ON audit_logs(location_id, ts)
;
CREATE INDEX IF NOT EXISTS ix_sess_user ON sessions(user_id, expires_ts)
;
CREATE INDEX IF NOT EXISTS ix_rf ON risk_flags(location_id, kind, status)
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_content ON content_pages(location_id, slug)
;
CREATE INDEX IF NOT EXISTS ix_pa ON pending_actions(location_id, status, created_ts)
;
CREATE INDEX IF NOT EXISTS ix_aa ON appointment_addons(appointment_id)
;
CREATE UNIQUE INDEX IF NOT EXISTS ux_lc ON login_codes(target, channel)
;
CREATE INDEX IF NOT EXISTS ix_lc_exp ON login_codes(expires_ts)
;

COMMIT;
