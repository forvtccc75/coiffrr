#!/usr/bin/env bash
# Smoke test HTTP sur une instance qui tourne déjà (utile en review app / après déploiement).
#   BASE_URL=https://zyass.example.com bash scripts/smoke.sh
#   bash scripts/smoke.sh --local     # démarre l'API locale, teste, puis l'arrête
# Il ne modifie rien d'irréversible : la réservation de test est annulée à la fin.
set -uo pipefail
BASE="${BASE_URL:-http://127.0.0.1:8787}"
STOP_LOCAL=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"; [ "$STOP_LOCAL" = 1 ] && kill $SRV 2>/dev/null' EXIT

if [ "${1:-}" = "--local" ]; then
  echo "→ démarrage de l'API locale…"
  NODE_ENV=development PORT=8787 npx --no-install tsx --tsconfig server/tsconfig.json server/index.ts >"$tmp/api.log" 2>&1 &
  SRV=$!; STOP_LOCAL=1
  for i in $(seq 1 60); do curl -fsS "$BASE/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
fi

# Chaque exécution prend sa propre IP simulée : le plafond est à 12 réservations / 10 min par IP,
# un smoke test doit pouvoir tourner deux fois de suite (et en parallèle sur une review app).
RUNIP="198.51.100.$(( (RANDOM % 250) + 1 ))"
XFF=(-H "x-forwarded-for: $RUNIP")

pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  \033[31m✗\033[0m %s — %s\n' "$1" "${2:-}"; }
get()  { curl -fsS -m 20 "$BASE$1" 2>/dev/null; }
code() { curl -s -o /dev/null -w '%{http_code}' -m 20 "$BASE$1" 2>/dev/null; }
jpy()  { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

echo "smoke HTTP → $BASE"

h="$(get /healthz)"
[ -n "$h" ] && ok "healthz répond" || bad "healthz" "aucune réponse de $BASE (lancer `npm run dev` ou passer --local)"

cfg="$(get /api/public/config)"
n="$(echo "$cfg" | jpy "len(d['services'])")"
[ "${n:-0}" -ge 8 ] && ok "catalogue servi ($n prestations)" || bad "catalogue" "$n prestation(s)"
tz="$(echo "$cfg" | jpy "d['salon']['timezone']")"
[ "$tz" = "Europe/Paris" ] && ok "fuseau du salon : $tz" || bad "fuseau" "$tz"

av="$(get "/api/public/availability?service=coupe-homme&days=14")"
free="$(echo "$av" | jpy "sum(len(x.get('slots') or []) for x in d['days'])")"
[ "${free:-0}" -gt 0 ] && ok "disponibilité réelle : $free créneaux sur 14 jours" || bad "disponibilité" "0 créneau"
msg="$(echo "$av" | jpy "d['summary']['message']")"
[ -n "$msg" ] && ok "résumé honnête : « $msg »" || bad "résumé" "absent"

sun="$(get "/api/public/availability?service=coupe-homme&days=1&date=$(date -d 'next sunday' +%F 2>/dev/null || echo 2026-09-27)")"
alts="$(echo "$sun" | jpy "len(d.get('alternatives') or []) + (1 if d.get('waitlistOpen') else 0)")"
[ "${alts:-0}" -ge 1 ] && ok "ZERO DEMANDE PERDUE : solution proposée même jour fermé" || bad "demande perdue" "ni alternative ni waitlist"

phone="06$(shuf -i 10000000-99999999 -n 1 2>/dev/null || echo 11223344)"
ts="$(echo "$av" | jpy "[s['ts'] for x in d['days'] for s in (x.get('slots') or [])][0]")"
oid="$(echo "$av" | jpy "d['service']['offeringId']")"   # jamais un id codé en dur : on prend celui que le serveur annonce
book="$(curl -sS -m 25 "${XFF[@]}" -X POST "$BASE/api/public/booking" -H 'content-type: application/json' \
  -d "{\"offeringId\":$oid,\"start\":$ts,\"customer\":{\"firstName\":\"Smoke\",\"phone\":\"$phone\"}}")"
status="$(echo "$book" | jpy "d.get('status','') if isinstance(d, dict) else ''")"
token="$(echo "$book" | jpy "d.get('manageToken','')")"
if [ "$status" = "booked" ] && [ -n "$token" ]; then
  ok "réservation de bout en bout ($phone)"
  staff="$(echo "$book" | jpy "d.get('staffId','')")"
  # même barbier, même minute : c'est ça le double booking (un autre barbier libre, lui, peut prendre)
  clash="$(curl -s -o /dev/null -w '%{http_code}' -m 25 "${XFF[@]}" -X POST "$BASE/api/public/booking" -H 'content-type: application/json' \
    -d "{\"offeringId\":$oid,\"start\":$ts,\"staffId\":$staff,\"customer\":{\"firstName\":\"Clone\",\"phone\":\"0699887766\"}}")"
  [ "$clash" = "409" ] && ok "ZERO DOUBLE BOOKING : même barbier à la même minute = 409" || bad "double booking" "statut $clash (attendu 409)"
  # ── tempête HTTP : dix clients sur le même créneau. Un seul doit passer, et jamais en 500.
  # on prend un créneau libre *et* le barbier qui le tient : épingler un autre barbier
  # reviendrait à tester un conflit légitime, pas la concurrence sur le même créneau.
  st="$(echo "$av" | jpy "next((f\"{s['ts']} {s['staffIds'][0]}\" for x in d['days'][3:] for s in (x.get('slots') or []) if s.get('staffIds')), '')")"
  st_ts="${st%% *}"; st_staff="${st##* }"
  if [ -n "$st_ts" ] && [ -n "$st_staff" ]; then
    for i in $(seq 1 10); do
      ( curl -s -o "$tmp/storm.$i" -w '%{http_code}' -m 25 "${XFF[@]}" -X POST "$BASE/api/public/booking" -H 'content-type: application/json' \
          -d "{\"offeringId\":$oid,\"start\":$st_ts,\"staffId\":$st_staff,\"customer\":{\"firstName\":\"Tempête\",\"phone\":\"06770000$(printf '%02d' $i)\"}}" > "$tmp/storm.$i.code" ) &
    done
    wait
    codes="$(for f in "$tmp"/storm.*.code; do printf '%s ' "$(cat "$f")"; done)"
    won=$(echo "$codes" | tr ' ' '\n' | grep -c '^201$')
    five=$(echo "$codes" | tr ' ' '\n' | grep -c '^5')
    if [ "$won" = "1" ] && [ "$five" = "0" ]; then
      ok "concurrence HTTP : 10 assauts sur un créneau = 1 réservation, 0 erreur serveur"
      stormtok="$(cat "$tmp"/storm.* 2>/dev/null | jpy "d.get('manageToken','')" 2>/dev/null | grep -m1 .)"
      [ -n "$stormtok" ] && curl -s -o /dev/null -m 25 -X POST "$BASE/api/public/appointment/cancel" -H 'content-type: application/json' -d "{\"token\":\"$stormtok\"}"
    else
      bad "concurrence HTTP" "statuts [$codes] — attendu un seul 201 et aucun 5xx"
    fi
  else
    bad "concurrence HTTP" "aucun créneau de repli trouvé dans les 14 jours"
  fi
  view="$(get "/api/public/appointment?token=$token")"
  echo "$view" | jpy "d['appointment']['status']" | grep -q booked && ok "lien signé : le client voit son RDV" || bad "lien signé" "lecture impossible"
  cancel="$(curl -sS -m 25 -X POST "$BASE/api/public/appointment/cancel" -H 'content-type: application/json' -d "{\"token\":\"$token\"}")"
  echo "$cancel" | grep -q '"ok":true' && ok "annulation en 1 clic (créneau remis en jeu)" || bad "annulation" "$cancel"
else
  bad "réservation" "$(echo "$book" | head -c 200)"
fi

[ "$(code /api/admin/today)" = "401" ] && ok "back-office fermé aux anonymes (401)" || bad "RBAC" "accessible sans session"
[ "$(code /api/internal/cron -X)" = "403" ] || [ "$(curl -s -o /dev/null -w '%{http_code}' -m 15 -X POST "$BASE/api/internal/cron")" = "403" ] && ok "cron protégé par secret" || bad "cron" "non protégé"
[ "$(code /robots.txt)" = "200" ] && ok "robots.txt" || bad "robots" ""
sm="$(get /sitemap.xml)"; u="$(echo "$sm" | grep -c '<url>')"
[ "${u:-0}" -ge 10 ] && ok "sitemap : $u urls" || bad "sitemap" "$u urls"
sec="$(curl -sSI -m 15 "$BASE/" | tr -d '\r')"
echo "$sec" | grep -qi 'x-frame-options: DENY' && ok "en-têtes de sécurité (XFO/CSP)" || bad "en-têtes" "X-Frame-Options absent"
echo "$sec" | grep -qi 'content-security-policy' && ok "CSP présente" || bad "CSP" "absente"

# ── le serveur statique ne doit jamais lire hors de dist/client
leak=0
for pr in "/..%2f..%2fpackage.json" "/%2e%2e/%2e%2e/.env.example" "/brand/../../../etc/passwd" "/%00.png" "/..%2f..%2fserver/db/../../data/zyass.db"; do
  body="$(curl -s -m 10 "$BASE$pr" 2>/dev/null)"
  case "$body" in *'"scripts"'*|*NODE_ENV=*|*root:*) if [ -n "$body" ] && ! echo "$body" | grep -q 'id="root"'; then leak=1; fi ;; esac
done
[ "$leak" = 0 ] && ok "statique : aucune lecture hors de dist/ (sonde traversée)" || bad "statique" "un fichier hors du build a fuité"

printf '\n%s%d réussis, %d échoués\033[0m — %s\n' "$([ $fail = 0 ] && printf '\033[32m' || printf '\033[31m')" "$pass" "$fail" "$BASE"
[ $fail = 0 ]
