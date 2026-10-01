#!/usr/bin/env bash
# Vérifie l'app sur un VRAI Postgres : schéma, seed, suite de tests file par file (base fraîche),
# puis serveur live + 18 contrôles HTTP. Usage : DATABASE_URL=postgres://... bash scripts/pg-check.sh
set -uo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?DATABASE_URL doit pointer vers une base Postgres de test (jamais la prod)}"
URL="$DATABASE_URL"
q() { psql "$URL" -tAc "$1" 2>&1; }
strip() { printf '%s' "$1" | sed -E 's#(://[^/]+/).*#\1#'; }
db_name() { printf '%s' "$1" | sed -E 's#.*/([^/?]+).*#\1#'; }
BASE="$(strip "$URL")"; DB="$(db_name "$URL")"
MAINT="${BASE}postgres"   # DROP/CREATE se font connecté à une autre base que la cible
export PGPASSWORD="${PGPASSWORD:-}"

echo "── 0. Permet de recréer la base de test"
q "ALTER ROLE CURRENT_USER CREATEDB" >/dev/null 2>&1 || true

recreate() {
  psql "$MAINT" -q -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB' AND pid<>pg_backend_pid()" -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/tmp/pgcheck-recreate.log 2>&1 \
    || { echo "   ! base non recréée (voir /tmp/pgcheck-recreate.log) : réutilisée telle quelle"; }
}

fails=0
echo "── 1. Schéma (migrate doit SORTIR, pas hang)"
recreate
t0=$(date +%s%N)
if TEST_DB=pg npm run migrate >/tmp/pgcheck-migrate.log 2>&1; then
  tables=$(q "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'" | tr -d '[:space:]')
  echo "   ✓ schéma : $tables tables en $(( ($(date +%s%N)-t0)/1000000 )) ms"
  [ "${tables:-0}" -ge 45 ] || { echo "   ✗ attendu ≥ 45 tables"; fails=$((fails+1)); }
else
  echo "   ✗ migrate a échoué :"; tail -4 /tmp/pgcheck-migrate.log; fails=$((fails+1))
fi

echo "── 2. Seed de démo"
if TEST_DB=pg npm run seed -- --fresh >/tmp/pgcheck-seed.log 2>&1; then
  echo "   ✓ $(grep -E 'clients [0-9]+' /tmp/pgcheck-seed.log | tail -1 | sed 's/^ *//')"
else
  echo "   ✗ seed a échoué :"; tail -4 /tmp/pgcheck-seed.log; fails=$((fails+1))
fi

echo "── 3. Suite de tests unitaires, un fichier à la fois (base fraîche à chaque fois)"
for f in tests/*.test.ts; do
  recreate
  TEST_DB=pg NODE_ENV=test npm run migrate >/dev/null 2>&1
  if out=$(TEST_DB=pg NODE_ENV=test timeout 300 node --import tsx --test "$f" 2>&1); then
    printf "   ✓ %-28s %s\n" "$(basename "$f")" "$(printf '%s' "$out" | grep -E '^# pass' | tr -d '\n' | sed 's/# //')"
  else
    printf "   ✗ %-28s %s\n" "$(basename "$f")" "$(printf '%s' "$out" | grep -E '^# fail' | sed 's/# //')"
    printf '%s\n' "$out" | grep -E "^\s+(Error|error|AssertionError|expected)" | head -3 | sed 's/^/       /'
    fails=$((fails+1))
  fi
done

echo "── 4. Serveur live sur Postgres + contrôles HTTP"
recreate
TEST_DB=pg npm run migrate >/dev/null 2>&1; TEST_DB=pg npm run seed -- --fresh >/dev/null 2>&1
export PORT=${PGCHECK_PORT:-8791}
DEMO_MODE=1 NODE_ENV=development TRUST_PROXY=0 \
  SESSION_SECRET=abcdefghijabcdefghijabcdefghij TOKEN_SECRET=klmnopqrstklmnopqrstklmnopqrst CRON_SECRET=cron-secret-test \
  node --import tsx server/index.ts >/tmp/pgcheck-server.log 2>&1 &
srv=$!
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 0.5; done
if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null; then
  echo "   ✓ healthz : $(curl -s http://127.0.0.1:$PORT/healthz | head -c 120)"
  cron=$(curl -s -X POST "http://127.0.0.1:$PORT/api/internal/cron?secret=cron-secret-test")
  case "$cron" in *'"error"'*) echo "   ✗ cron : $cron"; fails=$((fails+1));; *) echo "   ✓ cron : $(printf '%s' "$cron" | head -c 140)";; esac
  # --local démarrera SA propre API sur un port figé : on lui passe plutôt la nôtre via BASE_URL.
  if out=$(BASE_URL="http://127.0.0.1:$PORT" timeout 600 bash scripts/smoke.sh 2>&1 | tail -2); then
    printf '%s\n' "$out" | sed 's/^/   /'
    printf '%s\n' "$out" | grep -q "0 échoués" || { echo "   ✗ smoke HTTP sur Postgres"; fails=$((fails+1)); }
  else
    echo "   ✗ smoke HTTP interrompu (timeout ?)"; fails=$((fails+1))
  fi
  q "select count(*) from observations where status='error'" | grep -q '^0$' && echo "   ✓ observations : 0 erreur enregistrée" || echo "   ! observations en erreur : $(q "select name||' → '||left(meta_json,80) from observations where status='error' order by id desc limit 3")"
else
  echo "   ✗ serveur non démarré :"; tail -5 /tmp/pgcheck-server.log; fails=$((fails+1))
fi
kill $srv 2>/dev/null; wait $srv 2>/dev/null

echo "── $([ $fails -eq 0 ] && echo 'Postgres : tout est vert' || echo "$fails étape(s) en échec")"
exit $fails
