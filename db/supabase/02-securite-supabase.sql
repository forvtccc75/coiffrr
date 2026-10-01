-- ---------------------------------------------------------------------------
-- 02 - DURCISSEMENT SUPABASE : 51 tables protegees (a executer APRES 01)
-- Ce que ca empeche : sur un projet Supabase, toute table du schema public est exposee a l API REST
-- (PostgREST) avec la cle anon, celle-la meme qui est dans le bundle du site public. Sans ce bloc,
-- le telephone, l email et l historique de chaque client s obtiennent par une requete HTTP simple.
-- L'app, elle, ne passe jamais par PostgREST : SQL direct avec le role proprietaire des tables, que
-- RLS ne concerne pas. C est pour ca que rien ne casse cote application (verifie : scripts/supabase-sim.sh).
-- Genere par npm run db:sql (script scripts/emit-sql.mts) le 2026-09-28 15:45 UTC.
-- Ne pas editer a la main : la source est server/db/schema.ts.
-- ---------------------------------------------------------------------------
BEGIN;

-- 1) Row Level Security activee, AUCUNE politique definie = personne ne lit rien via l API.
--    Pas de FORCE ROW LEVEL SECURITY : le role applicatif est proprietaire des tables et doit
--    continuer a tout voir (le forcer lui rendrait sa propre base vide).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants', 'locations', 'users', 'staff', 'staff_skills', 'working_hours', 'shift_breaks', 'day_overrides', 'blocks', 'services', 'addons', 'offerings', 'media', 'customers', 'consents', 'customer_measurements', 'appointments', 'appointment_events', 'waitlist', 'waitlist_offers', 'walkins', 'payments', 'gift_cards', 'memberships', 'loyalty_rewards', 'loyalty_ledger', 'referrals', 'reviews', 'templates', 'notifications', 'automations', 'campaigns', 'campaign_recipients', 'booking_drafts', 'funnel_events', 'experiments', 'experiment_variants', 'experiment_assignments', 'observations', 'audit_logs', 'sessions', 'rate_buckets', 'risk_flags', 'requests_deletion', 'content_pages', 'onboarding', 'pending_actions', 'loyalty_redemptions', 'appointment_addons', 'login_codes', 'scheduler_state']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;

-- 2) On retire les droits que Supabase accorde par defaut a anon et authenticated sur public.
--    Chaque REVOKE est protege : sur un Postgres hors Supabase, ces roles n existent pas.
DO $$
DECLARE t text; r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants', 'locations', 'users', 'staff', 'staff_skills', 'working_hours', 'shift_breaks', 'day_overrides', 'blocks', 'services', 'addons', 'offerings', 'media', 'customers', 'consents', 'customer_measurements', 'appointments', 'appointment_events', 'waitlist', 'waitlist_offers', 'walkins', 'payments', 'gift_cards', 'memberships', 'loyalty_rewards', 'loyalty_ledger', 'referrals', 'reviews', 'templates', 'notifications', 'automations', 'campaigns', 'campaign_recipients', 'booking_drafts', 'funnel_events', 'experiments', 'experiment_variants', 'experiment_assignments', 'observations', 'audit_logs', 'sessions', 'rate_buckets', 'risk_flags', 'requests_deletion', 'content_pages', 'onboarding', 'pending_actions', 'loyalty_redemptions', 'appointment_addons', 'login_codes', 'scheduler_state']
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated']
    LOOP
      BEGIN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r);
      EXCEPTION WHEN undefined_object THEN NULL;
      END;
    END LOOP;
  END LOOP;
END $$;

-- 3) Idem pour les tables des prochaines migrations : sinon l etape 2 est a refaire a chaque table,
--    et une table oubliee est une fuite oubliee.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    BEGIN
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
    EXCEPTION WHEN undefined_object THEN NULL;
    END;
  END LOOP;
END $$;

COMMIT;

-- Option A, recommandee si aucune donnee n est servie par l API Supabase : couper l acces au schema
-- lui-meme. PostgREST repond 404 sur toutes nos tables ; le Table Editor du tableau de bord continue
-- de fonctionner (il est connecte en postgres, pas en anon). Decommenter pour appliquer.
-- BEGIN;
-- DO $$ DECLARE r text; BEGIN
--   FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
--     BEGIN EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', r);
--     EXCEPTION WHEN undefined_object THEN NULL; END;
--   END LOOP;
-- END $$;
-- COMMIT;

-- Option B, si une cle service_role circule dans des outils tiers : service_role outrepasse RLS, sa
-- fuite = lecture complete. A ne faire que si l app n utilise pas l API Supabase avec cette cle (elle
-- ne l utilise pas : connexion SQL directe).
-- BEGIN;
-- DO $$ DECLARE t text; BEGIN
--   FOREACH t IN ARRAY ARRAY['tenants', 'locations', 'users', 'staff', 'staff_skills', 'working_hours', 'shift_breaks', 'day_overrides', 'blocks', 'services', 'addons', 'offerings', 'media', 'customers', 'consents', 'customer_measurements', 'appointments', 'appointment_events', 'waitlist', 'waitlist_offers', 'walkins', 'payments', 'gift_cards', 'memberships', 'loyalty_rewards', 'loyalty_ledger', 'referrals', 'reviews', 'templates', 'notifications', 'automations', 'campaigns', 'campaign_recipients', 'booking_drafts', 'funnel_events', 'experiments', 'experiment_variants', 'experiment_assignments', 'observations', 'audit_logs', 'sessions', 'rate_buckets', 'risk_flags', 'requests_deletion', 'content_pages', 'onboarding', 'pending_actions', 'loyalty_redemptions', 'appointment_addons', 'login_codes', 'scheduler_state'] LOOP
--     IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
--     BEGIN EXECUTE format('REVOKE ALL ON public.%I FROM service_role', t);
--     EXCEPTION WHEN undefined_object THEN NULL; END;
--   END LOOP;
-- END $$;
-- COMMIT;

-- Option C, plus propre qu un role postgres plein pouvoir : un role applicatif limite, a creer une fois,
-- puis DATABASE_URL pointe sur lui. Il ne peut ni creer de table ni toucher aux autres schemas.
-- CREATE ROLE zyass_app LOGIN PASSWORD 'a-remplacer-par-32-caracteres-aleatoires';
-- GRANT USAGE ON SCHEMA public TO zyass_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO zyass_app;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO zyass_app;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO zyass_app;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO zyass_app;
