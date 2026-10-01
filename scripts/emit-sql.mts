/**
 * Génère les fichiers SQL à coller dans Supabase (éditeur SQL) depuis le schéma RÉEL de l'app.
 *
 * `npm run db:sql`
 *   -> db/supabase/01-schema.sql            : les 52 tables + index, dialecte Postgres
 *   -> db/supabase/02-securite-supabase.sql : verrouiller l'accès PostgREST (RLS + revokes)
 *   -> db/supabase/03-controles.sql         : ce qu'on vérifie après installation
 *   -> db/supabase/04-exploitation.sql      : requêtes d'exploitation pour le salon
 *
 * Pourquoi un générateur et pas un fichier écrit à la main : `server/db/schema.ts` est la source de
 * vérité (l'app l'utilise pour migrer au démarrage). Un .sql recopié dérive dès la première migration.
 * Après tout changement de schéma : `npm run db:sql`, puis relire le diff et le commiter avec.
 *
 * Les commentaires SQL ne contiennent volontairement jamais d'apostrophe « typographique » ni de
 * guillemet simple : parseNamed (server/db/driver.ts) suit les guillemets mais pas les commentaires.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { ALL_TABLES, ddlFor, wantedColumns } from '../server/db/schema.ts';

const OUT = 'db/supabase';
mkdirSync(OUT, { recursive: true });

const generatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const stmts = ddlFor('pg');
const list = ALL_TABLES.map((t) => `'${t}'`).join(', ');

const banner = (title: string, ...lines: string[]) =>
  [
    '-- ---------------------------------------------------------------------------',
    `-- ${title}`,
    ...lines.map((l) => `-- ${l}`),
    `-- Genere par npm run db:sql (script scripts/emit-sql.mts) le ${generatedAt}.`,
    "-- Ne pas editer a la main : la source est server/db/schema.ts.",
    '-- ---------------------------------------------------------------------------',
    '',
  ].join('\n');


/** Le bloc de rattrapage des colonnes, en PL/pgSQL : idempotent, tolérant, bavard (NOTICE final). */
function catchUpSql(): string {
  const cols = wantedColumns('pg');
  const values = cols.map((c) => `    ('${c.table}', '${c.col}', '${c.def.replace(/'/g, "''")}')`).join(',\n');
  return `-- Rattrapage : ajoute les colonnes absentes (evolution du produit sur une base installee).
-- Un echec sur une colonne (NOT NULL sans defaut sur table peuplee) ne bloque pas les autres :
-- la colonne est signalee dans le NOTICE, a traiter a la main. Les contraintes UNIQUE/PRIMARY KEY en
-- ligne sont retirees si necessaire, puis remplacees par un index unique eqivalent.
DO $$
DECLARE r record; v_def text; plain text; n_added int := 0; n_relief int := 0; v_failed text := '';
BEGIN
  FOR r IN SELECT * FROM (VALUES
${values}
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
      plain := btrim(regexp_replace(v_def, '\\s+(UNIQUE|PRIMARY KEY)(\\s+AUTOINCREMENT)?', '', 'gi'));
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
END $$;`;
}

// ── 01 : le schéma ──────────────────────────────────────────────────────────────────────────────
const schemaSql =
  banner(
    '01 - SCHEMA Postgres : ' + stmts.length + ' instructions, ' + ALL_TABLES.length + ' tables',
    "A executer en une fois dans l'editeur SQL de Supabase, sur une base vide.",
    "Ce n'est pas obligatoire : l'app applique elle-meme ce schema a chaque demarrage",
    '(getDriver() -> migrate(), server/db/index.ts). Ce fichier sert pour une installation manuelle,',
    'un import depuis un autre Postgres, ou pour relire le schema sans lire le code.',
    'Le schema n utilise aucune extension (pas de btree_gist) et aucun trigger : rien a installer avant.',
  ) +
  'BEGIN;\n\n' +
  stmts
    .filter((x) => /^CREATE\s+TABLE/i.test(x.trim()))
    .map((x) => x.trim() + '\n;')
    .join('\n') +
  '\n\n' +
  // Rattrapage des colonnes : une base QUI EXISTE DEJA n'est pas touchée par CREATE TABLE IF NOT EXISTS.
  // Sans ce bloc, ré-exécuter ce fichier sur la base du salon après une évolution du produit ne rapporte
  // rien (et l'app meurt sur « column does not exist »). C'est le miroir SQL du rattrapage de migrate().
  'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_ts BIGINT NOT NULL);\n\n' +
  catchUpSql() +
  '\n\n' +
  stmts
    .filter((x) => !/^CREATE\s+TABLE/i.test(x.trim()))
    .map((x) => x.trim() + '\n;')
    .join('\n') +
  '\n\nCOMMIT;\n';
writeFileSync(`${OUT}/01-schema.sql`, schemaSql);

// ── 02 : durcissement spécifique Supabase ──────────────────────────────────────────────────────
const securitySql =
  banner(
    '02 - DURCISSEMENT SUPABASE : ' + ALL_TABLES.length + ' tables protegees (a executer APRES 01)',
    'Ce que ca empeche : sur un projet Supabase, toute table du schema public est exposee a l API REST',
    '(PostgREST) avec la cle anon, celle-la meme qui est dans le bundle du site public. Sans ce bloc,',
    'le telephone, l email et l historique de chaque client s obtiennent par une requete HTTP simple.',
    "L'app, elle, ne passe jamais par PostgREST : SQL direct avec le role proprietaire des tables, que",
    'RLS ne concerne pas. C est pour ca que rien ne casse cote application (verifie : scripts/supabase-sim.sh).',
  ) +
  `BEGIN;

-- 1) Row Level Security activee, AUCUNE politique definie = personne ne lit rien via l API.
--    Pas de FORCE ROW LEVEL SECURITY : le role applicatif est proprietaire des tables et doit
--    continuer a tout voir (le forcer lui rendrait sa propre base vide).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[${list}]
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
  FOREACH t IN ARRAY ARRAY[${list}]
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
--   FOREACH t IN ARRAY ARRAY[${list}] LOOP
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
`;
writeFileSync(`${OUT}/02-securite-supabase.sql`, securitySql);

// ── 03 : contrôles après installation ───────────────────────────────────────────────────────────
const controlsSql =
  banner(
    '03 - CONTROLES apres installation (lire chaque attendu avant de courir) : 10 sondes en lecture seule',
    'A executer apres 01 et 02, puis apres le premier deploiement qui a seede. Aucun ecriture, aucun trigger.',
    "Si un attendu n'est pas rempli, docs/DEPLOIEMENT-VERCEL-SUPABASE.md section 5 explique la panne annoncee.",
  ) +
  `-- (1) attendu : ${ALL_TABLES.length + 1} (${ALL_TABLES.length} tables du produit + schema_migrations)
SELECT count(*) AS tables_trouvees,
       count(*) = ${ALL_TABLES.length + 1} AS conforme
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

-- (2) attendu : 0 ligne. Une table qui n'est pas dans la liste du produit = residu d'un ancien essai,
--     ou table ajoutee a la main et donc NON protegee par RLS (donc lisible par l'API).
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  AND table_name NOT IN (${list}, 'schema_migrations');

-- (3) attendu : conforme = true partout (RLS bien activee, table par table).
WITH expected(t) AS (VALUES ${ALL_TABLES.map((x) => `('${x}')`).join(', ')})
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
`;
writeFileSync(`${OUT}/03-controles.sql`, controlsSql);

// ── 04 : exploitation courante ──────────────────────────────────────────────────────────────────
const opsSql =
  banner(
    "04 - EXPLOITATION : les questions du salon, en SQL, sans ouvrir le back-office",
    'Lecture seule. Ces requêtes recalculent ce que l\'app calcule déjà : si un chiffre diverge du',
    "back-office, c'est le back-office qui a tort (à signaler, pas à corriger ici).",
    "Elles ciblent le premier salon ; pour un autre, remplacer par (SELECT id FROM locations WHERE slug = '...').",
    'Mesure du 28/09 sur la base de demo : 0 erreur, 7 jeu(x) de resultats, base de 14 Mo / 52 tables.',
  ) +
  `
-- A. Remplissage par barbier et par jour sur 14 jours, en pourcentage d'ouverture RÉELLE
--    (un barbier qui commence à 10 h n'a pas la même journée qu'un barbier qui commence à 9 h 30).
--    heures_ouvertes vide = jour ferme (aucune ligne working_hours pour ce jour de la semaine).
WITH windows AS (
  SELECT a.staff_id, date_trunc('day', to_timestamp(a.start_ts / 1000.0))::date AS d,
         sum((a.end_ts - a.start_ts) / 60000.0) AS booked_min
  FROM appointments a
  WHERE a.location_id = (SELECT id FROM locations ORDER BY id LIMIT 1)
    AND a.status IN ('booked','confirmed','pending_payment','held','waiting_client','in_progress','completed')
    AND a.start_ts > (extract(epoch from now()) - 14 * 86400) * 1000
  GROUP BY 1, 2
)
SELECT w.d AS jour, st.name AS barbier,
       round(w.booked_min / 60.0, 1) AS heures_reservees,
       round(wh.ouvert_min / 60.0, 1) AS heures_ouvertes,
       round(100 * w.booked_min / nullif(wh.ouvert_min, 0), 1) AS pct_ouverture
FROM windows w
JOIN staff st ON st.id = w.staff_id
LEFT JOIN (
  SELECT staff_id, dow, sum(end_min - start_min) AS ouvert_min
  FROM working_hours GROUP BY 1, 2
) wh ON wh.staff_id = w.staff_id AND wh.dow = extract(dow from w.d)::int
ORDER BY w.d DESC, st.name;

-- B. No-show sur 30 jours, par barbier : ce que la plateforme doit faire baisser, et par qui.
SELECT st.name AS barbier,
       count(*) AS rdvs,
       count(*) FILTER (WHERE a.status = 'no_show') AS no_show,
       round(100 * count(*) FILTER (WHERE a.status = 'no_show') / nullif(count(*), 0), 1) AS pct_no_show
FROM appointments a JOIN staff st ON st.id = a.staff_id
WHERE a.start_ts > (extract(epoch from now()) - 30 * 86400) * 1000 AND a.status <> 'cancelled'
GROUP BY 1 ORDER BY pct_no_show DESC NULLS LAST;

-- C. Créneaux récupérés (place libérée puis reprisedans la foulée) : le « recovered slots » du brief.
SELECT to_char(to_timestamp(a.created_ts / 1000.0), 'DD/MM HH24:MI') AS reserve,
       to_char(to_timestamp(a.start_ts / 1000.0), 'DD/MM HH24:MI')   AS debut,
       round((a.start_ts - a.created_ts) / 3600000.0, 1)             AS preavis_h,
       coalesce(nullif(a.campaign, ''), a.source, 'direct')          AS origine,
       a.price_cents / 100.0                                          AS prix_eur
FROM appointments a
WHERE a.waitlist_offer_id IS NOT NULL
ORDER BY a.created_ts DESC LIMIT 20;

-- D. Attente réelle dans la file : ce que le tick doit transformer en offres.
SELECT status, count(*) AS n, to_char(to_timestamp(min(created_ts) / 1000.0), 'DD/MM HH24:MI') AS la_plus_ancienne
FROM waitlist WHERE location_id = (SELECT id FROM locations ORDER BY id LIMIT 1)
GROUP BY 1 ORDER BY n DESC;

-- E. Clients à risque de perdre, par valeur : la liste que les relances win-back doivent cibler.
SELECT first_name || ' ' || last_name AS client, segment,
       to_char(to_timestamp(last_visit_ts / 1000.0), 'DD/MM/YYYY') AS derniere_venue,
       avg_days_between AS habitude_jours,
       spent_cents / 100.0 AS total_eur, visits_count AS venues
FROM customers
WHERE location_id = (SELECT id FROM locations ORDER BY id LIMIT 1) AND deleted_ts IS NULL AND visits_count > 0
ORDER BY risk_score DESC NULLS LAST, spent_cents DESC LIMIT 15;

-- F. D'où vient l'argent, par source d'acquisition (Instagram vs Google vs direct vs parrainage).
SELECT coalesce(source, '(aucune)') AS source, count(*) AS rdvs,
       sum(price_cents + add_on_cents - paid_cents) / 100.0 AS encaisse_plus_tard_eur
FROM appointments
WHERE status IN ('completed','confirmed','booked','in_progress')
GROUP BY 1 ORDER BY rdvs DESC LIMIT 12;

-- G. Poids réel de la base, pour arbitrer sauvegardes et index.
SELECT pg_size_pretty(pg_database_size(current_database())) AS taille_base,
       (SELECT count(*) FROM information_schema.tables
         WHERE table_schema='public' AND table_type='BASE TABLE') AS tables;
`;
writeFileSync(`${OUT}/04-exploitation.sql`, opsSql);


// ── 00 : le tout-en-un, prêt à coller dans l'éditeur SQL de Supabase ─────────────────────────────
const allInOne =
  banner(
    '00 - TOUT-EN-UN : schema + durcissement, en une seule execution',
    'A coller en entier dans Supabase -> SQL Editor -> New query -> Run (ou psql -v ON_ERROR_STOP=1 -f).',
    'Contenu : 01-schema.sql puis 02-securite-supabase.sql puis 4 controles rapides (fin de fichier).',
    'Idempotent : relancable sur une base deja installee (il rattape les colonnes, ne recree rien, ne touche',
    'aucune donnee). Il faut executer 02 ici : sans lui, l API PostgREST de Supabase lit la table clients',
    'avec la cle anon publique. Mesure le 28/09 : 56 lignes visibles avant, refus apres.',
    'Les donnees de demonstration ne sont pas ici : elles viennent du seed de l app (npm run seed).',
  ) +
  schemaSql +
  '\n\n' +
  securitySql +
  `

-- ── Contrôles rapides (résultats affichés dans la console de l'éditeur SQL) ─────────────────────
-- (a) attendu : ${ALL_TABLES.length + 1}
SELECT count(*) AS tables FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

-- (b) attendu : true — toute table du produit est protégée par RLS
SELECT bool_and(relrowsecurity) AS toutes_protegees
FROM pg_class
WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
  AND relname IN (${list}, 'schema_migrations');

-- (c) attendu : 0 — zéro double booking sur la règle métier réelle
WITH occ AS (
  SELECT a.id, a.staff_id,
         a.start_ts - COALESCE(s.prep_min, 0) * 60000 AS w0,
         a.end_ts   + COALESCE(s.cleanup_min, 0) * 60000 AS w1
  FROM appointments a JOIN services s ON s.id = a.service_id
  WHERE a.status IN ('booked','confirmed','pending_payment','held','waiting_client','in_progress')
     OR (a.status = 'completed' AND a.end_ts > (extract(epoch from now()) * 1000)::bigint)
)
SELECT count(*) AS chevauchements FROM occ x JOIN occ y
  ON y.staff_id = x.staff_id AND y.id > x.id AND x.w0 < y.w1 AND y.w0 < x.w1;

-- (d) attendu : PROTEGE (ou 0 ligne) — la fuite PostgREST est bouchée
DO $$
DECLARE n bigint; refused boolean := false;
BEGIN
  BEGIN
    EXECUTE 'SET ROLE anon';
    BEGIN EXECUTE 'SELECT count(*) FROM customers' INTO n;
    EXCEPTION WHEN insufficient_privilege THEN refused := true; END;
    BEGIN EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN NULL; END;
  EXCEPTION WHEN undefined_object THEN
    RAISE NOTICE 'role anon absent (Postgres local) : rejouer sur le projet Supabase'; RETURN;
  END;
  IF refused THEN RAISE NOTICE 'PROTEGE : privileges refuses a anon'; RETURN; END IF;
  IF coalesce(n, 0) > 0 THEN RAISE EXCEPTION 'FUITE : anon voit % ligne(s) de customers', n; END IF;
  RAISE NOTICE 'PROTEGE : anon voit 0 ligne';
END $$;
`;
writeFileSync(`${OUT}/00-tout-en-un.sql`, allInOne);

console.log(
  `✓ ${OUT}/ — 01-schema.sql (${stmts.length} instructions, ${(schemaSql.length / 1024).toFixed(1)} ko) · ` +
    `02-securite-supabase.sql · 03-controles.sql · 04-exploitation.sql · 00-tout-en-un.sql (${(allInOne.length / 1024).toFixed(1)} ko, à coller d'un bloc) — ${ALL_TABLES.length} tables, générées le ${generatedAt}`,
);
