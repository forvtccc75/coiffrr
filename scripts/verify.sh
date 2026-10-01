#!/usr/bin/env bash
# Vérification fonctionnelle SUR UNE BASE NEUVE ET ISOLÉE.
#
# Pourquoi un environnement jetable : le vérificateur crée des clients, des RDV, des blocages,
# des salons. Sur une base qui a déjà servi, le « premier créneau libre » du jour change d'occupé
# à chaque passage, et un contrôle au hasard devient rouge pour une mauvaise raison. Une base neuve
# rend le résultat reproductible — et protège la base de démo présentée au client.
#
#   bash scripts/verify.sh              # SQLite dans un fichier jetable (/tmp)
#   DATABASE_URL=postgres://… \
#     bash scripts/verify.sh            # même campagne de contrôles sur Postgres
#   bash scripts/verify.sh 3            # un seul groupe (préfixe) : 1, 3, 10…
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PORT="${PORT:-8899}"
RUNDB="${RUNDB:-/tmp/verif-features.db}"
REPORT="${REPORT:-data/rapport-fonctionnalites.json}"
LOG="/tmp/verif-server-$PORT.log"
PG_MODE=0
case "${DATABASE_URL:-}" in postgres*|pgsql*) PG_MODE=1 ;; esac

# tsx et dist/ ne survivent pas toujours au recyclage du bac à sable : on les remet si besoin.
[ -d node_modules/tsx ] || npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null 2>&1
[ -f dist/client/index.html ] || npm run build >/dev/null 2>&1 || true

say() { printf '\n\033[1m— %s\033[0m\n' "$1"; }

# Un port déjà pris n'est pas un détail : le serveur de la campagne précédente répondrait aux
# requêtes avec une base qui a déjà servi, et les contrôles « créneau libéré », « aucun
# chevauchement », « cron idempotent » virent au rouge pour la mauvaise raison. On refuse de
# démarrer là-dessus plutôt que d'afficher un échec mensonger.
if curl -fsS -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "X port $PORT deja occupe par un serveur (base residuelle fausserait les controles)." >&2
  echo "  liberez-le : pkill -f \"server/index.ts\" && rm -f $RUNDB*   puis relancez." >&2
  exit 2
fi

if [ "$PG_MODE" = 1 ]; then
  say "1/3 base Postgres de vérification ($DATABASE_URL — attention : elle est PURGÉE)"
  # Si la base de test n'existe pas encore, on la crée (connecté à `postgres`, comme dans pg-check.sh) :
  # sans ça, `npm run verify:pg` échoue sur un simple « database does not exist » et on croit que
  # la voie Postgres est cassée.
  if command -v psql >/dev/null 2>&1; then
    DBURL="$DATABASE_URL"
    BASE="$(printf '%s' "$DBURL" | sed -E 's#(://[^/]+/).*#\1#')"
    DBN="$(printf '%s' "$DBURL" | sed -E 's#.*/([^/?]+).*#\1#')"
    psql "${BASE}postgres" -q -c "CREATE DATABASE $DBN" >/dev/null 2>&1 || true
    psql "$DBURL" -q -c "CREATE EXTENSION IF NOT EXISTS btree_gist" >/dev/null 2>&1 || true
  fi
  if ! { npm run migrate && npm run seed -- --fresh; } >"$LOG" 2>&1; then
    echo "migration/seed en échec — voir $LOG"; tail -25 "$LOG"; exit 1
  fi
else
  unset DATABASE_URL
  say "1/3 base SQLite vierge ($RUNDB)"
  rm -f "$RUNDB" "$RUNDB-shm" "$RUNDB-wal"
  if ! DATA_FILE="$RUNDB" npm run seed -- --fresh >"$LOG" 2>&1; then
    echo "seed en échec — voir $LOG"; tail -25 "$LOG"; exit 1
  fi
fi
tail -3 "$LOG"

say "2/3 serveur de vérification (port $PORT)"
# Un seul tableau d'environnement : pas de risque que DATABASE_URL traîne encore dans le process
# quand on croit tester SQLite (le pilote PG traiterait « file:… » comme une URL Postgres).
ENVS=(NODE_ENV=development PORT="$PORT" DEMO_MODE=1 TRUST_PROXY=1 TIMEZONE=Europe/Paris
      SESSION_SECRET=abcdefghijabcdefghijabcdefghij
      TOKEN_SECRET=klmnopqrstklmnopqrstklmnopqrst CRON_SECRET=cron-secret-test)
if [ "$PG_MODE" = 1 ]; then ENVS+=(DATABASE_URL="$DATABASE_URL"); else ENVS+=(DATA_FILE="$RUNDB"); fi
env "${ENVS[@]}" node --import tsx server/index.ts >>"$LOG" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

ok=""
# Contre un Postgres distant (Supabase), le démarrage lui-même prend ~25 s : une seule
# attente d'empreinte réseau par table. 20 s de budget faisait échouer la campagne
# « pour une base à l'autre bout de l'Europe » — ce qui n'était pas un défaut du produit.
TRIES=40; [ "$PG_MODE" = 1 ] && TRIES=200
for _ in $(seq 1 $TRIES); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 0.5
done
if [ -z "$ok" ]; then echo "serveur injoignable au bout de $((TRIES / 2)) s — voir $LOG"; tail -25 "$LOG"; exit 1; fi
curl -fsS "http://127.0.0.1:$PORT/healthz" | head -c 200; echo

say "3/3 73 contrôles fonctionnels"
CRON_SECRET=cron-secret-test node scripts/verify-features.mjs --base "http://127.0.0.1:$PORT" --json "$REPORT" "$@"
rc=$?
echo "exit $rc"
exit $rc
