-- ---------------------------------------------------------------------------
-- 03 - CONTROLES apres installation (lire chaque attendu avant de courir) : 10 sondes en lecture seule
-- A executer apres 01 et 02, puis apres le premier deploiement qui a seede. Aucun ecriture, aucun trigger.
-- Si un attendu n'est pas rempli, docs/DEPLOIEMENT-VERCEL-SUPABASE.md section 5 explique la panne annoncee.
-- Genere par npm run db:sql (script scripts/emit-sql.mts) le 2026-09-28 15:45 UTC.
-- Ne pas editer a la main : la source est server/db/schema.ts.
-- ---------------------------------------------------------------------------
-- (1) attendu : 52 (51 tables du produit + schema_migrations)
SELECT count(*) AS tables_trouvees,
       count(*) = 52 AS conforme
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

-- (2) attendu : 0 ligne. Une table qui n'est pas dans la liste du produit = residu d'un ancien essai,
--     ou table ajoutee a la main et donc NON protegee par RLS (donc lisible par l'API).
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  AND table_name NOT IN ('tenants', 'locations', 'users', 'staff', 'staff_skills', 'working_hours', 'shift_breaks', 'day_overrides', 'blocks', 'services', 'addons', 'offerings', 'media', 'customers', 'consents', 'customer_measurements', 'appointments', 'appointment_events', 'waitlist', 'waitlist_offers', 'walkins', 'payments', 'gift_cards', 'memberships', 'loyalty_rewards', 'loyalty_ledger', 'referrals', 'reviews', 'templates', 'notifications', 'automations', 'campaigns', 'campaign_recipients', 'booking_drafts', 'funnel_events', 'experiments', 'experiment_variants', 'experiment_assignments', 'observations', 'audit_logs', 'sessions', 'rate_buckets', 'risk_flags', 'requests_deletion', 'content_pages', 'onboarding', 'pending_actions', 'loyalty_redemptions', 'appointment_addons', 'login_codes', 'scheduler_state', 'schema_migrations');

-- (3) attendu : conforme = true partout (RLS bien activee, table par table).
WITH expected(t) AS (VALUES ('tenants'), ('locations'), ('users'), ('staff'), ('staff_skills'), ('working_hours'), ('shift_breaks'), ('day_overrides'), ('blocks'), ('services'), ('addons'), ('offerings'), ('media'), ('customers'), ('consents'), ('customer_measurements'), ('appointments'), ('appointment_events'), ('waitlist'), ('waitlist_offers'), ('walkins'), ('payments'), ('gift_cards'), ('memberships'), ('loyalty_rewards'), ('loyalty_ledger'), ('referrals'), ('reviews'), ('templates'), ('notifications'), ('automations'), ('campaigns'), ('campaign_recipients'), ('booking_drafts'), ('funnel_events'), ('experiments'), ('experiment_variants'), ('experiment_assignments'), ('observations'), ('audit_logs'), ('sessions'), ('rate_buckets'), ('risk_flags'), ('requests_deletion'), ('content_pages'), ('onboarding'), ('pending_actions'), ('loyalty_redemptions'), ('appointment_addons'), ('login_codes'), ('scheduler_state'))
SELECT e.t AS table_attendue, c.relrowsecurity AS rls_active,
       (c.oid IS NOT NULL AND c.relrowsecurity) AS conforme
FROM expected e
LEFT JOIN pg_class c ON c.relname = e.t AND c.relnamespace = 'public'::regnamespace
ORDER BY conforme NULLS FIRST, e.t;

-- (4) LA preuve que la fuite est bouchee : le role applicatif voit ses lignes, anon ne voit RIEN —
--     soit 0 ligne (privilege garde mais RLS sans politique), soit « permission denied » (02 a revoque).
--     Les DEUX sont un succes. Sur un Postgres local sans le role anon, la sonde s'arrete sur un NOTICE.
DO $$
DECLARE n_owner bigint; n_anon bigint; refused boolean := false;
BEGIN
  EXECUTE 'SELECT count(*) FROM customers' INTO n_owner;
  BEGIN
    EXECUTE 'SET ROLE anon';
    BEGIN
      EXECUTE 'SELECT count(*) FROM customers' INTO n_anon;
    EXCEPTION WHEN insufficient_privilege THEN
      refused := true;
    END;
    BEGIN EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN NULL; END;
  EXCEPTION WHEN undefined_object THEN
    RAISE NOTICE 'role anon absent : rejouer cette sonde sur le vrai projet Supabase'; RETURN;
  END;
  IF refused THEN
    RAISE NOTICE 'PROTEGE : le proprietaire voit % ligne(s), anon se voit refuser la table', n_owner;
    RETURN;
  END IF;
  RAISE NOTICE 'proprietaire : % ligne(s) ; via anon : % ligne(s) ; attendu 0', n_owner, n_anon;
  IF coalesce(n_anon, -1) > 0 THEN RAISE EXCEPTION 'FUITE : anon lit % lignes de la table clients', n_anon; END IF;
END $$;

-- (5) ZERO DOUBLE BOOKING, sur la regle metier reelle : fenetre = debut - preparation -> fin + nettoyage,
--     et un RDV completed occupe encore le fauteuil tant que sa fin n'est pas passee. attendu : 0.
WITH occ AS (
  SELECT a.id, a.staff_id,
         a.start_ts - COALESCE(s.prep_min, 0) * 60000 AS w0,
         a.end_ts   + COALESCE(s.cleanup_min, 0) * 60000 AS w1
  FROM appointments a JOIN services s ON s.id = a.service_id
  WHERE a.status IN ('booked','confirmed','pending_payment','held','waiting_client','in_progress')
     OR (a.status = 'completed' AND a.end_ts > (extract(epoch from now()) * 1000)::bigint)
)
SELECT count(*) AS chevauchements_vus_par_le_moteur
FROM occ x JOIN occ y ON y.staff_id = x.staff_id AND y.id > x.id
 AND x.w0 < y.w1 AND y.w0 < x.w1;

-- (6) attendu : 0. Une fiche passee qui garde un statut ouvert = fauteuil bloque pour rien.
SELECT count(*) AS rdvs_ouverts_passes FROM appointments
WHERE end_ts < (extract(epoch from now()) * 1000)::bigint
  AND status IN ('booked','confirmed','pending_payment','held','waiting_client','in_progress');

-- (7) ZERO FAUSSE RARETE : un avis public doit venir d'un canal verifiable. attendu : 0.
SELECT count(*) AS avis_public_sans_canal_reel FROM reviews
WHERE visibility = 'public' AND channel NOT IN ('google', 'planity', 'google_maps');

-- (8) Le tick des automations tourne-t-il ? attendu : il_y_a_min petit en journees ouvrables.
--     Sinon le cron ne tombe pas (vercel.json ne peut pas faire mieux sur Hobby : voir le relais GitHub).
SELECT key, to_timestamp(value / 1000.0) AS dernier_passage,
       round((extract(epoch from now()) - value / 1000.0) / 60) AS il_y_a_min
FROM scheduler_state ORDER BY key;

-- (9) Files de notifications : des failed qui montent = fournisseur email/SMS casse, pas l'application.
SELECT status, channel, count(*) AS n
FROM notifications GROUP BY 1, 2 ORDER BY 3 DESC;

-- (10) Places recuperees : annulation suivie d'une offre de waitlist. Un taux bas = le « zero demande
--      perdue » n'a pas morde en production.
SELECT date_trunc('day', to_timestamp(cancelled_ts / 1000.0))::date AS jour,
       count(*) AS annulations,
       count(*) FILTER (WHERE waitlist_offer_id IS NOT NULL) AS avec_offre_waitlist
FROM appointments WHERE status = 'cancelled' AND cancelled_ts IS NOT NULL
GROUP BY 1 ORDER BY 1 DESC LIMIT 14;
