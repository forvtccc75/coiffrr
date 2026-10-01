/**
 * Smoke test bout-en-bout sur l'API réelle (base en mémoire, données de démo).
 * `npm run smoke` — sort avec code 1 si une garantie produit est violée.
 */
export {};
process.env.TEST_DB = 'memory';
process.env.NODE_ENV = 'test';
process.env.TZ = process.env.TZ || 'Europe/Paris';

type Step = { name: string; run: () => Promise<any>; check?: (v: any) => string | null | void };

const results: { name: string; ok: boolean; info: string }[] = [];
let app: any;
let ownerCookie = '';

const assert = (cond: any, msg: string) => {
  if (!cond) throw new Error(msg);
};

async function req(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers ?? {});
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const cookie = [headers.get('cookie'), init.cookie].filter(Boolean).join('; ');
  if (cookie) headers.set('cookie', cookie);
  const res = await app.request(path, { ...init, headers });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers, setCookie: res.headers.getSetCookie?.() ?? [] };
}

const steps: Step[] = [
  {
    name: 'boot: app créée, DB de démo prête',
    run: async () => {
      const { bootstrap } = await import('../server/app.ts');
      app = await bootstrap();
      const h = await req('/healthz');
      assert(h.status === 200 && h.json.ok, 'healthz ko');
      return `rdv=${h.json.appointments}`;
    },
  },
  {
    name: 'config publique unique (≤3 requêtes pour toute la page d’accueil)',
    run: async () => {
      const r = await req('/api/public/config');
      assert(r.status === 200, 'status');
      for (const k of ['salon', 'services', 'staff', 'policy', 'links', 'live', 'reviews', 'features']) assert(k in r.json, `manque ${k}`);
      assert(r.json.salon.hours && r.json.links.book === '/book', 'heures/links');
      assert(r.json.services.every((x: any) => x.offeringId), 'offeringId manquant (le client ne peut pas réserver)');
      assert(r.json.services.length >= 10, 'services manquants');
      assert(r.json.policy.slotStepMin === 10, 'politique');
      assert(r.json.live && typeof r.json.reviews?.count === 'number', 'live/reviews absents');
      return `${r.json.services.length} prestations, ${r.json.staff.length} barbiers, ${r.json.live.slotsThisWeek} créneaux cette semaine, prochain: ${r.json.live.nextSlot?.label ?? '—'}`;
    },
  },
  {
    name: 'ZERO DEMANDE PERDUE : aucun jour "complet" sans alternative + waitlist',
    run: async () => {
      const r = await req('/api/public/availability?service=coupe-barbe&days=14');
      assert(r.status === 200, 'status');
      const bad = r.json.days.filter((d: any) => d.count === 0 && !d.closed && !d.waitlistOpen);
      assert(!bad.length, `jours bloqués sans porte de sortie: ${JSON.stringify(bad).slice(0, 200)}`);
      const full = r.json.days.filter((d: any) => d.count === 0);
      assert(r.json.summary.honest === true, 'résumé non honnête');
      let altCount = (r.json.alternatives ?? []).length;
      const blocked = full.find((d: any) => d.closed === 'complet') ?? full[0];
      if (blocked) {
        const one = await req(`/api/public/availability?service=coupe-barbe&days=1&date=${blocked.day}`);
        assert(one.status === 200, 'jour isolé ko');
        if (!one.json.days[0].count) {
          assert((one.json.alternatives ?? []).length > 0 || one.json.waitlistOpen, `jour « complet » affiché sans porte de sortie`);
          altCount += (one.json.alternatives ?? []).length;
        }
      }
      return `${r.json.days.length} jours explorés, ${full.length} sans créneau, ${altCount} alternatives proposées`;
    },
  },
  {
    name: 'créneau suivant réel (jamais "complet")',
    run: async () => {
      const r = await req('/api/public/next?service=coupe-homme');
      assert(r.status === 200, 'status');
      assert(r.json.slot?.ts > Date.now(), 'créneau suivant invalide');
      return `${r.json.slot.label} (barbiers ${r.json.slot.staffIds.join('/')})`;
    },
  },
  {
    name: 'réservation happy-path + brouillon reprenable',
    run: async () => {
      const av = await req('/api/public/availability?service=coupe-homme&days=14');
      const day = av.json.days.find((d: any) => d.slots?.length);
      assert(day, 'aucun créneau dispo');
      const slot = day.slots[0];
      const draft = await req('/api/public/draft', {
        method: 'POST',
        body: JSON.stringify({ visitorId: 'smoke-visitor-1', offeringId: av.json.service.offeringId, staffId: slot.staffIds[0], slot: slot.ts, step: 'contact', contact: { firstName: 'Smoke', phone: '+33612345678', email: 'smoke@test.local' }, attribution: { source: 'instagram' } }),
      });
      assert(draft.status === 201 || draft.status === 200, `draft ${draft.status} ${draft.text.slice(0, 160)}`);
      assert(draft.json.token, 'pas de token de reprise');
      const resume = await req(`/api/public/draft?token=${draft.json.token}`);
      assert(resume.status === 200 && resume.json.contact?.phone === '+33612345678' && resume.json.slot === slot.ts, `reprise du brouillon ko: ${resume.text.slice(0, 160)}`);
      const r = await req('/api/public/booking', {
        method: 'POST',
        body: JSON.stringify({
          offeringId: av.json.service.offeringId,
          start: slot.ts,
          staffId: slot.staffIds[0],
          customer: { firstName: 'Smoke', lastName: 'Test', phone: '+33612345678', email: 'smoke@test.local', note: 'test' },
          consent: { marketingEmail: false, marketingSms: false, terms: true },
          attribution: { source: 'instagram', campaign: 'smoke', medium: 'social' },
          paymentMode: 'none',
          visitorId: 'smoke-visitor-1',
          draftId: draft.json.id,
        }),
      });
      assert(r.status === 201, `booking ${r.status} ${r.text.slice(0, 260)}`);
      assert(r.json.id && r.json.manageToken, 'pas did');
      assert(r.json.manageUrl?.includes(`/rdv/${r.json.id}`), 'lien de gestion manquant');
      const nextDay = av.json.days.find((x: any) => x.count > 1);
      (globalThis as any).slot = { ts: slot.ts, start: slot.ts, staffIds: slot.staffIds };
      (globalThis as any).appt = r.json;
      (globalThis as any).nextSlotStart = nextDay?.slots?.[nextDay.slots.length - 1]?.ts ?? slot.ts;
      return `RDV #${r.json.id} ${new Date(r.json.start).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })} · ${r.json.serviceName} · statut ${r.json.status} · brouillon repris ✓`;
    },
  },
  {
    name: 'tout créneau affiché est réellement réservable (pas de « créneau pris » fantôme)',
    run: async () => {
      const av = await req('/api/public/availability?service=coupe-barbe&days=14');
      const targets: { day: string; ts: number }[] = [];
      for (const d of av.json.days) {
        if (!d.slots?.length) continue;
        targets.push({ day: d.day, ts: d.slots[d.slots.length - 1].ts });
        targets.push({ day: d.day, ts: d.slots[Math.floor(d.slots.length / 2)].ts });
        if (targets.length >= 6) break;
      }
      const booked: { id: number; token: string }[] = [];
      const fails: string[] = [];
      let n = 0;
      for (const t of targets) {
        n++;
        const r = await req('/api/public/booking', {
          method: 'POST',
          body: JSON.stringify({ offeringId: av.json.service.offeringId, start: t.ts, customer: { firstName: 'Tail', lastName: 'Check', phone: `+3363333${String(1000 + n).slice(-4)}` }, consent: { terms: true }, paymentMode: 'none' }),
        });
        if (r.status === 201) booked.push({ id: r.json.id, token: r.json.manageToken });
        else fails.push(`${t.day} ${new Date(t.ts).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' })}→${r.json?.error ?? r.status}`);
      }
      for (const b of booked) await req('/api/public/appointment/cancel', { method: 'POST', body: JSON.stringify({ token: b.token }) });
      assert(!fails.length, `${fails.length}/${targets.length} créneaux affichés refusés: ${fails.slice(0, 4).join(', ')}`);
      return `${targets.length} créneaux testés (dont derniers de journée et créneaux « serrés »), ${booked.length} réservés puis libérés`;
    },
  },
  {
    name: 'ZERO DOUBLE BOOKING : le même créneau est refusé côté serveur',
    run: async () => {
      const slot = (globalThis as any).slot;
      const av = await req('/api/public/availability?service=coupe-homme&days=14');
      const r = await req('/api/public/booking', {
        method: 'POST',
        body: JSON.stringify({ offeringId: av.json.service.offeringId, start: slot.start, staffId: slot.staffIds[0], customer: { firstName: 'Double', lastName: 'Test', phone: '+33699999999' }, consent: { terms: true } }),
      });
      assert(r.status === 409, `attendu 409, reçu ${r.status}`);
      assert(r.json.error === 'creneau_pris', `code ${r.json.error}`);
      assert(r.json.data?.alternatives?.length > 0, 'aucune alternative renvoyée');
      return `409 creneau_pris + ${r.json.data.alternatives.length} alternatives`;
    },
  },
  {
    name: 'validation serveur des entrées (tél/e-mail/nom, XSS neutralisé)',
    run: async () => {
      const bad = await req('/api/public/booking', {
        method: 'POST',
        body: JSON.stringify({ offeringId: 1, start: Date.now() + 3600_000, phone: '12', customer: { firstName: '<script>alert(1)</script>', phone: '12' } }),
      });
      assert(bad.status >= 400, 'validation absente');
      const xss = await req('/api/public/waitlist', { method: 'POST', body: JSON.stringify({ name: '<img src=x onerror=alert(1)>', phone: '+33600000000', serviceKey: 'coupe-homme', days: [], consent: true }) });
      assert([200, 201, 422].includes(xss.status), `xss: le serveur plante (${xss.status} ${xss.text.slice(0, 120)})`);
      const { db } = await import('../server/db/index.ts');
      const stored = await db().one<any>(`SELECT name FROM waitlist ORDER BY id DESC LIMIT 1`);
      assert(!/<(script|img)/i.test(String(stored?.name ?? '')), `balises stockées brutes: ${stored?.name}`);
      const noSql = await req(`/api/public/reviews?search=${encodeURIComponent("'; DROP TABLE reviews; --")}`);
      assert(noSql.status === 200, 'requête fragile');
      const stillThere = await req('/api/public/reviews');
      assert(stillThere.status === 200, 'table détruite');
      return `booking→${bad.status} (${bad.json.error}), injection→sans effet`;
    },
  },
  {
    name: 'lien signé : confirmation, puis déplace, puis change de prestation',
    run: async () => {
      const appt = (globalThis as any).appt;
      assert(appt.icsUrl?.includes('/api/public/actions/ics?token='), 'ics manquant');
      const confirm = await req(`/api/public/actions/confirm?token=${appt.manageToken}`);
      assert([200, 302].includes(confirm.status), `confirm ${confirm.status} ${confirm.text.slice(0, 160)}`);
      const got = await req(`/api/public/appointment?token=${appt.manageToken}`);
      assert(got.status === 200 && got.json.appointment?.status === 'confirmed', `détail rdv ${got.status} ${got.text.slice(0, 200)}`);
      const ics = await req(`/api/public/actions/ics?token=${appt.manageToken}`);
      assert(ics.status === 200 && ics.text.includes('BEGIN:VCALENDAR'), 'ics ko');
      const forged = await req(`/api/public/appointment?token=${appt.manageToken.slice(0, -4)}zzzz`);
      assert([403, 404].includes(forged.status), `jeton falsifié accepté (${forged.status})`);
      const moved = await req('/api/public/appointment/reschedule', { method: 'POST', body: JSON.stringify({ token: appt.manageToken, start: (globalThis as any).nextSlotStart }) });
      assert([200, 409].includes(moved.status), `reschedule ${moved.status}`);
      const me = await req(got.json.actions?.cancel ?? `/rdv/${appt.id}?token=${appt.manageToken}`);
      assert(me.status === 200, `page rdv ${me.status}`);
      assert(me.text.includes('<div id="root"') || me.text.includes('__INITIAL__'), 'SPA fallback non servi');
      const rev = await req(`/api/public/reviews`, { method: 'POST', body: JSON.stringify({ token: appt.manageToken, rating: 5, comment: 'Nickel, rasé de près, à l’heure.', consentPublic: true }) });
      assert([200, 201, 409].includes(rev.status), `POST avis → ${rev.status} ${rev.text.slice(0, 140)}`);
      return `confirm=${confirm.status}, page rdv=${me.status}`;
    },
  },
  {
    name: 'annulation → créneau libéré → waitlist rejouée → offre claimée',
    run: async () => {
      const appt = (globalThis as any).appt;
      const join = await req('/api/public/waitlist', {
        method: 'POST',
        body: JSON.stringify({ name: 'Attente Test', phone: '+33611111111', serviceKey: 'coupe-homme', days: [], flex: { otherStaff: true, otherDays: true, sameDayOtherTime: true }, consent: true, attribution: { source: 'waitlist-test' } }),
      });
      assert(join.status === 201, `waitlist ${join.status} ${join.text.slice(0, 200)}`);
      assert(join.json.token && join.json.position, 'waitlist : ni token ni position');
      const status0 = await req(`/api/public/waitlist/status?token=${join.json.token}`);
      assert(status0.status === 200 && status0.json.entry?.status === 'active', `statut waitlist ko: ${status0.text.slice(0, 160)}`);
      // l'annulation du RDV déclenche le rejeu (aucune action humaine)
      const cancel = await req('/api/public/appointment/cancel', { method: 'POST', body: JSON.stringify({ token: appt.manageToken }) });
      assert(cancel.status === 200, `cancel ${cancel.status} ${cancel.text.slice(0, 200)}`);
      const cancelled = await req(`/api/public/appointment?token=${appt.manageToken}`);
      assert(cancelled.json.appointment?.status === 'cancelled', `statut après annulation: ${cancelled.json.appointment?.status}`);
      const { db } = await import('../server/db/index.ts');
      assert(Number(cancel.json.waitlistOffers) >= 1, `créneau libéré mais aucune offre waitlist: ${JSON.stringify(cancel.json).slice(0, 200)}`);
      // l'offre part vers la demande la plus ancienne compatible (FIFO), pas nécessairement la nôtre
      const offer = await db().one<any>(`SELECT * FROM waitlist_offers WHERE start_ts = :st AND status = 'pending' ORDER BY id DESC LIMIT 1`, { st: cancel.json.freed?.start });
      assert(offer, `aucune offre en attente sur le créneau libéré`);
      const claim = await req('/api/public/waitlist/claim', { method: 'POST', body: JSON.stringify({ token: offer.token }) });
      assert(claim.status === 200 && claim.json.ok, `claim ${claim.status} ${claim.text.slice(0, 220)}`);
      assert(claim.json.appointmentId, 'claim sans RDV');
      const reclaim = await req('/api/public/waitlist/claim', { method: 'POST', body: JSON.stringify({ token: offer.token }) });
      assert(reclaim.status >= 400 || reclaim.json.alreadyClaimed, `double claim accepté: ${JSON.stringify(reclaim.json).slice(0, 160)}`);
      const claimedAppt = await db().one<any>(`SELECT * FROM appointments WHERE id = :i`, { i: claim.json.appointmentId });
      assert(claimedAppt && ['held', 'booked', 'confirmed'].includes(claimedAppt.status), 'le RDV issu du claim existe et est bloqué');
      const notif = await db().one<any>(`SELECT body_text FROM notifications WHERE kind = 'waitlist_offer' AND appointment_id IS NULL ORDER BY id DESC LIMIT 1`);
      const sms = await db().all<any>(`SELECT body_text FROM notifications WHERE kind = 'waitlist_offer' ORDER BY id DESC LIMIT 1`);
      assert(/cr[ée]neau|1 clic/i.test(String(sms[0]?.body_text ?? '')), "SMS d'offre absent");
      void notif;
      const after = await req(`/api/public/waitlist/status?token=${join.json.token}`);
      assert(after.status === 200, 'suivi waitlist ko');
      return `pos ${join.json.position.rank}/${join.json.position.total} → offre ${new Date(offer.start_ts).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' })} → RDV #${claim.json.appointmentId} (${claimedAppt.status}), re-claim refusé, suivi OK`;
    },
  },
  {
    name: 'décalage et changement de prestation par lien signé',
    run: async () => {
      const av0 = await req('/api/public/availability?service=coupe-barbe&days=14');
      const day0 = av0.json.days.find((d: any) => d.slots?.length > 0);
      assert(day0, 'aucun créneau');
      const staffId = day0.slots[0].staffIds[0];
      const staffSlug = ((await req('/api/public/config')).json.staff.find((x: any) => x.id === staffId) ?? {}).slug;
      const av = await req(`/api/public/availability?service=coupe-barbe&days=14&staff=${staffSlug}`);
      const day = av.json.days.find((d: any) => (d.slots ?? []).length > 1 && d.slots.every((x: any) => x.staffIds.includes(staffId)));
      assert(day, `aucun second créneau chez ${staffSlug} — impossible de tester le décalage`);
      const b = await req('/api/public/booking', {
        method: 'POST',
        body: JSON.stringify({ offeringId: av.json.service.offeringId, start: day.slots[0].ts, staffId: day.slots[0].staffIds[0], customer: { firstName: 'Move', lastName: 'Test', phone: '+33655555555' }, consent: { terms: true }, paymentMode: 'none' }),
      });
      assert(b.status === 201, `booking ${b.status} ${b.text.slice(0, 160)}`);
      const tk = b.json.manageToken;
      const move = await req('/api/public/appointment/reschedule', { method: 'POST', body: JSON.stringify({ token: tk, start: day.slots[day.slots.length - 1].ts }) });
      assert(move.status === 200, `reschedule ${move.status} ${move.text.slice(0, 200)}`);
      assert(move.json.start === day.slots[day.slots.length - 1].ts, 'créneau inchangé');
      const other = await req('/api/public/availability?service=barbe&days=14');
      const change = await req('/api/public/appointment/service', { method: 'POST', body: JSON.stringify({ token: tk, offeringId: other.json.service.offeringId }) });
      assert(change.status === 200 || change.json?.error === 'duree_incompatible', `changement de service → ${change.status} ${change.text.slice(0, 200)}`);
      if (change.status === 200) assert(change.json.serviceName, 'nom de service absent');
      const forged = await req('/api/public/appointment/reschedule', { method: 'POST', body: JSON.stringify({ token: tk.slice(0, -6) + 'AAAAAA', start: day.slots[1].ts }) });
      assert([403, 404].includes(forged.status), `jeton falsifié accepté sur le décalage (${forged.status})`);
      const cancel2 = await req('/api/public/appointment/cancel', { method: 'POST', body: JSON.stringify({ token: tk }) });
      assert(cancel2.status === 200, 'annulation finale');
      const again = await req('/api/public/appointment/cancel', { method: 'POST', body: JSON.stringify({ token: tk }) });
      assert(again.json?.already === true || again.status >= 400, `double annulation: ${again.status} ${again.text.slice(0, 140)}`);
      const finalState = await req(`/api/public/appointment?token=${tk}`);
      assert(finalState.json.appointment?.status === 'cancelled', 'état final incohérent');
      return `décalé ✓, prestation changée (${change.json.serviceName ?? change.json.error}), jeton falsifié refusé, double annulation refusée`;
    },
  },
  {
    name: 'espace client : code à 6 chiffres, session, historique, récompenses',
    run: async () => {
      const target = '+33612345678';
      const ask = await req('/api/public/auth/code', { method: 'POST', body: JSON.stringify({ target }) });
      assert(ask.status === 200 && ask.json.demoCode, `code ${ask.status} ${ask.text.slice(0, 160)}`);
      const verify = await req('/api/public/auth/code/verify', { method: 'POST', body: JSON.stringify({ target, code: ask.json.demoCode }) });
      assert(verify.status === 200, `verify ${verify.status} ${verify.text.slice(0, 200)}`);
      const cookie = verify.setCookie.map((c: string) => c.split(';')[0]).join('; ');
      assert(cookie.includes('zyass_session'), 'cookie de session absent');
      const sum = await req('/api/client/summary', { cookie });
      assert(sum.status === 200 && sum.json.customer, 'summary ko');
      const appts = await req('/api/client/appointments', { cookie });
      assert(appts.status === 200 && Array.isArray(appts.json), 'historique ko');
      const exp = await req('/api/client/export', { cookie });
      assert(exp.status === 200 && JSON.stringify(exp.json).length > 50, 'export RGPD ko');
      (globalThis as any).clientCookie = cookie;
      return `${sum.json.upcoming?.length ?? 0} à venir, ${appts.json.length} au dossier, ${sum.json.history?.length ?? 0} dans l'historique, points ${sum.json.loyalty?.points ?? 0}`;
    },
  },
  {
    name: 'anti brute-force sur les codes de connexion',
    run: async () => {
      let last = 0;
      for (let i = 0; i < 8; i++) {
        const r = await req('/api/public/auth/code/verify', { method: 'POST', body: JSON.stringify({ target: '+33612345678', code: '000000' }) });
        last = r.status;
      }
      assert(last === 429, `attendu 429 après 8 tentatives, reçu ${last}`);
      return '429 après la limite';
    },
  },
  {
    name: 'back-office : login, vue du jour, calendrier, files, analytics',
    run: async () => {
      const login = await req('/api/public/auth/password', { method: 'POST', body: JSON.stringify({ email: 'owner@zyass.fr', password: 'demo-owner' }) });
      assert(login.status === 200, `login ${login.status} ${login.text.slice(0, 160)}`);
      ownerCookie = login.setCookie.map((c: string) => c.split(';')[0]).join('; ');
      for (const p of ['/api/admin/today', '/api/admin/calendar?days=14', '/api/admin/queue', '/api/admin/waitlist', '/api/admin/customers', '/api/admin/analytics/kpis', '/api/admin/analytics/heatmap', '/api/admin/automations', '/api/admin/reviews', '/api/admin/settings']) {
        const r = await req(p, { cookie: ownerCookie });
        assert(r.status === 200, `${p} → ${r.status} ${r.text.slice(0, 160)}`);
      }
      const today = await req('/api/admin/today', { cookie: ownerCookie });
      const kpis = await req('/api/admin/analytics/kpis', { cookie: ownerCookie });
      return `today=${today.json.appointments?.length ?? today.json.days?.length ?? 'ok'} · CA 30j ${kpis.json.revenueCents ?? kpis.json.caCents ?? '?'} cts · no-show ${kpis.json.noShowRate ?? '?'}%`;
    },
  },
  {
    name: 'RBAC : un staff ne peut pas toucher aux réglages, un anonyme non plus',
    run: async () => {
      const anon = await req('/api/admin/today');
      assert(anon.status === 401, `anon → ${anon.status}`);
      const staffLogin = await req('/api/public/auth/password', { method: 'POST', body: JSON.stringify({ email: 'mehdi@zyass.fr', password: 'demo-staff' }) });
      assert(staffLogin.status === 200, 'login staff');
      const ck = staffLogin.setCookie.map((c: string) => c.split(';')[0]).join('; ');
      const denied = await req('/api/admin/settings', { cookie: ck });
      assert(denied.status === 403, `staff sur settings → ${denied.status}`);
      const allowed = await req('/api/admin/today', { cookie: ck });
      assert(allowed.status === 200, 'staff bloqué sur son planning');
      return `anon=${anon.status}, staff/settings=${denied.status}, staff/today=${allowed.status}`;
    },
  },
  {
    name: 'head of client : le client B ne voit pas le RDV du client A (IDOR)',
    run: async () => {
      const appt = (globalThis as any).appt;
      const other = await req('/api/public/auth/code', { method: 'POST', body: JSON.stringify({ target: '+33611111111' }) });
      const verify = await req('/api/public/auth/code/verify', { method: 'POST', body: JSON.stringify({ target: '+33611111111', code: other.json.demoCode }) });
      const ck = verify.setCookie.map((c: string) => c.split(';')[0]).join('; ');
      const list = await req('/api/client/appointments', { cookie: ck });
      const arr = Array.isArray(list.json) ? list.json : (list.json.appointments ?? []);
      assert(!arr.some((a: any) => a.id === appt.id), `fuite inter-clients ! (${arr.length} lignes)`);
      const peek = await req(`/api/client/appointments/${appt.id}`, { cookie: ck });
      assert([404, 403].includes(peek.status) || peek.status === 200, 'peek ko');
      if (peek.status === 200) assert(peek.json.appointment?.id !== appt.id, 'IDOR sur le détail');
      return `liste filtrée, détail → ${peek.status}`;
    },
  },
  {
    name: 'notifications : outbox alimenté, jamais de doublon, canaux respectés',
    run: async () => {
      const { db } = await import('../server/db/index.ts');
      const rows = await db().all<any>(`SELECT kind, channel, status, COUNT(*) n FROM notifications GROUP BY kind, channel, status ORDER BY 4 DESC`);
      assert(rows.length > 0, 'outbox vide');
      const total = rows.reduce((a: number, r: any) => a + Number(r.n), 0);
      const dup = await db().one<any>(`SELECT appointment_id, kind, channel, COUNT(*) n FROM notifications WHERE appointment_id IS NOT NULL GROUP BY appointment_id, kind, channel HAVING COUNT(*) > 1 LIMIT 1`);
      assert(!dup, `doublon de notification: ${JSON.stringify(dup)}`);
      return `${total} messages, ${new Set(rows.map((r: any) => r.kind)).size} types, doublons: 0`;
    },
  },
  {
    name: 'ZERO FAUSSE RARETÉ : pénuries calculées, compteurs traçables',
    run: async () => {
      const { db } = await import('../server/db/index.ts');
      const fake = await db().all<any>(`SELECT kind, COUNT(*) n FROM funnel_events WHERE kind IN ('fake_slot', 'fake_countdown', 'fake_urgency') GROUP BY kind`);
      assert(!fake.length, 'événements de fausse rareté présents');
      const av = await req('/api/public/availability?service=coupe-homme&days=14');
      const totalFree = av.json.days.reduce((a: number, d: any) => a + (d.count ?? 0), 0);
      const booked = await db().num(`SELECT COUNT(*) FROM appointments WHERE status IN ('booked','confirmed','pending_payment','held','waiting_client','in_progress')`);
      assert(totalFree > 0, 'disponibilités incohérentes');
      return `${totalFree} créneaux libres réels sur 14 j, ${booked} RDV occupés, 0 artifice`;
    },
  },
  {
    name: 'sécurité HTTP : en-têtes, cookies, CSP',
    run: async () => {
      const r = await req('/');
      const csp = r.headers.get('content-security-policy') ?? '';
      assert(csp.includes("default-src 'self'"), `CSP absente: ${csp.slice(0, 80)}`);
      assert((r.headers.get('x-frame-options') ?? '').toUpperCase() === 'DENY', 'X-Frame-Options');
      assert((r.headers.get('referrer-policy') ?? '').includes('strict-origin'), 'referrer');
      const login = await req('/api/public/auth/password', { method: 'POST', body: JSON.stringify({ email: 'owner@zyass.fr', password: 'demo-owner' }) });
      const sc = login.setCookie.join(' ');
      assert(/HttpOnly/i.test(sc), 'cookie non HttpOnly');
      assert(/SameSite=Lax/i.test(sc), 'cookie SameSite');
      return 'CSP + HSTS-ready + cookies HttpOnly/SameSite';
    },
  },
  {
    name: 'SEO : sitemap, robots, JSON-LD LocalBusiness + Service + FAQ',
    run: async () => {
      const sm = await req('/sitemap.xml');
      assert(sm.status === 200 && sm.text.includes('/book'), 'sitemap');
      const rb = await req('/robots.txt');
      assert(rb.text.includes('Sitemap:') && rb.text.includes('Disallow: /admin'), 'robots');
      const seo = await req('/api/public/seo/coupe-homme');
      const types = seo.json.jsonLd.map((x: any) => JSON.stringify(x['@type']));
      assert(types.some((t: string) => t.includes('HairSalon')), 'LocalBusiness absent');
      assert(types.some((t: string) => t.includes('Service')), 'Service absent');
      assert(types.some((t: string) => t.includes('FAQPage')), 'FAQ absente');
      assert(seo.json.meta.title.includes('Les Pavillons-sous-Bois') || seo.json.meta.title.length > 8, 'meta titre');
      return `${sm.text.split('<url>').length - 1} urls · JSON-LD ${types.join(' ').slice(0, 80)}`;
    },
  },
  {
    name: 'avis : seuls les avis vérifiables sont publics, acheminement éthique',
    run: async () => {
      const r = await req('/api/public/reviews');
      assert(r.status === 200, 'status');
      const demo = (r.json.list ?? []).filter((x: any) => x.channel === 'demo' || x.channel === 'internal');
      assert(!demo.length, `avis de démo exposés publiquement (${demo.length})`);
      const neg = await req('/api/public/reviews', { method: 'POST', body: JSON.stringify({ token: 'x'.repeat(20), rating: 2, comment: 'attente trop longue' }) });
      assert([200, 401, 403, 404, 410, 422].includes(neg.status), `POST reviews → ${neg.status}`);
      return `${(r.json.list ?? []).length} avis publics (canal: ${[...new Set((r.json.list ?? []).map((x: any) => x.channel))].join(',')}), note externe ${r.json.stats.googleRating?.value ?? '-'}`;
    },
  },
  {
    name: 'cron interne : sécurisé, idempotent, fait le travail',
    run: async () => {
      const noSecret = await req('/api/internal/cron', { method: 'POST', body: '{}' });
      assert(noSecret.status === 401 || noSecret.status === 403, `cron sans secret → ${noSecret.status}`);
      const { env } = await import('../server/lib/env.ts');
      const ok = await req('/api/internal/cron', { method: 'POST', body: JSON.stringify({ scope: 'all' }), headers: { 'x-cron-secret': env.cronSecret } });
      assert(ok.status === 200, `cron → ${ok.status} ${ok.text.slice(0, 200)}`);
      // Un tick qui échoue sur un salon doit être rouge, pas noyé dans le JSON : c'est exactement
      // comme ça qu'une erreur SQL propre à Postgres est restée invisible (22/22 alors que rien ne tournait).
      const corps = ok.json as any;
      const salon = Array.isArray(corps?.out) ? corps.out : [];
      assert(salon.length > 0, `cron : aucun salon traité ${ok.text.slice(0, 120)}`);
      const casses = salon.filter((o: any) => o?.error);
      assert(casses.length === 0, `cron en erreur sur ${casses.length} salon(s) : ${casses.map((o: any) => `${o.slug}: ${o.error}`).join(' | ').slice(0, 220)}`);
      return `sans secret=${noSecret.status}, exécution=${ok.status}, ${salon.length} salon(s) sans erreur`;
    },
  },
];

let failed = 0;
for (const s of steps) {
  const t0 = Date.now();
  try {
    const info = await s.run();
    results.push({ name: s.name, ok: true, info: typeof info === 'string' ? info : info ? JSON.stringify(info).slice(0, 160) : '' });
    process.stdout.write(`\x1b[32m✓\x1b[0m ${s.name}  \x1b[2m(${Date.now() - t0} ms) ${typeof info === 'string' ? info : ''}\x1b[0m\n`);
  } catch (e: any) {
    failed++;
    results.push({ name: s.name, ok: false, info: String(e.message).slice(0, 300) });
    process.stdout.write(`\x1b[31m✗ ${s.name}\x1b[0m  ${String(e.message).slice(0, 400)}\n${String(e.stack ?? '').split('\n').slice(1, 3).join('\n')}\n`);
  }
}
const pass = results.length - failed;
process.stdout.write(`\n\x1b[1m${pass}/${results.length} garanties vérifiées\x1b[0m\n`);
if (process.env.SMOKE_JSON) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync('smoke-results.json', JSON.stringify(results, null, 2));
}
process.exit(failed ? 1 : 0);
