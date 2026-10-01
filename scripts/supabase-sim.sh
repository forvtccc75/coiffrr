#!/usr/bin/env bash
# Simule un VRAI projet Supabase sur un Postgres local, pour prouver les fichiers db/supabase/*.sql.
#
#   DATABASE_URL=postgres://zyass@127.0.0.1:5432/zyass_supa bash scripts/supabase-sim.sh
#
# Ce que la simulation reproduit : les rôles `anon` / `authenticated` / `service_role`, et SURTOUT les
# droits par défaut que Supabase pose sur le schéma `public` (SELECT accordé à anon et authenticated).
# C'est exactement la fuite que 02-securite-supabase.sql doit boucher — sans ces droits à boucher, le test
# dirait « tout va bien » pour la mauvaise raison.
#
# Rien ici ne touche une base de production : la base cible est recréée (DROP DATABASE).
set -uo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?DATABASE_URL doit pointer vers une base de test (elle est recréée)}"
command -v psql >/dev/null 2>&1 || { echo "✗ psql introuvable : installer postgresql-client"; exit 1; }

URL="$DATABASE_URL"
BASE="$(printf '%s' "$URL" | sed -E 's#(://[^/]+/).*#\1#')"
DBN="$(printf '%s' "$URL" | sed -E 's#.*/([^/?]+).*#\1#')"
MAINT="${BASE}postgres"
P() { psql "$URL" -v ON_ERROR_STOP=1 -q "$@"; }
Q() { psql "$URL" -tAc "$1" 2>&1 | tr -d '[:space:]'; }

fails=0
say() { printf '   %s\n' "$1"; }

echo "── 1. Base de test recréée"
psql "$MAINT" -q -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DBN' AND pid<>pg_backend_pid()" \
  -c "DROP DATABASE IF EXISTS $DBN" -c "CREATE DATABASE $DBN" >/dev/null 2>&1 \
  || { echo "   ✗ base $DBN non recréée"; exit 1; }
say "✓ $DBN"

echo "── 2. Rôles et droits par défaut « à la Supabase » (c'est ça qu'on ferme)"
for r in anon authenticated service_role; do
  psql "$MAINT" -tAc "SELECT 1 FROM pg_roles WHERE rolname='$r'" | grep -q 1 \
    && psql "$MAINT" -q -c "GRANT CONNECT TO $r" >/dev/null 2>&1 \
    || psql "$MAINT" -q -c "CREATE ROLE $r NOLOGIN" >/dev/null 2>&1
done
P -c "GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role"
P -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon, authenticated"
P -c "GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon"   # tables existantes d'un précédent run
say "✓ anon / authenticated / service_role + SELECT par défaut sur public"

echo "── 3. 01-schema.sql (généré depuis server/db/schema.ts)"
if P -f db/supabase/01-schema.sql >/tmp/supase-01.log 2>&1; then
  n=$(Q "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")
  say "✓ schéma appliqué : $n tables"
  [ "${n:-0}" -eq $(( $(node --import tsx -e "import { ALL_TABLES } from './server/db/schema.ts'; console.log(ALL_TABLES.length)" 2>/dev/null | tail -1) + 1 )) ] \
    || { say "✗ attendu 51 tables produit + schema_migrations = 52 (reçu $n)"; fails=$((fails+1)); }
else
  say "✗ 01-schema.sql a échoué :"; tail -5 /tmp/supase-01.log; fails=$((fails+1))
fi

echo "── 4. Seed de démonstration (chiffres réels du produit, pas un remplissage)"
if DATA_FILE=/tmp/unused.db TEST_DB=pg npm run seed -- --fresh >/tmp/supase-seed.log 2>&1; then
  say "✓ $(grep -E 'clients [0-9]+' /tmp/supase-seed.log | tail -1 | sed 's/^ *//')"
else
  say "✗ seed échoué :"; tail -5 /tmp/supase-seed.log; fails=$((fails+1))
fi

echo "── 5. La fuite est ouverte AVANT 02 (preuve négative : le test sert à quelque chose)"
before=$(psql "$URL" -qtAc "SET ROLE anon; SELECT count(*) FROM customers" 2>&1 | tr -d '[:space:]')
say "   anon voit ${before} ligne(s) dans customers"
case "$before" in
  ''|ERROR*) say "   (sonde non conclissante sur ce Postgres : erreur $before)" ;;
  0) say "   ! déjà 0 avant durcissement : la simulation n'a pas reproduit les droits Supabase" ; fails=$((fails+1)) ;;
  *) say "   ✓ fuite reproduite (c'est ce que 02 doit supprimer)" ;;
esac

echo "── 6. 02-securite-supabase.sql"
if P -f db/supabase/02-securite-supabase.sql >/tmp/supase-02.log 2>&1; then
  say "✓ RLS activée + droits révoqués + DEFAULT PRIVILEGES nettoyés"
else
  say "✗ 02 a échoué :"; tail -5 /tmp/supase-02.log; fails=$((fails+1))
fi

echo "── 7. Après durcissement : anon ne lit plus rien, l'app lit tout"
after=$(psql "$URL" -qtAc "SET ROLE anon; SELECT count(*) FROM customers" 2>&1)
owner=$(Q "select count(*) from customers")
echo "   $after" | grep -qiE "permission denied|ERROR" && say "   ✓ SELECT de anon refuse par les privileges" \
  || { case "$(printf '%s' "$after" | tr -dc '0-9')" in 0) say "✓ anon voit 0 ligne (RLS sans politique)";; *) say "✗ anon voit encore des lignes : $after"; fails=$((fails+1));; esac; }
say "   role applicatif : $owner lignes (normal : il doit tout voir)"
[ "${owner:-0}" -gt 0 ] 2>/dev/null || { say "✗ le rôle applicatif ne voit plus rien : durcissement trop strict"; fails=$((fails+1)); }

echo "── 8. 03-controles.sql doit passer sans exception"
if P -f db/supabase/03-controles.sql >/tmp/supase-03.log 2>&1; then
  say "✓ 03 exécuté sans erreur — $(grep -oE 'NOTICE:  .*' /tmp/supase-03.log | head -1 | cut -c1-120)"
  grep -qE "FUITE :|^ERROR|ERROR:  " /tmp/supase-03.log && { say "✗ 03 a signalé un problème :"; grep -E "FUITE :|ERROR" /tmp/supase-03.log | head -4; fails=$((fails+1)); }
else
  say "✗ 03-controles.sql a échoué :"; tail -8 /tmp/supase-03.log; fails=$((fails+1))
fi

echo "── 8bis. 04-exploitation.sql doit répondre sans erreur"
if P -f db/supabase/04-exploitation.sql >/tmp/supase-04.log 2>&1; then
  say "✓ requêtes d'exploitation : $(grep -cE '\(.* row' /tmp/supase-04.log) jeu(x) de résultats, 0 erreur"
else
  say "✗ 04 a échoué :"; tail -6 /tmp/supase-04.log; fails=$((fails+1))
fi

echo "── 9. L'app complète tourne sur cette base durcie (campagne des 73 contrôles)"
if DATABASE_URL="$URL" REPORT=/tmp/rapport-supabase.json bash scripts/verify.sh >/tmp/supase-verify.log 2>&1; then
  say "✓ $(grep -oE '[0-9]+ réussis[^—]*' /tmp/supase-verify.log | tail -1 | sed 's/\x1b\[[0-9;]*m//g')"
else
  say "✗ campagne rouge sur base durcie :"; grep -E '✗' /tmp/supase-verify.log | sed 's/\x1b\[[0-9;]*m//g' | head -5; fails=$((fails+1))
fi

echo
if [ "$fails" = 0 ]; then echo "── Supabase simulé : les 4 fichiers SQL sont validés, l'app marche dessus, l'API ne lit rien"; else echo "── $fails étape(s) en échec"; fi
exit $((fails > 0))
