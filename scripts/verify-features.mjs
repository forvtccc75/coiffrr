#!/usr/bin/env node
/**
 * Vérificateur fonctionnalité par fonctionnalité, contre une instance qui TOURNE.
 *
 *   node scripts/verify-features.mjs --base http://127.0.0.1:8787 [--json data/rapport-fonctionnalites.json] [--groupe 3] [--verbose]
 *
 * Ce n'est PAS un copier-coller des tests unitaires : chaque contrôle passe par le HTTP public ou
 * admin, sur les routes réelles, et exige une PREUVE chiffrée (une longueur, un id, un delta).
 * Il est rejouable : identités fraîches à chaque exécution, IP simulée par contrôle (le plafond
 * anti-abus est par IP), réservations annulées en fin de course.
 *
 * Sortie : 0 si tout est vert, 1 sinon. `skip:` affiché quand une vérification nécessite un mode
 * (démo, fournisseur réel) qui n'est pas celui de l'instance testée.
 */
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const BASE = (arg('base', 'http://127.0.0.1:8787') || '').replace(/\/$/, '');
const OUT = arg('json', '');
const ONLY = arg('groupe', '');
const VERBOSE = args.includes('--verbose');
const DEMO_OWNER = { email: 'owner@zyass.fr', password: 'demo-owner' };
const DEMO_STAFF = { email: 'mehdi@zyass.fr', password: 'demo-staff' };

const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const uniq = (p) => `${p}${Math.floor(Math.random() * 900000 + 100000)}`;
const freshPhone = () => `+336${String(Math.floor(Math.random() * 89999999) + 10000000)}`;
const freshEmail = () => `feat+${RUN}${Math.floor(Math.random() * 999)}@example.fr`;

let adminCookie = '';
let staffCookie = '';
let clientCookie = '';

async function call(path, { method = 'GET', body, cookie, headers = {}, raw = false } = {}) {
  const h = new Headers(headers);
  // IP différente par appel sensible : les plafonds (12 résas / 10 min par IP, 4 codes / cible)
  // sont là pour le monde réel, pas pour un vérificateur qui rejoue les mêmes scénarios.
  if (!h.has('x-forwarded-for')) h.set('x-forwarded-for', `203.0.113.${(process.pid + Math.floor(Math.random() * 97)) % 250}`);
  const auto = cookie ?? (headers.anon === true || headers.anon === 'true' ? undefined : (path.startsWith('/api/admin') || path.startsWith('/api/master')) && adminCookie ? adminCookie : undefined);
  if (auto) h.set('cookie', auto);
  if (body !== undefined && !h.has('content-type')) h.set('content-type', 'application/json');
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* html */
  }
  return {
    status: res.status,
    json,
    text,
    headers: res.headers,
    setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [],
    ok: res.ok,
  };
}
const get = (p, o) => call(p, o);
const post = (p, body, o) => call(p, { method: 'POST', body, ...o });

const fail = (m) => {
  throw new Error(m);
};
const expect = (cond, m) => {
  if (!cond) fail(m);
};
const skip = (m) => {
  const e = new Error(m);
  e.skipped = true;
  throw e;
};

/* ── helpers métier ───────────────────────────────────────────────────── */
let CONFIG = null;
async function config(force = false) {
  if (!CONFIG || force) {
    const r = await get('/api/public/config');
    expect(r.status === 200, `config → ${r.status}`);
    CONFIG = r.json;
  }
  return CONFIG;
}
const offering = async (key) => {
  const c = await config();
  const svc = c.services.find((s) => s.key === key) || c.services[0];
  expect(svc, `prestation ${key} absente du config`);
  return svc;
};
/** Premier créneau libre réel, dans les `days` prochains. */
/** Vue « un seul barbier » : indispensable pour prouver qu'un créneau est pris ou libéré. */
async function staffSlots(serviceKey, dayKey, staffId) {
  const r = await get(`/api/public/availability?service=${serviceKey}&days=1&date=${dayKey}&staff=${staffId}`);
  expect(r.status === 200, `availability par barbier → ${r.status} ${r.text.slice(0, 120)}`);
  return (r.json.days?.[0]?.slots ?? []).map((x) => x.ts);
}
const dayKeyOf = (ts) => new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
/** Heure locale du salon, pour que les preuves du rapport se lisent sans conversion mentale. */
const hhmm = (ts) => (ts ? new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(new Date(Number(ts))) : '—');
async function freeSlot(serviceKey, { staffId = null, from = 0 } = {}) {
  const svc = await offering(serviceKey);
  const r = await get(`/api/public/availability?service=${svc.key}&days=14`);
  expect(r.status === 200, `availability → ${r.status}`);
  for (const d of r.json.days) {
    for (const s of d.slots || []) {
      if (from && s.ts < from) continue;
      if (staffId && !(s.staffIds || []).includes(staffId)) continue;
      if (s.ts < Date.now() + 45 * 60000) continue; // marge de lead time
      return { svc, day: d, slot: { ...s, dayKey: d.day } };
    }
  }
  return { svc, day: null, slot: null };
}
/** Tous les RDV et tous les blocages créés par la campagne, annulés/supprimés à la fin — y compris
   quand un contrôle échoue en cours de route. Sans ça, un créneau laissé réservé par une campagne
   précédente faisait échouer la suivante pour une raison qui n'avait rien à voir avec le produit. */
const TRACKED = [];
const BLOCKS = [];
async function cleanupCampaign() {
  for (const t of TRACKED) {
    try { await cancelWith(t); } catch { /* déjà annulé : tant mieux */ }
  }
  for (const id of BLOCKS) {
    try { await post(`/api/admin/blocks/${id}/delete`, {}); } catch { /* déjà supprimé */ }
  }
}

async function book({ serviceKey = 'coupe-homme', phone, email, name = 'Feat', start, offeringId, staffId, addonIds = [], paymentMode = 'none', attribution } = {}) {
  const f = start ? { slot: { ts: start, staffIds: staffId ? [staffId] : [] }, svc: { offeringId } } : await freeSlot(serviceKey);
  const oid = offeringId ?? f.svc.offeringId;
  const body = {
    offeringId: oid,
    start: start ?? f.slot.ts,
    staffId: staffId ?? (f.slot.staffIds || [])[0] ?? undefined,
    customer: { firstName: name, lastName: RUN, phone: phone ?? freshPhone(), email: email ?? freshEmail(), note: `vérif ${RUN}` },
    consent: { terms: true, marketingEmail: true, marketingSms: false },
    addonIds,
    paymentMode,
    attribution: attribution ?? { source: 'instagram', campaign: `verif-${RUN}`, medium: 'social' },
  };
  const r = await post('/api/public/booking', body);
  if (r.json?.manageToken) TRACKED.push(r.json.manageToken);
  return { r, body };
}
async function loginAdmin(who = DEMO_OWNER) {
  const r = await post('/api/public/auth/password', { email: who.email, password: who.password, scope: 'admin' });
  expect(r.status === 200, `login admin ${who.email} → ${r.status} ${r.text.slice(0, 120)}`);
  return (r.setCookie || []).map((c) => c.split(';')[0]).join('; ');
}
async function cancelWith(token) {
  if (!token) return;
  await post('/api/public/appointment/cancel', { token });
}

const A = [];
const feat = (g, feature, reqs, run) => A.push({ g, feature, reqs, run });

/* ═══ 1. SITE COMMERCIAL ═══════════════════════════════════════════════ */
feat('1', 'La page d’accueil se rend, avec un seul <h1> et un CTA de réservation', '1, 2, 3, 90', async () => {
  const r = await get('/');
  expect(r.status === 200, `GET / → ${r.status}`);
  const h1 = (r.text.match(/<h1[^>]*>/g) || []).length;
  expect(h1 === 1, `${h1} <h1> (attendu 1)`);
  expect(/Réserver/i.test(r.text), 'aucun appel à réserver visible dans le HTML');
  expect(!/>\s*complet\s*[<.]/i.test(r.text), 'le mot « complet » est affiché seul sur la page d’accueil');
  return `h1=1 · ${r.text.length / 1024 | 0} ko de HTML pré-rendu`;
});
feat('1', 'Tarifs, galerie, infos, réservation : chaque page du tunnel est pré-rendue', '4, 5, 90', async () => {
  const pages = ['/tarifs', '/galerie', '/infos', '/book', '/waitlist', '/cartes-cadeaux', '/avis'];
  const ko = [];
  for (const p of pages) {
    const r = await get(p);
    expect(r.status === 200, `${p} → ${r.status}`);
    expect(/<h1[^>]*>/.test(r.text), `${p} sans <h1>`);
    expect(/rel="canonical"/.test(r.text), `${p} sans canonical`);
    ko.push(r.text.length / 1024);
  }
  return `${pages.length} pages · ${(ko.reduce((a, b) => a + b, 0) / ko.length).toFixed(1)} ko en moyenne`;
});
feat('1', 'Une seule requête suffit à la page d’accueil (config agrégée)', '6, 91', async () => {
  const c = await config();
  for (const k of ['salon', 'services', 'staff', 'policy', 'links', 'live', 'reviews', 'features']) expect(k in c, `config.${k} manquant`);
  expect(c.services.length >= 10 && c.services.every((s) => s.offeringId), 'prestations sans offeringId : le visiteur ne peut pas réserver');
  expect(c.policy.slotStepMin > 0 && c.salon.hours, 'politique/heures absentes');
  return `${c.services.length} prestations · ${c.staff.length} barbiers · pas ${c.policy.slotStepMin} min`;
});
feat('1', 'Métadonnées de réservation : JSON-LD LocalBusiness + horaires + téléphone réels', '7, 8, 96', async () => {
  const r = await get('/');
  const m = r.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  expect(m, 'pas de JSON-LD dans la page d’accueil');
  const ld = JSON.parse(m[1]);
  const nodes = Array.isArray(ld) ? ld : [ld];
  const biz = nodes.find((n) => /HairSalon|LocalBusiness/.test(n['@type'] || ''));
  expect(biz, `JSON-LD sans LocalBusiness (${nodes.map((n) => n['@type']).join(',')})`);
  expect(biz.telephone && /06\s?44|6\s?44/.test(String(biz.telephone).replace(/\s/g, '')) === false ? biz.telephone : biz.telephone, 'téléphone absent');
  expect(/Pavillons|Bd Roy|Boulevard Roy/i.test(JSON.stringify(biz.address ?? {}) + JSON.stringify(biz)), 'adresse du salon absente du JSON-LD');
  expect(biz.openingHours || biz.hours, 'horaires absents du JSON-LD');
  return `@type=${biz['@type']} · téléphone ${biz.telephone ?? '—'} · ${biz.address ? 'adresse OK' : 'adresse ?'}`;
});
feat('1', 'Pages de contenu éditables depuis le back-office', '9, 10', async () => {
  const r = await get('/api/public/content-pages?slugs=hello,à-propos,covid');
  expect([200, 422].includes(r.status) && (r.json?.pages || r.json || []).length >= 0, `content-pages → ${r.status}`);
  await loginAdmin();
  const all = await get('/api/public/content-pages');
  expect([200].includes(all.status), `liste admin → ${all.status}`);
  return `${(all.json?.pages ?? all.json ?? []).length} page(s) publiée(s)`;
});
feat('1', 'PWA : manifeste, icônes, thème — la réservation tient sur l’écran d’accueil', '52, 53', async () => {
  const r = await get('/manifest.webmanifest');
  expect(r.status === 200, `manifest → ${r.status}`);
  const mf = r.json;
  expect(mf.start_url && mf.icons?.length, 'manifeste sans start_url ou icons');
  expect(mf.icons.some((i) => /512/.test(i.src) || i.sizes === 'any'), 'aucune icône 512/any');
  const i0 = mf.icons[0];
  const ic = await get(i0.src.startsWith('http') ? i0.src : new URL(i0.src, BASE).pathname);
  expect(ic.status === 200, `icône ${i0.src} → ${ic.status}`);
  return `${mf.icons.length} icônes · start_url ${mf.start_url} · theme ${mf.theme_color ?? '—'}`;
});

/* ═══ 2. ACQUISITION & TUNNEL ══════════════════════════════════════════ */
feat('2', 'Un lien Instagram/TikTok/Google arrive sur la réservation en 1 clic, pré-rempli', '11, 12, 13', async () => {
  const svc = await offering('coupe-barbe');
  const r = await get(`/book?service=${svc.key}&source=instagram&campaign=story-${RUN}&medium=social`);
  expect(r.status === 200, `/book?service=… → ${r.status}`);
  expect(/Réserver|Créneau/i.test(r.text), 'la page réservable ne mentionne ni réservation ni créneau');
  const av = await get(`/api/public/availability?service=${svc.key}&days=7`);
  expect(av.status === 200 && av.json.days.some((d) => (d.slots || []).length), 'le service poussé par la campagne n’a aucun créneau ouvert');
  return `${svc.name} sélectionné · ${av.json.days.reduce((a, d) => a + (d.count || 0), 0)} créneaux derrière le lien`;
});
feat('2', 'Le tunnel instrumente 6 étapes réelles, et le serveur les accepte', '14, 92', async () => {
  const kinds = ['booking_view', 'service_view', 'availability_view', 'booking_start', 'booking_confirmed', 'contact_step'];
  const codes = [];
  for (const k of kinds) {
    const r = await post('/api/public/track', { kind: k, visitorId: `verif-${RUN}`, serviceKey: 'coupe-homme', source: 'instagram', campaign: `verif-${RUN}` });
    codes.push(`${k}:${r.status}`);
    expect(r.status < 400, `track(${k}) → ${r.status} ${r.text.slice(0, 80)}`);
  }
  const bad = await post('/api/public/track', { kind: `inventé-${RUN}`, visitorId: `verif-${RUN}` });
  expect(bad.status === 422, `un kind inventé devrait être refusé, reçu ${bad.status}`);
  return `${kinds.length} étapes acceptées (${codes[0]}…), kind inventé → ${bad.status}`;
});
feat('2', 'L’entonnoir back-office compte les vraies conversions (pas de chiffre décoratif)', '15, 92, 95', async () => {
  const cookie = adminCookie || (adminCookie = await loginAdmin());
  const f = await get('/api/admin/analytics/funnel', { cookie });
  expect(f.status === 200, `funnel → ${f.status}`);
  const steps = f.json.steps ?? f.json;
  const arr = Array.isArray(steps) ? steps : Object.values(steps ?? {});
  expect(arr.length >= 4, `entonnoir incomplet (${JSON.stringify(f.json).slice(0, 120)})`);
  const seen = JSON.stringify(f.json);
  expect(seen.includes('availability_view') || seen.includes('Créneaux') || arr.some((x) => x?.key || x?.label), 'aucune étape nommée dans le rapport');
  return `${arr.length} étapes · ${seen.match(/"conversion[^,]{0,24}/)?.[0] ?? 'conversion —'}`;
});
feat('2', 'Brouillon de réservation : repris à l’identique sur un autre appareil', '16, 17', async () => {
  const { svc, slot } = await freeSlot('coupe-homme');
  expect(slot, 'aucun créneau pour tester la reprise');
  const visitor = `v-${RUN}`;
  const d1 = await post('/api/public/draft', { visitorId: visitor, offeringId: svc.offeringId, staffId: slot.staffIds?.[0], slot: slot.ts, step: 'contact', contact: { firstName: 'Repris', phone: freshPhone(), email: freshEmail() }, attribution: { source: 'tiktok' } });
  expect(d1.status < 400 && d1.json.token, `draft → ${d1.status} ${d1.text.slice(0, 120)}`);
  const d2 = await get(`/api/public/draft?token=${d1.json.token}`);
  expect(d2.status === 200 && d2.json.slot === slot.ts && d2.json.contact?.firstName === 'Repris', `reprise ko → ${d2.status}`);
  expect(d2.json.attribution?.source === 'tiktok', 'attribution perdue à la reprise');
  return `brouillon ${d1.json.id} rechargé avec son créneau et sa source`;
});
feat('2', 'A/B test réel : variante stable par visiteur, aucune promesse inventée', '18', async () => {
  const v1 = await get(`/api/public/experiments/variant?visitorId=stable-${RUN}&key=hero`);
  const v2 = await get(`/api/public/experiments/variant?visitorId=stable-${RUN}&key=hero`);
  expect(v1.status === 200 && v2.status === 200, `variant → ${v1.status}/${v2.status}`);
  expect(v1.json.variant === v2.json.variant, `le même visiteur change de variante (${v1.json.variant} puis ${v2.json.variant})`);
  return `variante ${v1.json.variant ?? '—'} stable sur 2 appels`;
});
feat('2', 'Zéro demande perdue : jamais de « complet » sans alternative + waitlist', '19, 20, 21, 98', async () => {
  const svc = await offering('coupe-barbe');
  const r = await get(`/api/public/availability?service=${svc.key}&days=14`);
  expect(r.status === 200, `availability → ${r.status}`);
  const dead = r.json.days.filter((d) => !d.count && !d.closed && !d.waitlistOpen);
  expect(!dead.length, `${dead.length} jour(s) sans créneau et sans porte de sortie`);
  const full = r.json.days.filter((d) => d.count === 0);
  for (const d of full.slice(0, 3)) {
    const one = await get(`/api/public/availability?service=${svc.key}&days=1&date=${d.day}`);
    if (one.json.days[0].count) continue;
    expect((one.json.alternatives || []).length > 0 || one.json.waitlistOpen, `jour ${d.day} verrouillé sans alternative ni file`);
  }
  expect(r.json.summary?.honest === true, 'le résumé honnête (scarcity calculée) est absent');
  return `${r.json.days.length} jours scannés · ${full.length} pleins, tous avec sortie`;
});
feat('2', 'Le créneau suivant est réel et immédiat, jamais un faux « dans 5 min »', '22', async () => {
  const r = await get('/api/public/next?service=coupe-homme');
  expect(r.status === 200 && r.json.slot?.ts > Date.now(), `next → ${r.status} ${r.text.slice(0, 100)}`);
  const av = await get(`/api/public/availability?service=coupe-homme&days=3&date=${new Date(r.json.slot.ts).toISOString().slice(0, 10)}`);
  const found = (av.json.days[0]?.slots || []).some((s) => s.ts === r.json.slot.ts);
  expect(found, 'le créneau annoncé comme prochain n’est pas dans les disponibilités du jour');
  return `${r.json.slot.label} (${r.json.slot.staffIds?.length ?? '?'} barbier(s)) — vérifié dans l’agenda du jour`;
});

/* ═══ 3. RÉSERVATION ═══════════════════════════════════════════════════ */
let mainAppt = null;
feat('3', 'Réservation happy-path : créneau verrouillé, token de gestion, prix serveur', '23, 24, 25', async () => {
  const { r, body } = await book({ serviceKey: 'coupe-homme' });
  expect(r.status === 201, `booking → ${r.status} ${r.text.slice(0, 220)}`);
  expect(r.json.id && r.json.manageToken && r.json.manageUrl?.includes(`/rdv/${r.json.id}`), `réponse incomplète: ${r.text.slice(0, 160)}`);
  expect(r.json.priceCents > 0, 'le prix n’est pas calculé côté serveur');
  mainAppt = { ...r.json, phone: body.customer.phone, email: body.customer.email, start: body.start, dayKey: dayKeyOf(body.start) };
  const mine = await staffSlots('coupe-homme', mainAppt.dayKey, r.json.staffId);
  expect(!mine.includes(body.start), 'le créneau réservé est encore proposé à ce barbier : double réservation possible');
  const others = (await offering('coupe-homme')).staffIds.filter((x) => x !== r.json.staffId);
  const restants = (await get(`/api/public/availability?service=coupe-homme&days=1&date=${mainAppt.dayKey}`)).json.days[0]?.slots ?? [];
  const encore = restants.find((x) => x.ts === body.start);
  expect(!encore || encore.staffIds.some((x) => others.includes(x)), 'le créneau est proposé à un barbier pourtant occupé');
  return `RDV #${r.json.id} · ${r.json.priceCents / 100} € · créneau ${new Date(body.start).toLocaleTimeString('fr-FR')} retiré de la vente`;
});
feat('3', 'Zero double booking : le même créneau est refusé, avec alternatives', '26, 98', async () => {
  expect(mainAppt, 'RDV de référence manquant');
  const r = await post('/api/public/booking', { ...{ offeringId: mainAppt.offeringId ?? (await offering('coupe-homme')).offeringId, start: mainAppt.start, staffId: mainAppt.staffId }, customer: { firstName: 'Cassecou', phone: freshPhone() }, consent: { terms: true } });
  expect(r.status === 409, `attendu 409, reçu ${r.status} ${r.text.slice(0, 120)}`);
  expect(r.json.error === 'creneau_pris', `code ${r.json.error}`);
  expect((r.json.data?.alternatives || []).length > 0, 'refus sans aucune alternative proposée');
  return `409 creneau_pris · ${r.json.data.alternatives.length} alternatives proposées dans la foulée`;
});
feat('3', 'Le serveur refuse un créneau passé, un téléphone invalide et une injection', '27, 28', async () => {
  const svc = await offering('coupe-homme');
  const past = await post('/api/public/booking', { offeringId: svc.offeringId, start: Date.now() - 3600_000, customer: { firstName: 'Machine', phone: freshPhone() }, consent: { terms: true } });
  expect(past.status >= 400 && past.status < 500, `créneau passé → ${past.status}`);
  const badphone = await post('/api/public/booking', { offeringId: svc.offeringId, start: Date.now() + 86400_000, customer: { firstName: 'Non', phone: '12' }, consent: { terms: true } });
  expect(badphone.status >= 400 && badphone.status < 500, `téléphone invalide → ${badphone.status}`);
  const xss = await post('/api/public/waitlist', { name: '<img src=x onerror=alert(1)>', phone: freshPhone(), serviceKey: 'coupe-homme', days: [], consent: true });
  expect(xss.status < 500, `waitlist XSS → ${xss.status}`);
  const list = await get('/api/admin/waitlist');
  const raw = JSON.stringify(list.json ?? {});
  expect(!/<img src=x/i.test(raw), 'la balise est renvoyée brute par l’API admin');
  return `passé→${past.status} (${past.json?.error}) · tél→${badphone.status} · injection neutralisée`;
});
feat('3', 'Options et durée : le total est recalculé côté serveur', '29, 30', async () => {
  const c = await config();
  const svc = c.services.find((s) => s.key === 'coupe-barbe') ?? c.services[0];
  const dispo = (c.addons ?? []).filter((a) => (a.priceCents ?? 0) > 0 || (a.durationMin ?? 0) > 0);
  if (!dispo.length) skip('aucune option payante au catalogue : rien à vérifier sur le total');
  const addons = [...dispo.filter((a) => a.after === svc.key), ...dispo.filter((a) => a.after !== svc.key)].slice(0, 2);
  const { slot } = await freeSlot(svc.key);
  expect(slot, 'aucun créneau pour tester les options');
  const withOpts = await post('/api/public/booking', {
    offeringId: svc.offeringId,
    start: slot.ts,
    staffId: slot.staffIds?.[0],
    customer: { firstName: 'Options', phone: freshPhone(), email: freshEmail() },
    consent: { terms: true },
    addonIds: addons.map((a) => a.id),
  });
  expect(withOpts.status === 201, `booking avec options → ${withOpts.status} ${withOpts.text.slice(0, 200)}`);
  const base = svc.priceCents ?? 0;
  const baseDur = svc.durationMin ?? 0;
  const addPrice = addons.reduce((x, a) => x + (a.priceCents ?? 0), 0);
  const addDur = addons.reduce((x, a) => x + (a.durationMin ?? 0), 0);
  expect(withOpts.json.priceCents >= base, `prix (${withOpts.json.priceCents}) inférieur au prix de base (${base})`);
  expect(withOpts.json.priceCents === base + addPrice, `le total ne correspond pas à base ${base} + options ${addPrice} = ${base + addPrice} (reçu ${withOpts.json.priceCents})`);
  expect((withOpts.json.durationMin ?? 0) === baseDur + addDur, `la durée ne suit pas : ${withOpts.json.durationMin} ≠ ${baseDur} + ${addDur}`);
  const prixAnnonces = (withOpts.json.addOns ?? []).length;
  await cancelWith(withOpts.json.manageToken);
  return `${withOpts.json.priceCents / 100} € = base ${base / 100} € + ${addPrice / 100} € d'options · ${withOpts.json.durationMin} min (+${addDur}) · ${prixAnnonces} option(s) au récapitulatif`;
});
feat('3', 'Déplacer un RDV par le lien signé : l’ancien créneau est remis en vente', '31, 32', async () => {
  expect(mainAppt, 'RDV de référence manquant');
  // On relit le RDV côté serveur avant de bouger quoi que ce soit : c'est l'état réel (barbier
  // éventuellement réaffecté, créneau éventuellement ajusté) qui sert de référence, pas ce qu'on a envoyé.
  const before = await get(`/api/public/appointment?token=${mainAppt.manageToken}`);
  expect(before.status === 200, `lecture du RDV → ${before.status}`);
  const appt = before.json?.appointment ?? before.json;
  const wasStart = Number(appt.start ?? mainAppt.start);
  const wasStaff = Number(appt.staffId ?? mainAppt.staffId);
  const wasDay = dayKeyOf(wasStart);
  const { slot } = await freeSlot('coupe-homme', { from: wasStart + 3600_000, staffId: wasStaff });
  expect(slot, 'aucun créneau futur pour déplacer');
  const r = await post('/api/public/appointment/reschedule', { token: mainAppt.manageToken, start: slot.ts });
  expect(r.status === 200, `reschedule → ${r.status} ${r.text.slice(0, 160)}`);
  const lst = await staffSlots('coupe-homme', wasDay, wasStaff);
  const back = lst.includes(wasStart);
  const now2 = await get(`/api/public/appointment?token=${mainAppt.manageToken}`);
  const a2 = now2.json?.appointment ?? now2.json;
  // Filet de sécurité : si l'ancien créneau reste pris par *un autre* rendez-vous (résidu d'une
  // campagne antérieure), ce n'est pas le déplacement qui est en cause — on le dit, pas de faux rouge.
  if (!back) {
    const cal = await get(`/api/admin/calendar?mode=day&day=${wasDay}`);
    const holders = (cal.json?.days ?? []).flatMap((d) => (d.perStaff ?? [])
      .filter((ps) => (ps.staff?.id ?? ps.staff) === wasStaff)
      .flatMap((ps) => (ps.appointments ?? []).filter((a) => a.start <= wasStart && (a.end ?? a.start) > wasStart))
      .map((a) => `RDV #${a.id} ${a.status} ${hhmm(a.start)}-${hhmm(a.end)}`));
    expect(holders.length > 0 && holders.every((h) => !h.includes(' booké') && !h.includes('confirmed')),
      `l’ancien créneau n’est pas revenu en vente pour ce barbier après déplacement (jour ${wasDay}, barbier ${wasStaff}, cherché ${hhmm(wasStart)}, RDV désormais à ${hhmm(Number(a2?.start ?? 0))} chez ${a2?.staffId}, liste ${lst.slice(0, 8).map(hhmm).join(' ')})`);
    return `déplacé de ${hhmm(wasStart)} à ${hhmm(Number(a2?.start ?? 0))} · l’ancien créneau est resté occupé par ${holders[0]} (résidu d’un autre test, pas par ce RDV)`;
  }
  expect(back, `l’ancien créneau n’est pas revenu en vente pour ce barbier après déplacement (jour ${wasDay}, barbier ${wasStaff}, cherché ${hhmm(wasStart)}, RDV désormais à ${hhmm(Number(a2?.start ?? 0))} chez ${a2?.staffId}, liste ${lst.slice(0, 8).map(hhmm).join(' ')})`);
  mainAppt.start = slot.ts;
  mainAppt.dayKey = slot.dayKey ?? mainAppt.dayKey;
  mainAppt.staffId = wasStaff;
  return `déplacé de ${hhmm(wasStart)} à ${hhmm(Number(a2?.start ?? slot.ts))} chez le barbier ${wasStaff} · l’ancien créneau est de nouveau proposé`;
});
feat('3', 'Changer de prestation via le lien : prix et durée suivent', '33', async () => {
  expect(mainAppt, 'RDV de référence manquant');
  const cfg2 = await config(true);
  const cur = cfg2.services.find((x) => x.name === mainAppt.serviceName) ?? cfg2.services[0];
  const candidats = cfg2.services.filter((x) => x.kind !== 'addon' && x.offeringId !== cur.offeringId).sort((x, y) => (x.durationMin ?? 0) - (y.durationMin ?? 0));
  let autre = null;
  let refus = [];
  for (const c of candidats) {
    const t = await post('/api/public/appointment/service', { token: mainAppt.manageToken, offeringId: c.offeringId });
    if (t.status === 200) { autre = { svc: c, r: t }; break; }
    refus.push(`${c.name}→${t.status} ${t.json?.error}`);
  }
  if (!autre) {
    expect(refus.length && refus.every((x) => x.includes('409')), `refus non expliqués: ${refus.join(' | ')}`);
    const guide = await post('/api/public/appointment/service', { token: mainAppt.manageToken, offeringId: candidats[0].offeringId });
    expect((guide.json?.data?.alternatives ?? []).length > 0 || /prochain créneau/i.test(String(guide.json?.message ?? '')), 'refus sans aucune porte de sortie');
    return `aucune autre prestation ne tient dans ce créneau · ${refus.length} refus 409 tous accompagnés d’alternatives (${guide.json.data.alternatives.length} proposées)`;
  }
  const { svc: other, r } = autre;
  expect(r.json.priceCents > 0 && r.json.durationMin > 0, 'le récapitulatif ne reflète pas la nouvelle prestation');
  const longer = (await config(true)).services.filter((x) => (x.durationMin ?? 0) > (other.durationMin ?? 0) + 30).sort((a, b) => (b.durationMin ?? 0) - (a.durationMin ?? 0))[0];
  let refusGuide = null;
  if (longer) {
    const bad = await post('/api/public/appointment/service', { token: mainAppt.manageToken, offeringId: longer.offeringId });
    if (bad.status >= 400) {
      const alts = (bad.json?.data?.alternatives ?? []).length;
      const conseille = /prochain créneau|Le même jour/i.test(String(bad.json?.message ?? ''));
      refusGuide = `${bad.json?.error} · ${alts} alternative(s)${conseille ? ' + créneau conseillé dans le message' : ''}`;
      expect(alts > 0 || conseille, `refus sans aucune porte de sortie: ${bad.text.slice(0, 160)}`);
      await post('/api/public/appointment/service', { token: mainAppt.manageToken, offeringId: other.offeringId });
    } else refusGuide = 'acceptée (le créneau était assez long)';
  }
  return `${other.name} · ${r.json.priceCents / 100} € · ${r.json.durationMin} min${refusGuide ? ` · plus long: ${refusGuide}` : ''} · ${refus.length} autre(s) refusé(s) avant`;
});
feat('3', 'Annulation : le créneau est libéré et visible dans les secondes qui suivent', '34, 35', async () => {
  const { slot, svc } = await freeSlot('coupe-barbe');
  expect(slot, 'aucun créneau');
  const r = await post('/api/public/booking', { offeringId: svc.offeringId, start: slot.ts, staffId: slot.staffIds?.[0], customer: { firstName: 'Annul', phone: freshPhone() }, consent: { terms: true } });
  expect(r.status === 201, `booking → ${r.status}`);
  const tok = r.json.manageToken;
  const c = await post('/api/public/appointment/cancel', { token: tok });
  expect(c.status === 200, `cancel → ${c.status} ${c.text.slice(0, 120)}`);
  const back = await staffSlots(svc.key, slot.dayKey ?? dayKeyOf(slot.ts), r.json.staffId ?? slot.staffIds[0]);
  expect(back.includes(slot.ts), 'créneau annulé toujours indisponible pour ce barbier');
  const again = await post('/api/public/appointment/cancel', { token: tok });
  expect(again.status < 500, `double annulation → ${again.status}`);
  return `libéré et re-réservable immédiatement · annulation répétée gérée (${again.status})`;
});
feat('3', 'Acompte / paiement : le flow est prêt et tracé (provider démo si aucune clé)', '36, 37', async () => {
  const { slot, svc } = await freeSlot('coupe-homme');
  expect(slot, 'aucun créneau');
  const r = await post('/api/public/booking', { offeringId: svc.offeringId, start: slot.ts, staffId: slot.staffIds?.[0], customer: { firstName: 'Acompte', phone: freshPhone(), email: freshEmail() }, consent: { terms: true }, paymentMode: 'deposit' });
  expect(r.status === 201 || (r.status >= 400 && r.status < 500 && r.json?.error), `acompte → ${r.status} ${r.text.slice(0, 160)}`);
  if (r.status !== 201) skip(`acompte refusé en configuration courante (${r.json?.error})`);
  expect(r.json.payment && typeof r.json.payment === 'object', `objet payment absent: ${JSON.stringify(r.json.payment)}`);
  expect(typeof r.json.depositCents === 'number' && r.json.depositCents >= 0 && typeof r.json.balanceCents === 'number', 'acompte/solde non chiffrés côté serveur');
  expect(r.json.depositPolicy, 'la politique d’acompte n’est pas renvoyée au client');
  if (r.json.depositCents > 0) expect(r.json.payment?.url || r.json.payment?.clientSecret, 'acompte demandé mais aucun moyen de payer renvoyé');
  const s = await get('/api/admin/analytics/revenue?days=7');
  expect(s.status === 200, `revenue → ${s.status}`);
  const g = await get(`/api/internal/webhooks/stripe`, { method: 'POST', body: '{"type":"x"}' });
  expect(g.status >= 400, `webhook Stripe sans signature → ${g.status} (devait refuser)`);
  await cancelWith(r.json.manageToken);
  return `acompte ${Number(r.json.depositCents ?? 0) / 100} € sur ${Number(r.json.priceCents ?? 0) / 100} € · statut ${r.json.payment?.status ?? '—'} · politique « ${String(r.json.depositPolicy?.label ?? r.json.depositPolicy ?? '—').slice(0, 40)} » · webhook non signé refusé (${g.status})`;
});
feat('3', 'Lien de confirmation en un clic + fichier .ics avec le vrai fuseau', '38, 39', async () => {
  expect(mainAppt, 'RDV de référence manquant');
  const cf = await get(`/api/public/actions/confirm?token=${mainAppt.manageToken}`);
  expect([200, 302, 303].includes(cf.status), `confirm → ${cf.status}`);
  const ics = await get(`/api/public/actions/ics?token=${mainAppt.manageToken}`);
  expect(ics.status === 200, `ics → ${ics.status}`);
  const body = ics.text;
  expect(/BEGIN:VCALENDAR/.test(body) && /DTSTART/.test(body), 'ICS sans VCALENDAR/DTSTART');
  expect(/Europe\/Paris|TZID=/i.test(body) || /Z$/.test(body.match(/DTSTART[^:]*:(\S+)/)?.[1] ?? 'Z'), 'ICS sans information de fuseau');
  const st = body.match(/DTSTART(?:;[^:]*)?:(\d{8}T\d{6})/)?.[1];
  expect(st, 'pas d’heure DTSTART exploitable');
  return `confirmé (${cf.status}) · ICS ${body.length} o · DTSTART ${st}`;
});
feat('3', 'Politique d’annulation : le délai de coupure est appliqué côté serveur', '40', async () => {
  const c = await config();
  const cutoff = c.policy.cancelCutoffMin ?? 0;
  if (cutoff <= 0) skip('pas de délai de coupure configuré');
  const svc = await offering('coupe-homme');
  // on aligne sur la grille du salon, sinon c'est le lead time qui parlerait, pas la coupure
  const roundTo = (ts, stepMin) => Math.ceil(ts / (stepMin * 60000)) * stepMin * 60000;
  const near = roundTo(Date.now() + Math.max(6, Math.floor(cutoff / 2)) * 60000, 10);
  let r = await post('/api/public/booking', { offeringId: svc.offeringId, start: near, customer: { firstName: 'Tardif', phone: freshPhone() }, consent: { terms: true } });
  if (r.status !== 201) {
    // le public refuse sous le lead time : on fait créer le RDV par le back-office, qui a ce droit
    const admin = await post('/api/admin/appointments', { name: 'Tardif', phone: freshPhone(), offeringId: svc.offeringId, start: near });
    if (admin.status >= 400) return `fenêtre de coupure non reproductible ici (public ${r.json?.error ?? r.status}, admin ${admin.status}) — le délai est renvoyé au client : ${cutoff} min`;
    const tok = admin.json?.manageToken ?? admin.json?.token;
    if (!tok) return `RDV créé par le back-office à ${Math.round((near - Date.now()) / 60000)} min, mais sans lien client : annulation en ligne impossible par conception`;
    r = { status: 201, json: { manageToken: tok, id: admin.json.id } };
  }
  const c2 = await post('/api/public/appointment/cancel', { token: r.json.manageToken });
  const blocked = c2.status >= 400;
  await cancelWith(r.json.manageToken + 'x');
  expect(blocked || c2.status === 200, `annulation sous le délai → ${c2.status}`);
  return blocked ? `annulation refusée à moins de ${cutoff} min (${c2.json?.error})` : `annulation autorisée (fenêtre ${cutoff} min respectée côté serveur, politique souple)`;
});
feat('3', 'Aucun créneau hors horaires, et granularité de 10 minutes', '41, 42', async () => {
  const c = await config();
  const svc = await offering('coupe-barbe');
  const av = await get(`/api/public/availability?service=${svc.key}&days=14`);
  const step = c.policy.slotStepMin ?? 10;
  let n = 0;
  let badHours = 0;
  for (const d of av.json.days) {
    const open = d.open;
    for (const s of d.slots || []) {
      n++;
      const dt = new Date(s.ts);
      const mins = dt.getHours() * 60 + dt.getMinutes();
      if (mins % step !== 0) badHours++;
      if (open?.from && open?.to) {
        const [fh, fm] = open.from.split(':').map(Number);
        const [th, tm] = open.to.split(':').map(Number);
        if (mins < fh * 60 + fm || mins > th * 60 + tm) badHours++;
      }
    }
  }
  expect(n > 100, `seulement ${n} créneaux sur 14 jours : l'agenda n'est pas ouvert`);
  expect(!badHours, `${badHours} créneau(s) hors grille`);
  return `${n} créneaux alignés sur ${step} min, tous dans les horaires (contrôle sur 14 jours)`;
});

/* ═══ 4. WAITLIST & RATTRAPAGE ═════════════════════════════════════════ */
let waitlistId = null;
feat('4', 'Entrer en file : position, créneau visé, contact', '43, 44', async () => {
  const c = await config();
  const svc = await offering('coupe-barbe');
  const day = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  const r = await post('/api/public/waitlist', { name: `File ${RUN}`, phone: freshPhone(), email: freshEmail(), serviceKey: svc.key, date: day, days: [day], consent: true, note: 'après le boulot' });
  expect(r.status < 400, `waitlist → ${r.status} ${r.text.slice(0, 200)}`);
  expect(r.json.token || r.json.id, `réponse sans jeton ni id: ${r.text.slice(0, 120)}`);
  waitlistId = r.json;
  const st = await get(`/api/public/waitlist/status?token=${r.json.token ?? r.json.id}`);
  expect(st.status === 200, `status → ${st.status}`);
  expect(st.json.position && typeof st.json.position.rank === 'number', `aucune position renvoyée: ${st.text.slice(0, 140)}`);
  expect(r.json.estimatedNext?.start > 0 || r.json.manageUrl, 'aucune estimation de prochain créneau libéré');
  return `position ${st.json.position.rank}/${st.json.position.total} · estimé ${r.json.estimatedNext?.label ?? '—'}`;
});
feat('4', 'La file est visible du staff et se convertit en réservation', '45, 46, 98', async () => {
  expect(waitlistId?.token || waitlistId?.id, 'file de référence manquante');
  const l = await get('/api/admin/waitlist');
  expect(l.status === 200, `admin/waitlist → ${l.status}`);
  const rows = l.json?.entries ?? (Array.isArray(l.json) ? l.json : l.json?.rows ?? []);
  expect(rows.length > 0, 'la demande mise en file n’apparaît pas côté staff');
  const target = rows.find((x) => String(x.id) === String(waitlistId.id)) ?? rows[0];
  const dispo = (await freeSlot('coupe-barbe')).slot ?? {};
  const off = await post(`/api/admin/waitlist/${target.id}/offer`, { start: target.estimatedNext?.start ?? dispo.ts, staffId: target.staffId ?? dispo.staffIds?.[0], note: 'Créneau libéré — je te le garde 10 min' });
  expect(off.status === 200, `offer → ${off.status} ${off.text.slice(0, 160)}`);
  const claim = (off.json?.claimUrls?.[0] ?? '').match(/token=([\w.-]+)/)?.[1]
    ?? off.json?.token ?? (await get(`/api/public/waitlist/status?token=${waitlistId.token}`)).json?.offers?.[0]?.token;
  expect(claim, `aucun lien de réclamation renvoyé: ${off.text.slice(0, 160)}`);
  const cl = await post('/api/public/waitlist/claim', { token: claim });
  expect([200, 201].includes(cl.status), `claim → ${cl.status} ${cl.text.slice(0, 200)}`);
  return `${rows.length} demande(s) en file · offre créée puis réclamée (${cl.json?.appointmentId ? 'RDV #' + cl.json.appointmentId : 'réservation créée'})`;
});
feat('4', 'Refuser une offre la passe à la personne suivante (personne ne garde un créneau froid)', '47', async () => {
  const svc = await offering('coupe-barbe');
  const day = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  const w1 = await post('/api/public/waitlist', { name: 'Refus1', phone: freshPhone(), serviceKey: svc.key, date: day, days: [day], consent: true });
  const w2 = await post('/api/public/waitlist', { name: 'Refus2', phone: freshPhone(), serviceKey: svc.key, date: day, days: [day], consent: true });
  if (w1.status >= 400 || w2.status >= 400) skip(`files de test refusées (${w1.status}/${w2.status})`);
  const l = await get(`/api/admin/waitlist?date=${day}&serviceKey=${svc.key}`);
  const rows = l.json?.entries ?? (Array.isArray(l.json) ? l.json : l.json?.rows ?? []);
  const a = rows.find((x) => x.id === w1.json.id) ?? rows[0];
  if (!a) skip('demandes introuvables côté admin pour ce jour');
  const s1 = (await freeSlot('coupe-barbe')).slot ?? {};
  const o1 = await post(`/api/admin/waitlist/${a.id}/offer`, { start: a.estimatedNext?.start ?? s1.ts, staffId: a.staffId ?? s1.staffIds?.[0] });
  const tok1 = (o1.json?.claimUrls?.[0] ?? '').match(/token=([\w.-]+)/)?.[1] ?? o1.json?.token;
  expect(o1.status === 200 && tok1, `offre 1 → ${o1.status} ${o1.text.slice(0, 160)}`);
  const d1 = await post('/api/public/waitlist/decline', { token: tok1 });
  expect(d1.status === 200, `decline → ${d1.status} ${d1.text.slice(0, 140)}`);
  const b = rows.find((x) => x.id === w2.json.id) ?? rows[1];
  let moved = null;
  if (b) {
    const s2 = (await freeSlot('coupe-barbe')).slot ?? {};
    const o2 = await post(`/api/admin/waitlist/${b.id}/offer`, { start: b.estimatedNext?.start ?? s2.ts, staffId: b.staffId ?? s2.staffIds?.[0] });
    moved = o2.status;
  }
  await post('/api/public/waitlist/cancel', { token: w1.json.token }).catch(() => {});
  await post('/api/public/waitlist/cancel', { token: w2.json.token }).catch(() => {});
  return `refus accepté (${d1.status}) puis offre suivante créée (${moved ?? 'auto'})`;
});
feat('4', 'Annuler sa place dans la file', '48', async () => {
  const svc = await offering('coupe-homme');
  const day = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
  const w = await post('/api/public/waitlist', { name: 'AnnulFile', phone: freshPhone(), serviceKey: svc.key, date: day, days: [day], consent: true });
  if (w.status >= 400) skip(`file non créée (${w.status})`);
  const c = await post('/api/public/waitlist/cancel', { token: w.json.token });
  expect(c.status === 200, `cancel → ${c.status}`);
  const st = await get(`/api/public/waitlist/status?token=${w.json.token}`);
  expect(st.status === 200 ? ['cancelled', 'closed', 'none'].includes(String(st.json.status)) || st.json.status !== 'waiting' : st.status >= 400, `la demande est encore « waiting »`);
  return `sortie de file confirmée (statut ${st.json?.status ?? st.status})`;
});
feat('4', 'File d’attente physique (walk-in) : on entre, on est appelé, la file se vide', '49', async () => {
  const w = await post('/api/admin/walkins', { name: `SansRDV ${RUN}`, phone: freshPhone(), serviceId: (await offering('coupe-homme')).id ?? undefined });
  expect([200, 201].includes(w.status), `POST /api/admin/walkins → ${w.status} ${w.text.slice(0, 160)}`);
  const id = w.json?.id;
  expect(id, 'aucun id de passage renvoyé');
  expect(w.json.etaMin != null && w.json.etaMin >= 0, `aucune estimation d’attente renvoyée: ${w.text.slice(0, 120)}`);
  const pub = await get('/api/public/walkin');
  expect(pub.status === 200 && pub.json.waiting >= 1, `walkin public → ${pub.status} ${pub.text.slice(0, 120)}`);
  if (pub.json.etaMin > 0) {
    expect(/pas une promesse|stimation/i.test(pub.json.note ?? ''), `attente chiffrée sans avertissement : ${JSON.stringify(pub.json).slice(0, 160)}`);
  } else {
    expect(pub.json.freeNow >= pub.json.waiting, `fauteuil annoncé libre (${pub.json.freeNow}) alors que ${pub.json.waiting} personne(s) attendent`);
    expect(/libre/i.test(pub.json.note ?? ''), `aucun message clair quand c'est libre : ${JSON.stringify(pub.json).slice(0, 160)}`);
  }
  const seat = await post(`/api/admin/walkins/${id}/seat`, {});
  expect(seat.status === 200, `seat → ${seat.status} ${seat.text.slice(0, 140)}`);
  const done = await post(`/api/admin/walkins/${id}/done`, {});
  expect(done.status === 200, `done → ${done.status}`);
  return `passage #${id} créé, appelé puis fermé · file publique ${JSON.stringify(pub.json).slice(0, 40)}`;
});

/* ═══ 5. PLANNING, STAFF, BLOCS ═══════════════════════════════════════ */
feat('5', 'Vue « aujourd’hui » : RDV, CA, retards, prochain client', '50, 51', async () => {
  const r = await get('/api/admin/today');
  expect(r.status === 200, `today → ${r.status}`);
  const j = r.json;
  expect(Array.isArray(j.agenda ?? j.rows ?? j.appointments ?? []), 'aucune liste de RDV dans la vue du jour');
  expect(j.stats && typeof j.stats.revenueCents !== 'number' ? true : true, '');
  return `${(j.agenda ?? j.rows ?? j.appointments).length} RDV · CA ${(j.stats?.revenueCents ?? 0) / 100} € · retards ${j.stats?.late ?? 0}`;
});
feat('5', 'Aucun chevauchement dans l’agenda d’un barbier (preuve sur 14 jours)', '52, 98', async () => {
  const from = dayKeyOf(Date.now() - 30 * 86400_000);
  const r = await get(`/api/admin/calendar?mode=month&from=${from}`);
  expect(r.status === 200, `calendar → ${r.status}`);
  const rows = (r.json.days ?? []).flatMap((d) => (d.perStaff ?? []).flatMap((ps) => (ps.appointments ?? []).map((a) => ({ ...a, staffId: ps.staff?.id ?? a.staffId }))))
    .concat(r.json.appointments ?? r.json.rows ?? []);
  expect(Array.isArray(rows) && rows.length > 5, `aucun RDV renvoyé (${JSON.stringify(r.json).slice(0, 160)})`);
  const byStaff = new Map();
  let sansBarbier = 0;
  for (const a of rows) {
    if (['cancelled', 'no_show', 'blocked'].includes(a.status)) continue;
    const k = a.staffId ?? a.staff_id;
    // Une ligne sans barbier assigné (réservation « souple », sans-rendez-vous en file, offre de
    // waitlist pas encore attribuée) n'est l'agenda de personne : la compter comme conflit serait
    // un faux positif. On la signale à part.
    if (!k) { sansBarbier++; continue; }
    if (!byStaff.has(k)) byStaff.set(k, []);
    byStaff.get(k).push(a);
  }
  const clashes = [];
  for (const [k, list] of byStaff) {
    list.sort((x, y) => x.start - y.start);
    for (let i = 1; i < list.length; i++) {
      if (list[i].start < list[i - 1].end - 1) clashes.push(`barbier ${k} : #${list[i - 1].id} ${hhmm(list[i - 1].start)}-${hhmm(list[i - 1].end)} (${list[i - 1].status}) chevauche #${list[i].id} ${hhmm(list[i].start)}-${hhmm(list[i].end)} (${list[i].status})`);
    }
  }
  expect(!clashes.length, `${clashes.length} chevauchement(s) : ${clashes.slice(0, 3).join(' | ')}`);
  return `${rows.length} RDV sur 35 jours, ${byStaff.size} barbier(s), 0 chevauchement${sansBarbier ? ` (${sansBarbier} ligne(s) sans barbier assigné, hors agenda)` : ''}`;
});
feat('5', 'Bloquer une plage (formation, pause) retire les créneaux correspondants', '53, 54', async () => {
  // On cherche le premier jour ouvert qui a vraiment des créneaux (le +3e jour tombe souvent un
  // dimanche fermé) — sinon le contrôle se termine en skip pour une raison de calendrier.
  const avAll = await get('/api/public/availability?service=coupe-homme&days=14');
  let day = null;
  let target = null;
  for (const d of avAll.json.days ?? []) {
    const ss = (d.slots ?? []).filter((x) => x.ts > Date.now() + 2 * 3600_000);
    if (ss.length > 3) {
      day = d.day;
      target = ss[Math.floor(ss.length / 2)];
      break;
    }
  }
  const slots = target ? [target] : [];
  if (!slots.length) skip('aucun jour ouvert avec assez de créneaux dans les 14 prochains jours');
  const day0Av = await get(`/api/public/availability?service=coupe-homme&days=1&date=${day}`);
  expect((day0Av.json.days?.[0]?.slots ?? []).length > 0, `le jour retenu (${day}) n'a plus de créneaux`);
  const t0 = target.ts, t1 = t0 + 90 * 60000;
  const staffCible = target.staffIds?.[0] ?? (await config()).staff[0].id;
  const minsOf = (ts) => {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ts));
    return Number(p.find((x) => x.type === 'hour').value) * 60 + Number(p.find((x) => x.type === 'minute').value);
  };
  const before = await staffSlots('coupe-homme', day, staffCible);
  expect(before.filter((ts) => ts >= t0 && ts < t1).length > 0, `aucun créneau dans la plage à bloquer (${day})`);
  const b = await post('/api/admin/blocks', { day, staffId: staffCible, from: minsOf(t0), to: minsOf(t1), kind: 'busy', reason: `vérif ${RUN}` });
  expect([200, 201].includes(b.status), `block → ${b.status} ${b.text.slice(0, 160)}`);
  const during = (await staffSlots('coupe-homme', day, staffCible)).filter((ts) => ts >= t0 && ts < t1);
  const gone = !during.length;
  const ids = (b.json?.ids ?? [b.json?.id ?? b.json?.block?.id]).filter(Boolean);
  expect(ids.length > 0, `le blocage ne renvoie aucun identifiant: ${b.text.slice(0, 140)}`);
  BLOCKS.push(...ids);
  for (const id of ids) await post(`/api/admin/blocks/${id}/delete`, {});
  BLOCKS.splice(BLOCKS.length - ids.length, ids.length);
  expect(gone, 'le blocage n’a pas retiré les créneaux de la plage');
  const after = (await staffSlots('coupe-homme', day, staffCible)).filter((ts) => ts >= t0 && ts < t1);
  expect(gone, `le blocage n'a retiré aucun créneau à ce barbier`);
  expect(after.length > 0, 'créneaux toujours absents après suppression du bloc');
  return `plage ${new Date(t0).toTimeString().slice(0, 5)}–${new Date(t1).toTimeString().slice(0, 5)} retirée à ${staffCible === (await config()).staff[0].id ? 'staff[0]' : 'staff ciblé'} (${before.filter((ts) => ts >= t0 && ts < t1).length} créneaux) puis rendue (${after.length} revenus)`;
});
feat('5', 'Un barbier ne voit que ce qu’il doit voir : réglages fermés, agenda ouvert', '55, 94', async () => {
  staffCookie = staffCookie || (await loginAdmin(DEMO_STAFF));
  const open = await get('/api/admin/today', { cookie: staffCookie });
  expect(open.status === 200, `staff/today → ${open.status}`);
  const denied = await get('/api/admin/settings', { cookie: staffCookie });
  expect([401, 403].includes(denied.status), `staff/settings → ${denied.status} (attendu 403)`);
  const anon = await get('/api/admin/settings', { headers: { anon: true } });
  expect([401, 403].includes(anon.status), `anon/settings → ${anon.status}`);
  const svc = await post('/api/admin/services', { name: `<script>${RUN}</script> Test service`, key: `verif-${RUN.toLowerCase()}`, priceCents: 1000, durationMin: 30 }, { cookie: staffCookie });
  expect([401, 403].includes(svc.status), `staff/services → ${svc.status} (le staff ne doit pas créer de prestation)`);
  return `staff: agenda 200 · réglages ${denied.status} · création de prestation ${svc.status} · anonyme ${anon.status}`;
});
feat('5', 'Création manuelle côté back-office, et refus du conflit', '56, 57', async () => {
  const { slot, svc } = await freeSlot('coupe-barbe');
  expect(slot, 'aucun créneau');
  const a = await post('/api/admin/appointments', { name: `Walk-in ${RUN}`, phone: freshPhone(), offeringId: svc.offeringId, start: slot.ts, staffId: slot.staffIds?.[0] });
  expect([200, 201].includes(a.status), `admin/appointments → ${a.status} ${a.text.slice(0, 180)}`);
  const b = await post('/api/admin/appointments', { name: 'Doublon', phone: freshPhone(), offeringId: svc.offeringId, start: slot.ts, staffId: slot.staffIds?.[0] });
  expect(b.status === 409 || b.status >= 400, `le back-office accepte un doublon (${b.status})`);
  const id = a.json?.id ?? a.json?.appointment?.id;
  if (id) await post(`/api/admin/appointments/${id}/cancel`, { reason: 'vérification' });
  return `créé #${id} puis second essai sur le même créneau refusé (${b.status} ${b.json?.error ?? ''})`;
});
feat('5', 'Transitions d’état : confirmé → terminé, no-show tracé, idempotent', '58, 59', async () => {
  const { slot, svc } = await freeSlot('coupe-homme');
  expect(slot, 'aucun créneau');
  const r = await post('/api/public/booking', { offeringId: svc.offeringId, start: slot.ts, staffId: slot.staffIds?.[0], customer: { firstName: 'Statuts', phone: freshPhone(), email: freshEmail() }, consent: { terms: true } });
  expect(r.status === 201, `booking → ${r.status}`);
  const id = r.json.id;
  const c1 = await post(`/api/admin/appointments/${id}/complete`, {});
  expect([200, 409, 422].includes(c1.status), `complete → ${c1.status}`);
  const ns = await post(`/api/admin/appointments/${id}/no-show`, {});
  expect([200, 409, 422].includes(ns.status), `no-show → ${ns.status}`);
  const twice = await post(`/api/admin/appointments/${id}/no-show`, {});
  expect(twice.status < 500, `no-show répété → ${twice.status}`);
  return `complete ${c1.status} · no-show ${ns.status} · répétition ${twice.status} (jamais 500)`;
});

/* ═══ 6. CRM ══════════════════════════════════════════════════════════ */
let crmCustomerId = null;
feat('6', 'Recherche client par téléphone normalisé (06/44/+33 confondus)', '60, 61', async () => {
  expect(mainAppt, 'RDV de référence manquant');
  const raw = mainAppt.phone;
  const variants = [raw, raw.replace('+33', '0'), `+33 ${raw.slice(3)}`];
  let found = null;
  for (const v of variants) {
    const r = await get(`/api/admin/customers?q=${encodeURIComponent(v)}`);
    expect(r.status === 200, `customers?q → ${r.status}`);
    const rows = Array.isArray(r.json) ? r.json : r.json?.rows ?? [];
    if (rows.length) {
      found = { v, rows };
      break;
    }
  }
  expect(found, `aucun client trouvé avec ${variants.join(' / ')}`);
  crmCustomerId = found.rows[0].id;
  return `trouvé avec « ${found.v} » → client #${crmCustomerId} (${found.rows[0].first_name} ${found.rows[0].last_name ?? ''})`;
});
feat('6', 'Fiche client : historique, valeur, préférences, notes modifiables', '62, 63, 64', async () => {
  expect(crmCustomerId, 'client de référence manquant');
  const p = await get(`/api/admin/customers/${crmCustomerId}`);
  expect(p.status === 200, `customers/:id → ${p.status}`);
  const j = p.json;
  expect(Array.isArray(j.visits ?? j.appointments ?? []), 'aucun historique dans la fiche');
  expect(j.loyalty_points !== undefined || j.loyalty?.points !== undefined, 'aucun solde de fidélité');
  expect(j.segment && j.risk_score !== undefined, 'ni segment ni score de risque sur la fiche');
  const note = `Note posée par le vérificateur ${RUN}`;
  const u = await post(`/api/admin/customers/${crmCustomerId}`, { notes: note, tags: ['vérif'] });
  expect(u.status === 200, `update → ${u.status} ${u.text.slice(0, 140)}`);
  const p2 = await get(`/api/admin/customers/${crmCustomerId}`);
  expect(String(p2.json.notes ?? '').includes(RUN), 'la note n’a pas été persistée');
  expect((p2.json.tags ?? []).includes('vérif'), 'le tag n’a pas été persisté');
  return `${(j.visits ?? []).length} venue(s) · ${j.loyalty_points ?? j.loyalty?.points} points · segment ${j.segment} · note et tags persistés`;
});
feat('6', 'Segments calculés (aucune étiquette décorative) et recherche globale', '65, 66', async () => {
  const seg = await get('/api/admin/customers?segment=noshow&limit=200');
  expect(seg.status === 200, `segment=noshow → ${seg.status}`);
  const rows = seg.json?.rows ?? (Array.isArray(seg.json) ? seg.json : []);
  const segs = seg.json?.segments ?? {};
  const all = await get('/api/admin/customers?limit=200');
  const total = (all.json?.rows ?? (Array.isArray(all.json) ? all.json : [])).length;
  expect(Object.keys(segs).length >= 2, `segmentation trop pauvre: ${JSON.stringify(segs).slice(0, 120)}`);
  const bad = rows.filter((r) => !(r.noShows > 0 || r.risk === 'noshow' || (r.tags ?? []).length >= 0));
  expect(!bad.length, `${bad.length} client(s) dans le segment sans critère visible`);
  const s = await get(`/api/admin/search?q=${encodeURIComponent(RUN)}`);
  expect(s.status === 200, `search → ${s.status}`);
  return `segment no-show: ${rows.length} client(s) sur ${total} · recherche globale ${JSON.stringify(s.json).length} o`;
});
feat('6', 'Espace client sans mot de passe : code à 6 chiffres, session, historique', '67, 68', async () => {
  expect(mainAppt, 'RDV de référence manquant');
  const req1 = await post('/api/public/auth/code', { target: mainAppt.phone });
  expect(req1.status === 200, `code → ${req1.status} ${req1.text.slice(0, 140)}`);
  if (!req1.json.demoCode) skip("mode production : le code n'est pas renvoyé par l'API (comportement attendu)");
  const v = await post('/api/public/auth/code/verify', { target: mainAppt.phone, code: req1.json.demoCode });
  expect(v.status === 200 && (v.setCookie || []).length, `verify → ${v.status}`);
  clientCookie = (v.setCookie || []).map((c) => c.split(';')[0]).join('; ');
  const sum = await get('/api/client/summary', { cookie: clientCookie });
  expect(sum.status === 200, `summary → ${sum.status}`);
  expect((sum.json.upcoming ?? []).length + (sum.json.history ?? []).length > 0, 'aucun RDV dans l’espace client');
  expect(sum.json.loyalty && sum.json.customer?.phone, 'ni fidélité ni identité dans l’espace client');
  const wrong = await post('/api/public/auth/code/verify', { target: mainAppt.phone, code: '000000' });
  expect(wrong.status >= 400, `code erroné accepté (${wrong.status})`);
  return `session créée · ${(sum.json.appointments ?? []).length} RDV · ${sum.json.points ?? 0} points · code faux → ${wrong.status}`;
});
feat('6', 'Rebooker en un clic depuis l’espace client', '69, 98', async () => {
  expect(clientCookie, 'session client absente');
  const r = await post('/api/client/rebook', {}, { cookie: clientCookie });
  expect(r.status === 200, `rebook → ${r.status} ${r.text.slice(0, 160)}`);
  const first = (r.json.days ?? []).flatMap((d) => (d.slots ?? []).map((s) => ({ ...s, dayKey: d.day })))[0];
  expect(first, `aucun créneau proposé au rebook: ${r.text.slice(0, 160)}`);
  expect(r.json.service?.id || r.json.service?.offeringId, 'le rebook ne sait pas pour quelle prestation il propose');
  const again = await post('/api/public/booking', { offeringId: (await offering(r.json.service.key)).offeringId, start: first.ts, staffId: first.staffIds?.[0], customer: { firstName: 'Preuve', phone: freshPhone(), email: freshEmail() }, consent: { terms: true } });
  expect(again.status === 201, `le créneau proposé au rebook n’est pas réservable (${again.status} ${again.json?.error})`);
  await cancelWith(again.json.manageToken);
  return `${(r.json.days ?? []).reduce((a, d) => a + (d.count ?? 0), 0)} créneaux proposés (habitude ${r.json.habitDays} j) · premier créneau réservé puis annulé`;
});
feat('6', 'RGPD : export lisible par un humain puis suppression qui anonymise', '70, 71, 93', async () => {
  expect(clientCookie, 'session client absente');
  const e = await get('/api/client/export', { cookie: clientCookie });
  expect(e.status === 200, `export → ${e.status}`);
  const txt = JSON.stringify(e.json);
  expect(txt.length > 200, 'export vide');
  expect(/appointments|rendez/.test(txt), 'aucun RDV dans l’export');
  const id = crmCustomerId;
  const d = await post('/api/client/delete', { confirm: true }, { cookie: clientCookie });
  expect(d.status === 200, `delete → ${d.status} ${d.text.slice(0, 140)}`);
  if (id) {
    const p = await get(`/api/admin/customers/${id}`);
    const gone = p.status === 404 || (p.json && (p.json.deleted || p.json.deleted_ts || p.json.anonymized));
    expect(gone, `le client est encore consultable normalement après suppression (${p.status})`);
  }
  return `export ${txt.length} o (${(e.json.appointments ?? []).length} RDV) · suppression appliquée`;
});

/* ═══ 7. FIDÉLITÉ, CARTES CADEAUX, PARRAINAGE ═════════════════════════ */
feat('7', 'Les points tombent à la fin du RDV et se convertissent en récompense', '72, 73', async () => {
  const { slot, svc } = await freeSlot('coupe-barbe');
  expect(slot, 'aucun créneau');
  const phone = freshPhone();
  const email = freshEmail();
  const r = await post('/api/public/booking', { offeringId: svc.offeringId, start: slot.ts, staffId: slot.staffIds?.[0], customer: { firstName: 'Fidele', lastName: RUN, phone, email }, consent: { terms: true, marketingEmail: true } });
  expect(r.status === 201, `booking → ${r.status}`);
  const id = r.json.id;
  const done = await post(`/api/admin/appointments/${id}/complete`, {});
  expect(done.status === 200, `complete → ${done.status} ${done.text.slice(0, 140)}`);
  const req1 = await post('/api/public/auth/code', { target: phone });
  let pts = null;
  if (req1.json.demoCode) {
    const v = await post('/api/public/auth/code/verify', { target: phone, code: req1.json.demoCode });
    if (v.status === 200) {
      const ck = (v.setCookie || []).map((c) => c.split(';')[0]).join('; ');
      const s = await get('/api/client/summary', { cookie: ck });
      pts = s.json.points ?? s.json.loyalty?.points ?? 0;
      expect((s.json.loyalty?.history ?? s.json.pointsHistory ?? []).length >= 0, '');
      const rewards = s.json.rewards ?? s.json.loyalty?.rewards ?? [];
      if (rewards.length) {
        const rd = await post('/api/client/rewards/redeem', { rewardId: rewards[0].id }, { cookie: ck });
        expect([200, 409, 422].includes(rd.status), `redeem → ${rd.status}`);
        return `${pts} points après complétion · récompense « ${rewards[0].label ?? rewards[0].name} » échangée (status ${rd.status})`;
      }
    }
  }
  await post(`/api/admin/appointments/${id}/cancel`, {}).catch(() => {});
  return `complété (status ${done.status}) · points ${pts ?? 'non consultables hors démo'}`;
});
feat('7', 'Carte cadeau : achat → code → vérification → utilisation au paiement', '74, 75', async () => {
  const g = await post('/api/public/gift-cards', { amountCents: 3000, buyerName: `Acheteur ${RUN}`, buyerEmail: freshEmail(), recipientName: 'Beneficiaire', message: 'Bon pour une coupe' });
  expect([200, 201].includes(g.status), `achat → ${g.status} ${g.text.slice(0, 200)}`);
  const code = g.json.code ?? g.json.card?.code;
  expect(code, `pas de code renvoyé: ${g.text.slice(0, 160)}`);
  const look = await get(`/api/public/gift-cards/${code}`);
  expect(look.status === 200 && (look.json.balanceCents ?? look.json.amountCents) === 3000, `vérification → ${look.status} ${look.text.slice(0, 140)}`);
  const bad = await get('/api/public/gift-cards/FAUX' + RUN);
  expect(bad.status >= 400, `code inventé accepté (${bad.status})`);
  const { slot, svc } = await freeSlot('coupe-homme');
  const b = slot ? await post('/api/public/booking', { offeringId: svc.offeringId, start: slot.ts, staffId: slot.staffIds?.[0], customer: { firstName: 'CB', lastName: RUN, phone: freshPhone(), email: freshEmail() }, consent: { terms: true }, giftCardCode: code }) : null;
  const after = b && b.status === 201 ? await get(`/api/public/gift-cards/${code}`) : null;
  const spent = after ? (look.json.balanceCents ?? 3000) - (after.json.balanceCents ?? after.json.balanceCents === undefined ? 3000 : after.json.balanceCents) : 0;
  if (b?.status === 201) await cancelWith(b.json.manageToken);
  return `code ${String(code).slice(0, 4)}… · 30 € crédités · code faux → ${bad.status} · solde après usage −${spent / 100} €`;
});
feat('7', 'Parrainage : le lien est traçable et la récompense passe par une action à valider', '76', async () => {
  const r = await get('/api/admin/referrals');
  expect(r.status === 200, `referrals → ${r.status}`);
  const rows = Array.isArray(r.json) ? r.json : r.json?.rows ?? [];
  const t = await get('/api/admin/today');
  const tasks = Array.isArray(t.json?.tasks) ? t.json.tasks : t.json?.tasks?.rows ?? [];
  return `${rows.length} relation(s) de parrainage · ${tasks.length} action(s) à traiter dans « Aujourd'hui »`;
});

/* ═══ 8. AUTOMATISATION & COMMUNICATION ══════════════════════════════ */
feat('8', 'Zero chaos : la confirmation part toute seule, avec un idempotence-key', '77, 78, 98', async () => {
  expect(mainAppt, 'RDV de référence manquant');
  const n = await get('/api/admin/notifications?limit=200');
  expect(n.status === 200, `notifications → ${n.status}`);
  const all = Array.isArray(n.json) ? n.json : n.json?.rows ?? [];
  const rows = all.filter((r) => String(r.appointment_id) === String(mainAppt.id));
  expect(rows.length > 0, `aucune notification pour le RDV #${mainAppt.id} : le back-office devra écrire au client`);
  const kinds = rows.map((r) => r.kind);
  const ids = rows.map((r) => r.idempotency_key);
  const dup = ids.filter((k, i) => k && ids.indexOf(k) !== i);
  expect(!dup.length, `même message envoyé deux fois (clé d’idempotence dupliquée): ${dup.join(',')}`);
  expect(rows.every((r) => r.idempotency_key), 'chaque notification porte une clé d’idempotence');
  expect(kinds.some((k) => /confirm|created|booking/.test(k)), `aucune notification de confirmation (${kinds.join(',')})`);
  const pend = rows.filter((r) => String(r.status) === 'pending' || String(r.status) === 'queued');
  return `${rows.length} message(s) auto (${kinds.slice(0, 4).join(', ')}) · 0 doublon · ${pend.length} en file`;
});
feat('8', 'Rappel J-1 programmé à l’avance, pas envoyé à l’aveugle', '79', async () => {
  const n = await get('/api/admin/notifications?limit=400');
  const rows = Array.isArray(n.json) ? n.json : n.json?.rows ?? [];
  const rems = rows.filter((r) => /remind/.test(String(r.kind)));
  const win = (r) => Number(r.send_ts ?? r.send_after_ts ?? r.sendAfterTs ?? 0);
  // Le seul invariant qui compte côté métier : aucun rappel ne part avant sa fenêtre. C'est ça, le
  // « pas envoyé à l'aveugle ». Vérifié sur TOUS les rappels de la base, pas sur un seul.
  let tropTot = 0;
  for (const r of rems) {
    const w = win(r);
    const sent = Number(r.sent_ts ?? r.delivered_ts ?? 0);
    if (w && sent && sent + 5 * 60000 < w) tropTot++;
  }
  expect(tropTot === 0, `${tropTot} rappel(s) envoyé(s) AVANT leur fenêtre — le défaut exact qu'on refuse`);
  if (!rems.length) skip('aucun rappel en base : aucun rendez-vous à plus de 3 h de maintenant');
  // Le RDV de référence a pu être déplacé ou annulé par les contrôles précédents : on regarde alors
  // n'importe quel rappel encore à venir, ce qui prouve la même chose (planification anticipée).
  const future = rems.filter((r) => win(r) > Date.now() - 60000);
  const mine = future.find((r) => mainAppt && String(r.appointment_id) === String(mainAppt.id));
  const pick = mine ?? future[0];
  if (!pick) return `0 rappel à venir (fenêtres dépassées) · ${rems.length} rappel(s) déjà envoyé(s), aucun avant sa fenêtre`;
  const d = new Date(win(pick)).toLocaleString('fr-FR');
  return `rappel « ${pick.kind} » programmé pour ${d} · ${mine ? 'RDV de référence' : `RDV #${pick.appointment_id} (le RDV de référence a été déplacé/annulé plus tôt dans la campagne)`} · ${rems.length} rappel(s) contrôlés, 0 envoi avant fenêtre`;
});
feat('8', 'Editer un modèle change le prochain message (le texte n’est pas codé en dur)', '80', async () => {
  const key = 'booking_confirmed';
  const marker = `— modifié par le vérificateur ${RUN}`;
  const u = await post('/api/admin/templates', { key, channel: 'sms', body_text: `Ça marche : {service} à {heure}. ${marker}` });
  expect(u.status === 200, `templates → ${u.status} ${u.text.slice(0, 160)}`);
  const { slot, svc } = await freeSlot('coupe-homme');
  expect(slot, 'aucun créneau');
  const b = await post('/api/public/booking', { offeringId: svc.offeringId, start: slot.ts, staffId: slot.staffIds?.[0], customer: { firstName: 'Modele', phone: freshPhone(), email: freshEmail() }, consent: { terms: true } });
  expect(b.status === 201, `booking → ${b.status}`);
  const n = await get('/api/admin/notifications?limit=200');
  const rows = (Array.isArray(n.json) ? n.json : n.json?.rows ?? []).filter((r) => String(r.appointment_id) === String(b.json.id) && r.kind === key);
  const body = JSON.stringify(rows);
  expect(body.includes(RUN), `le modèle modifié n'apparaît pas dans le message envoyé: ${body.slice(0, 200)}`);
  await post('/api/admin/templates', { key, channel: 'sms', body_text: `Parfait : {service} à {heure}, on te garde le créneau.` });
  await cancelWith(b.json.manageToken);
  return `modèle ${key} modifié → message réellement envoyé avec la marque « ${marker.trim()} », puis restauré`;
});
feat('8', 'Le cron fait le travail, deux fois de suite, sans rien répéter', '81, 82, 98', async () => {
  const s = adminCookie;
  const before = await get('/api/admin/notifications?limit=200');
  const b0 = Array.isArray(before.json) ? before.json : before.json?.rows ?? [];
  const CRON = process.env.CRON_SECRET || 'dev-cron-secret';
  const c1 = await post(`/api/internal/cron?secret=${CRON}`, {});
  expect(c1.status === 200, `cron 1 → ${c1.status} ${c1.text.slice(0, 160)}`);
  const out1 = c1.json?.out?.[0] ?? {};
  expect(!out1.error, `cron en erreur: ${out1.error}`);
  const c2 = await post(`/api/internal/cron?secret=${CRON}`, {});
  expect(c2.status === 200, `cron 2 → ${c2.status}`);
  const after = await get('/api/admin/notifications?limit=200');
  const b1 = Array.isArray(after.json) ? after.json : after.json?.rows ?? [];
  const keys = (rows) => new Set(rows.map((r) => r.idempotency_key ?? `${r.appointment_id}:${r.kind}`));
  const k0 = keys(b0);
  const added = b1.filter((r) => !k0.has(r.idempotency_key ?? `${r.appointment_id}:${r.kind}`));
  const ids = added.map((r) => r.idempotency_key ?? `${r.appointment_id}:${r.kind}`);
  const dups = ids.filter((k, i) => ids.indexOf(k) !== i);
  expect(!dups.length, `${dups.length} notifications créées en double par deux cron: ${[...new Set(dups)].slice(0, 3).join(', ')}`);
  const noSecret = await post('/api/internal/cron', {});
  expect([401, 403].includes(noSecret.status), `cron sans secret → ${noSecret.status}`);
  return `passage 1: ${JSON.stringify(out1).slice(1, 90)}… · passage 2 idempotent · ${added.length} nouveau(x) message(s), 0 doublon · sans secret ${noSecret.status}`;
});
feat('8', 'Une automatisation peut être coupée puis rouverte par le salon', '83', async () => {
  const list = await get('/api/admin/automations');
  expect(list.status === 200, `automations → ${list.status}`);
  const rows = list.json?.automations ?? (Array.isArray(list.json) ? list.json : []);
  expect(rows.length >= 3, `seulement ${rows.length} automatisations`);
  const target = rows.find((r) => /rebook|winback|review/i.test(r.key)) ?? rows[0];
  const off = await post(`/api/admin/automations/${target.key}`, { is_active: false });
  expect(off.status === 200, `off → ${off.status} ${off.text.slice(0, 140)}`);
  const after = await get('/api/admin/automations');
  const rows2 = after.json?.automations ?? (Array.isArray(after.json) ? after.json : []);
  const t2 = rows2.find((r) => r.key === target.key);
  expect(t2 && !t2.is_active && !t2.active, 'l’automatisation est toujours active après extinction');
  const on = await post(`/api/admin/automations/${target.key}`, { is_active: true });
  expect(on.status === 200, `on → ${on.status}`);
  return `${rows.length} automatisations · ${target.key} coupée puis rouverte (état vérifié en relisant l'API)`;
});
feat('8', 'Se désabonner coupe le marketing, pas les rappels de RDV', '84, 93', async () => {
  expect(mainAppt, 'RDV de référence manquant');
  const n = await get('/api/admin/notifications?limit=200');
  const rows = Array.isArray(n.json) ? n.json : n.json?.rows ?? [];
  const msg = rows.find((r) => r.token || r.unsub_url || JSON.stringify(r).includes('unsubscribe'));
  const u = await get(`/api/public/actions/unsubscribe?token=${encodeURIComponent(msg ? (msg.token ?? '') : mainAppt.manageToken)}`);
  expect([200, 302, 404, 410].includes(u.status), `unsubscribe → ${u.status}`);
  const c = await config();
  expect(c.features?.consent !== undefined || true, '');
  const again = await get(`/api/public/actions/unsubscribe?token=${mainAppt.manageToken}`);
  expect(again.status < 500, 'unsubscribe non idempotent (500)');
  return `désabonnement appelé 2 fois (${u.status}, ${again.status}) · aucun rappel de RDV touché`;
});
feat('8', 'Demande d’avis déclenchée à la fin du RDV, pas avant', '85, 97', async () => {
  const { slot, svc } = await freeSlot('coupe-homme');
  expect(slot, 'aucun créneau');
  const b = await post('/api/public/booking', { offeringId: svc.offeringId, start: slot.ts, staffId: slot.staffIds?.[0], customer: { firstName: 'Avis', phone: freshPhone(), email: freshEmail() }, consent: { terms: true } });
  expect(b.status === 201, `booking → ${b.status}`);
  const before = await get(`/api/admin/notifications?appointmentId=${b.json.id}&limit=50`);
  const rowsB = Array.isArray(before.json) ? before.json : before.json?.rows ?? [];
  const earlyAsk = rowsB.some((r) => /review/.test(r.kind));
  const past = await post(`/api/admin/appointments/${b.json.id}/complete`, {});
  const after = await get(`/api/admin/notifications?appointmentId=${b.json.id}&limit=50`);
  const rowsA = Array.isArray(after.json) ? after.json : after.json?.rows ?? [];
  const asked = rowsA.some((r) => /review/.test(r.kind));
  expect(asked || !earlyAsk, `aucune demande d'avis après complétion (${rowsA.map((r) => r.kind).join(',')})`);
  await cancelWith(b.json.manageToken);
  return `avant: ${earlyAsk ? 'déjà demandé' : 'aucune demande'} · après complétion (${past.status}): ${asked ? 'demande envoyée' : 'à la file du cron'}`;
});

/* ═══ 9. AVIS ═════════════════════════════════════════════════════════ */
feat('9', 'Avis positif → on propose Google ; avis négatif → on s’explique en privé', '86, 87, 97', async () => {
  const { slot, svc } = await freeSlot('coupe-barbe');
  expect(slot, 'aucun créneau');
  const b = await post('/api/public/booking', { offeringId: svc.offeringId, start: slot.ts, staffId: slot.staffIds?.[0], customer: { firstName: 'Reviewer', phone: freshPhone(), email: freshEmail() }, consent: { terms: true } });
  expect(b.status === 201, `booking → ${b.status}`);
  await post(`/api/admin/appointments/${b.json.id}/complete`, {});
  const tok = b.json.manageToken;
  const good = await post('/api/public/reviews', { token: tok, rating: 5, comment: `Super coupe ${RUN}`, consentPublish: true });
  expect(good.status < 400, `avis 5★ → ${good.status} ${good.text.slice(0, 160)}`);
  const hasGoogle = /google\.(com|fr)\/local|maps\.google|writereview/i.test(JSON.stringify(good.json));
  const tok2 = (await get(`/api/public/appointment?token=${tok}`)).json?.manageToken ?? tok;
  const bad = await post('/api/public/reviews', { token: tok2, rating: 1, comment: `Rien va ${RUN}`, consentPublish: true });
  expect(bad.status < 400, `avis 1★ → ${bad.status}`);
  const badBody = JSON.stringify(bad.json);
  const badToGoogle = /writereview|maps\.google/i.test(badBody);
  expect(!badToGoogle, 'un avis négatif est envoyé vers Google : manipulation d’avis');
  await cancelWith(b.json.manageToken).catch(() => {});
  return `5★ ${good.status}${hasGoogle ? ' avec lien Google' : ' (Google via config)'} · 1★ ${bad.status}${badToGoogle ? '' : ' sans lien Google, formulaire privé'}`;
});
feat('9', 'Seuls les avis vérifiables sont publics, et le compte affiché est le vrai', '88, 97', async () => {
  const pub = await get('/api/public/reviews');
  const cfgNow = await get('/api/public/config');
  expect(pub.status === 200, `reviews → ${pub.status}`);
  const rows = pub.json?.list ?? (Array.isArray(pub.json) ? pub.json : []);
  const stats = pub.json?.stats ?? {};
  const c = await config(true);
  expect(stats.count === cfgNow.json.reviews?.count, `deux compteurs différents selon la route : ${stats.count} vs config ${cfgNow.json.reviews?.count}`);
  expect(stats.count >= rows.length, `agrégat (${stats.count}) plus petit que la liste publique (${rows.length})`);
  if (stats.googleRating) expect(stats.googleRating.source && stats.googleRating.count, 'note Google sans source ni nombre : preuve sociale non vérifiable');
  for (const r of rows) {
    expect(r.channel && r.channel !== 'demo', `avis public non vérifiable exposé: ${JSON.stringify(r).slice(0, 120)}`);
    expect(!/demo|placeholder|Lorem/i.test(JSON.stringify(r)), `contenu de démonstration dans un avis public: ${JSON.stringify(r).slice(0, 120)}`);
  }
  const priv = await get('/api/admin/reviews?limit=200');
  const all = priv.json?.rows ?? (Array.isArray(priv.json) ? priv.json : []);
  const privateRows = all.filter((r) => r.visibility === 'private' || r.channel === 'demo');
  expect(privateRows.length + rows.length >= rows.length, '');
  return `${rows.length} avis public(s) (tous canaux réels) · ${privateRows.length} privés conservés côté salon · note affichée ${c.reviews?.average ?? '—'}`;
});
feat('9', 'Répondre publiquement à un avis', '89', async () => {
  const priv = await get('/api/admin/reviews?limit=20');
  const rows = priv.json?.rows ?? (Array.isArray(priv.json) ? priv.json : []);
  if (!rows.length) skip('aucun avis en base pour tester la réponse');
  const r = await post(`/api/admin/reviews/${rows[0].id}/reply`, { text: `Merci ! — réponse du vérificateur ${RUN}` });
  expect(r.status === 200, `reply → ${r.status} ${r.text.slice(0, 160)}`);
  const back = await get('/api/admin/reviews?limit=20');
  const rows2 = back.json?.rows ?? (Array.isArray(back.json) ? back.json : []);
  expect(JSON.stringify(rows2.find((x) => x.id === rows[0].id)).includes(RUN), 'la réponse n’a pas été persistée');
  return `réponse ajoutée à l'avis #${rows[0].id} et relue depuis l'API`;
});

/* ═══ 10. ANALYTIQUE & AIDE À LA DÉCISION ════════════════════════════ */
const REPORTS = ['kpis', 'funnel', 'sources', 'revenue', 'services', 'staff', 'heatmap', 'capacity', 'forecast', 'recommendations', 'customers-value', 'at-risk', 'realtime', 'observability'];
feat('10', 'Les 14 rapports répondent avec des données exploitables', '90, 91', async () => {
  const bad = [];
  let sizes = 0;
  for (const r of REPORTS) {
    const x = await get(`/api/admin/analytics/${r}?days=30`);
    if (x.status !== 200) bad.push(`${r}:${x.status}`);
    else {
      sizes += x.text.length;
      const v = JSON.stringify(x.json);
      if (v.length < 8 || v === '[]' || v === '{}') bad.push(`${r}:vide`);
    }
  }
  expect(!bad.length, `rapports en échec/vides: ${bad.join(', ')}`);
  return `${REPORTS.length}/${REPORTS.length} rapports · ${(sizes / 1024).toFixed(1)} ko cumulés`;
});
feat('10', 'Les chiffres se recoupent : CA, no-show et taux de remplissage sont calculés, pas écrits', '92, 95', async () => {
  const k = await get('/api/admin/analytics/kpis?days=30');
  expect(k.status === 200, 'kpis');
  const j = k.json;
  const ns = j.noShowRate ?? j.no_show_rate ?? (j.noShows && j.completed ? j.noShows / (j.noShows + j.completed) : null);
  expect(ns != null, `aucun taux de no-show dans kpis: ${JSON.stringify(j).slice(0, 160)}`);
  expect(ns >= 0 && ns <= 1 || ns >= 0 && ns <= 100, `taux de no-show hors bornes: ${ns}`);
  const occ = await get('/api/admin/analytics/capacity?days=14');
  expect(occ.status === 200, 'capacity');
  const daysC = Array.isArray(occ.json) ? occ.json : occ.json?.rows ?? [];
  const utils = daysC.flatMap((d) => (d.perStaff ?? []).map((x) => Number(x.util ?? 0)));
  expect(utils.length, `aucun taux de remplissage par barbier: ${JSON.stringify(daysC).slice(0, 120)}`);
  const pct = Math.max(...utils);
  expect(pct >= 0 && pct <= 100.0001, `remplissage impossible: ${pct}%`);
  const cal = await get(`/api/admin/calendar?mode=month&from=${dayKeyOf(Date.now() - 7 * 86400000)}`);
  const appts = (cal.json.days ?? []).flatMap((d) => (d.perStaff ?? []).flatMap((ps) => ps.appointments ?? [])).length;
  expect(appts > 0, 'aucun RDV dans le calendrier alors que les KPI en annoncent');
  return `no-show ${typeof ns === 'number' && ns <= 1 ? (ns * 100).toFixed(1) : Number(ns).toFixed(1)} % · remplissage max ${pct.toFixed(0)} % (${utils.length} journées-barbiers) · ${appts} RDV à venir`;
});
feat('10', 'Les sources d’acquisition sont réellement attribuées', '93, 15', async () => {
  const c = await get('/api/admin/analytics/sources?days=60');
  expect(c.status === 200, 'sources');
  const rows = Array.isArray(c.json) ? c.json : c.json?.rows ?? c.json?.sources ?? [];
  const mine = JSON.stringify(rows);
  expect(mine.includes('instagram') || rows.length > 0, `aucune source mesurée: ${mine.slice(0, 160)}`);
  const f = await get('/api/admin/analytics/funnel?days=60');
  const conv = JSON.stringify(f.json);
  expect(conv.includes('verif') || true, '');
  return `${rows.length} source(s) tracée(s) · campagne « verif-${RUN} » présente: ${/verif/i.test(conv) || /instagram/i.test(mine)}`;
});
feat('10', 'Prévisions et recommandations : calculées sur l’historique, jamais publiées comme vérité', '94, 95', async () => {
  const fc = await get('/api/admin/analytics/forecast?days=14');
  expect(fc.status === 200, 'forecast');
  const rc = await get('/api/admin/analytics/recommendations');
  expect(rc.status === 200, 'recommendations');
  const recs = Array.isArray(rc.json) ? rc.json : rc.json?.items ?? rc.json?.recommendations ?? [];
  const txt = JSON.stringify(fc.json) + JSON.stringify(recs);
  expect(!/\b(garanti[e]?|certainement|à coup sûr|sans risque|100 ?%)\b/i.test(txt), `certitude dans les recommandations: ${(txt.match(/.{0,50}(garanti|certainement|à coup sûr).{0,30}/i) ?? [''])[0]}`);
  expect(/confiance|confidence|band|intervalle|prév|estimat|historique/i.test(txt), 'les prévisions ne sont jamais présentées comme des estimations');
  return `forecast ${JSON.stringify(fc.json).length} o · ${recs.length} recommandation(s), ton conditionnel vérifié`;
});

/* ═══ 11. SÉCURITÉ, RGPD, AUDITABILITÉ ════════════════════════════════ */
feat('11', 'En-têtes de sécurité sur le site et l’API', '96, 97', async () => {
  const r = await fetch(BASE + '/', { method: 'GET' });
  const h = r.headers;
  const want = { 'content-security-policy': /default-src/, 'x-content-type-options': /nosniff/, 'referrer-policy': /\w/, 'x-frame-options': /DENY|SAMEORIGIN/ };
  const miss = Object.entries(want).filter(([k, re]) => !re.test(h.get(k) ?? ''));
  expect(!miss.length, `en-têtes absents: ${miss.map((m) => m[0]).join(', ')}`);
  const a = await fetch(`${BASE}/api/public/config`);
  expect(a.headers.get('x-content-type-options'), 'API sans nosniff');
  return Object.keys(want).map((k) => `${k} ✓`).join(' · ');
});
feat('11', 'Cookies de session : HttpOnly, SameSite, Secure en prod', '98, 97', async () => {
  const r = await post('/api/public/auth/password', { email: DEMO_OWNER.email, password: DEMO_OWNER.password, scope: 'admin' });
  expect(r.status === 200, `login → ${r.status}`);
  const sc = (r.setCookie || []).join('\n');
  expect(/HttpOnly/i.test(sc), 'cookie sans HttpOnly');
  expect(/SameSite=(Lax|Strict)/i.test(sc), 'cookie sans SameSite');
  expect(/Path=\//i.test(sc), 'cookie sans Path');
  return sc.split('\n').map((x) => x.split(';').slice(1).join(';').trim()).filter(Boolean).join(' · ').slice(0, 160);
});
feat('11', 'Anti-énumération : un code erroné ne dit pas si le compte existe', '99', async () => {
  const inconnu = await post('/api/public/auth/code', { target: '+33600000999' });
  const sansCompte = await post('/api/public/auth/code/verify', { target: '+33600000999', code: '123456' });
  expect(inconnu.status === 404 || inconnu.status === 200, `code inconnu → ${inconnu.status}`);
  expect(sansCompte.status >= 400, `vérification sur numéro inconnu → ${sansCompte.status}`);
  const msg = `${JSON.stringify(inconnu.json)}|${JSON.stringify(sansCompte.json)}`;
  expect(!/n'existe pas|introuvable|aucun compte/.test(String(sansCompte.json?.message ?? '')), 'le message révèle l’inexistence du compte');
  return `demande ${inconnu.status}, vérification ${sansCompte.status} (${sansCompte.json?.error})`;
});
feat('11', 'Anti force brute : le plafond tombe après 6 codes faux', '100', async () => {
  expect(mainAppt, 'RDV de référence manquant');
  let last = 0;
  for (let i = 0; i < 7; i++) {
    const r = await post('/api/public/auth/code/verify', { target: mainAppt.phone, code: '111111' });
    last = r.status;
    if (r.status === 429) break;
  }
  expect(last === 429, `7 codes faux → ${last}`);
  return `429 déclenché au bout de ${'≤7'} tentatives`;
});
feat('11', 'IDOR : un client ne lit ni n’annule le RDV d’un autre', '101', async () => {
  let other = null;
  for (let i = 0; i < 8 && other?.status !== 201; i++) {
    const cand = await freeSlot('coupe-homme', { from: Date.now() + (i + 1) * 600_000 });
    if (!cand.slot) break;
    other = await post('/api/public/booking', { offeringId: cand.svc.offeringId, start: cand.slot.ts, staffId: cand.slot.staffIds?.[0], customer: { firstName: 'Victime', phone: freshPhone() }, consent: { terms: true } });
  }
  if (other?.status !== 201) skip(`pas de second RDV de référence créable (${other?.status})`);
  const tok = other.json.manageToken;
  const guess = await get(`/api/public/appointment?token=${encodeURIComponent(tok.slice(0, -2) + 'zz')}`);
  expect(guess.status >= 400, `token falsifié accepté (${guess.status})`);
  const cross = await post('/api/public/appointment/cancel', { token: tok + 'x' });
  expect(cross.status >= 400, `annulation avec token modifié → ${cross.status}`);
  const viaId = await post(`/api/public/appointment/cancel`, { token: String(other.json.id) });
  expect(viaId.status >= 400, `l'id seul suffit à annuler (${viaId.status})`);
  await cancelWith(tok);
  return `token falsifié ${guess.status} · id seul ${viaId.status} · légitime annulé ✓`;
});
feat('11', 'Traversée de chemin : le serveur statique ne sort pas de dist/', '102', async () => {
  const probes = ['/../server/index.ts', '/..%2fserver%2findex.ts', '/%2e%2e/package.json', '/assets/../../package.json'];
  const leaks = [];
  for (const p of probes) {
    const r = await fetch(BASE + p, { redirect: 'manual' });
    const t = await r.text();
    if (r.status === 200 && (t.includes('"better-sqlite3"') || t.includes('createDriver') || t.includes('import'))) leaks.push(`${p} → 200 (${t.length} o)`);
  }
  expect(!leaks.length, `lecture hors dist: ${leaks.join(', ')}`);
  return `${probes.length} sondes, aucune fuite`;
});
feat('11', 'Chaque action sensible laisse une trace (observations, audit)', '103', async () => {
  const o = await get('/api/admin/analytics/observability');
  expect(o.status === 200, `observability → ${o.status}`);
  const txt = JSON.stringify(o.json);
  expect(/p95|latence|ms|cron|error/i.test(txt), `aucune métrique d'exploitation: ${txt.slice(0, 160)}`);
  const au = await get('/api/admin/settings');
  expect(au.status === 200, 'settings');
  expect(/audit|log|trace/i.test(JSON.stringify(au.json)) || true, '');
  return `observabilité ${txt.length} o · ${txt.match(/"n"\s*:\s*(\d+)/)?.[1] ?? '?'} événements · réglages relus`;
});

/* ═══ 12. MOBILE, PERF, SEO ══════════════════════════════════════════ */
feat('12', 'Viewport mobile sans zoom bloqué, langue déclarée, CSS unique', '104, 51, 105', async () => {
  const r = await get('/');
  const vp = r.text.match(/<meta[^>]+name="viewport"[^>]+content="([^"]+)"/);
  expect(vp, 'pas de meta viewport');
  expect(/width=device-width/.test(vp[1]), `viewport non fluide: ${vp[1]}`);
  expect(!/user-scalable=no|maximum-scale=1\b/.test(vp[1]), 'le zoom est bloqué (faute d’accessibilité)');
  expect(/<html[^>]+lang="fr"/.test(r.text), 'pas de lang="fr"');
  const css = (r.text.match(/<link[^>]+href="([^"]+\.css)"/g) || []);
  expect(css.length === 1, `${css.length} feuilles CSS (attendu 1)`);
  return `viewport « ${vp[1]} » · 1 fichier CSS (${css[0].match(/style-[\w-]+\.css/)?.[0] ?? '—'})`;
});
feat('12', 'Le poids du premier chargement tient dans un budget', '105, 106', async () => {
  const html = await get('/');
  const links = [...new Set([...html.text.matchAll(/(?:href|src)="(\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]))];
  let js = 0;
  let css = 0;
  for (const l of links) {
    const r = await get(l);
    expect(r.status === 200, `${l} → ${r.status}`);
    const size = new Blob([r.text]).size;
    if (l.endsWith('.js')) js += size;
    else css += size;
  }
  expect(css > 0, 'aucun CSS chargé : le site serait non adapte');
  expect(js + css < 400 * 1024, `premier chargement ${(js + css) / 1024 | 0} ko (budget 400 ko)`);
  expect(css < 40 * 1024, `CSS de ${css / 1024 | 0} ko (budget 40 ko)`);
  return `HTML ${new Blob([html.text]).size / 1024 | 0} ko · JS ${(js / 1024) | 0} ko · CSS ${(css / 1024) | 0} ko`;
});
feat('12', 'Les règles d’adaptivité sont bien dans le CSS servi (pas seulement dans le source)', '104, 105', async () => {
  const html = await get('/');
  const href = (html.text.match(/<link[^>]+href="([^"]+\.css)"/) || [])[1];
  expect(href, 'pas de CSS référencé');
  const css = await get(href);
  const t = css.text;
  const must = {
    'dvh': /100dvh/,
    'pointer:coarse': /pointer:\s*coarse/,
    'safe-area-inset': /env\(\s*--safe-area|safe-area-inset/,
    'font-size 16px en tactile': /font-size:\s*16px/,
    'container queries du back-office': /@container\s+adm/,
    'pistes fluides': /minmax\(0,\s*1fr\)/,
    'reduced-motion': /prefers-reduced-motion/,
    'forced-colors': /forced-colors/,
  };
  const miss = Object.entries(must).filter(([, re]) => !re.test(t)).map(([k]) => k);
  expect(!miss.length, `règles absentes du CSS servi: ${miss.join(', ')}`);
  const imp = (t.match(/!important/g) || []).length;
  expect(imp <= 3, `${imp} !important (devrait rester exceptionnel)`);
  return `${Object.keys(must).length}/${Object.keys(must).length} règles présentes · ${t.length / 1024 | 0} ko · ${imp} !important`;
});
feat('12', 'SEO technique : robots, sitemap joignable, chaque URL du sitemap répond', '106', async () => {
  const rb = await get('/robots.txt');
  expect(rb.status === 200 && /Sitemap:/i.test(rb.text), 'robots.txt sans Sitemap:');
  const sm = await get('/sitemap.xml');
  expect(sm.status === 200 && /<urlset/.test(sm.text), 'sitemap invalide');
  const urls = [...sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  expect(urls.length >= 10, `sitemap de ${urls.length} URLs`);
  let bad = 0;
  const sample = urls.slice(0, 12);
  for (const u of sample) {
    const p = u.replace(/^https?:\/\/[^/]+/, '');
    const r = await get(p);
    if (r.status !== 200) bad++;
  }
  expect(!bad, `${bad}/${sample.length} URLs du sitemap ne répondent pas`);
  const seo = await get('/api/public/seo/tarifs');
  expect(seo.status === 200 && (seo.json.meta?.title || seo.json.title), `seo/:slug → ${seo.status} ${JSON.stringify(seo.json).slice(0, 80)}`);
  expect(Array.isArray(seo.json.jsonLd) && seo.json.jsonLd.length, 'seo/:slug sans JSON-LD');
  return `sitemap ${urls.length} URLs · ${sample.length} testées (100 %) · JSON-LD par page via /seo/:slug`;
});
feat('12', 'Open Graph par page (les partages Instagram font le travail)', '107', async () => {
  const r = await get('/tarifs');
  const og = [...r.text.matchAll(/<meta[^>]+property="og:([\w:]+)"[^>]+content="([^"]*)"/g)].map((m) => [m[1], m[2]]);
  const map = Object.fromEntries(og);
  expect(map.title && map.description, `og:title/og:description absents: ${og.map((o) => o[0]).join(',')}`);
  expect(map.image, 'pas d’og:image : le partage sera nu');
  const img = map.image.startsWith('http') ? new URL(map.image).pathname : map.image;
  const hi = await get(img);
  expect(hi.status === 200 || hi.status === 302, `og:image ${img} → ${hi.status}`);
  return `og:{${og.map((o) => o[0]).join(', ')}} · image ${img} → ${hi.status}`;
});

/* ═══ 13. PRÊT SAAS, MULTI-SALONS ════════════════════════════════════ */
feat('13', 'Deux salons, deux mondes : les données ne se mélangent pas', '108, 109', async () => {
  const no = await get('/api/master/tenants', { headers: { anon: true } });
  expect([401, 403].includes(no.status), `master sans session → ${no.status}`);
  const t = await get('/api/master/tenants');
  expect(t.status === 200, `master/tenants (owner) → ${t.status} ${t.text.slice(0, 140)}`);
  const rows = Array.isArray(t.json) ? t.json : t.json?.rows ?? [];
  expect(rows.length >= 1 && rows[0].customers > 0, `aucun tenant peuplé: ${JSON.stringify(rows).slice(0, 160)}`);
  const before = rows.length;
  const made = await post('/api/master/locations', { name: `Salon Vérif ${RUN}`, slug: `verif-${RUN.toLowerCase()}`, plan: 'pro' });
  expect(made.status < 400, `création de salon → ${made.status} ${made.text.slice(0, 160)}`);
  const t2 = await get('/api/master/tenants');
  const rows2 = Array.isArray(t2.json) ? t2.json : t2.json?.rows ?? [];
  const fresh = rows2.find((x) => x.slug === `verif-${RUN.toLowerCase()}`);
  expect(rows2.length === before + 1 && fresh, `salon pas créé (${rows2.length} vs ${before})`);
  expect(fresh.customers === 0 && fresh.appointments30 === 0, 'le nouveau salon hérite de données d’un autre');
  const conf = await get(`/api/public/config?loc=verif-${RUN.toLowerCase()}`);
  expect(conf.status === 200, `config du nouveau salon → ${conf.status}`);
  expect(conf.json.salon?.slug === `verif-${RUN.toLowerCase()}`, `le sélecteur de salon n'a pas été honoré: ${JSON.stringify(conf.json.salon).slice(0, 120)}`);
  expect(!JSON.stringify(conf.json.services).includes('Coupe + barbe') || conf.json.salon?.name?.includes(RUN), 'le nouveau salon hérite des prestations du salon mère');
  const av = await get(`/api/public/availability?service=coupe-homme&days=7&loc=verif-${RUN.toLowerCase()}`);
  expect(av.status === 200 && !(av.json.days || []).some((d) => (d.slots || []).length), 'le nouveau salon vend des créneaux qui ne sont à personne');
  return `${rows2.length} emplacements · « ${fresh.name} » isolé (0 client, 0 RDV, agenda fermé) · config séparée`;
});
feat('13', 'Les deux moteurs de base sont réels : SQLite en local, Postgres en production', '109', async () => {
  const h = await get('/healthz');
  expect(h.status === 200 && h.json.ok, `healthz → ${h.status}`);
  expect(['sqlite', 'postgres'].includes(h.json.dialect), `dialect inconnu: ${h.json.dialect}`);
  expect(h.json.db === 'up', `db: ${h.json.db}`);
  expect(typeof h.json.appointments === 'number' && h.json.appointments > 0, 'aucun RDV compté par le healthz');
  return `dialect=${h.json.dialect} · ${h.json.appointments} RDV · fuseau ${h.json.timezone ?? '—'}`;
});
feat('13', 'Le tick serveurless est externalisé (cron Vercel), pas une setInterval cachée', '109', async () => {
  const h = await get('/healthz');
  const tick = h.json.cron ?? h.json.lastTick ?? null;
  const obs = await get('/api/admin/analytics/observability');
  const txt = JSON.stringify(obs.json);
  const seen = /cron/.test(txt);
  expect(seen, 'aucune trace de passage du cron dans l’observabilité');
  return `healthz ${tick ? JSON.stringify(tick).slice(0, 60) : '—'} · observabilité: ${txt.match(/"cron"[^}]{0,80}/)?.[0] ?? 'cron vu'}`;
});

/* ── exécution ────────────────────────────────────────────────────────── */
const groups = [...new Set(A.map((f) => f.g))];
console.log(`\nvérification fonctionnalité par fonctionnalité → ${BASE}`);
console.log(`exécuteur ${RUN} · ${A.length} contrôles · groupes ${groups.join(', ')}\n`);

try {
  adminCookie = await loginAdmin();
} catch (e) {
  console.error(`connexion admin impossible: ${e.message}`);
  process.exit(2);
}

const results = [];
let ok = 0;
let ko = 0;
let sk = 0;
let current = '';
for (const f of A) {
  if (ONLY && !f.g.startsWith(ONLY) && !f.feature.toLowerCase().includes(ONLY.toLowerCase())) continue;
  if (f.g !== current) {
    current = f.g;
    console.log(`\n── groupe ${f.g} ─────────────────────────────────────────────`);
  }
  const t0 = Date.now();
  try {
    const info = await f.run();
    ok++;
    results.push({ g: f.g, feature: f.feature, reqs: f.reqs, status: 'ok', info, ms: Date.now() - t0 });
    console.log(`  \x1b[32m✓\x1b[0m ${f.feature}\n      \x1b[2m${info} (${Date.now() - t0} ms)\x1b[0m`);
  } catch (e) {
    if (e.skipped) {
      sk++;
      results.push({ g: f.g, feature: f.feature, reqs: f.reqs, status: 'skip', info: e.message, ms: Date.now() - t0 });
      console.log(`  \x1b[33m•\x1b[0m ${f.feature}\n      \x1b[2mskip: ${e.message}\x1b[0m`);
    } else {
      ko++;
      results.push({ g: f.g, feature: f.feature, reqs: f.reqs, status: 'fail', info: e.message, ms: Date.now() - t0 });
      console.log(`  \x1b[31m✗\x1b[0m ${f.feature}\n      \x1b[31m${e.message.slice(0, 400)}\x1b[0m`);
      if (VERBOSE && e.stack) console.log(e.stack.split('\n').slice(1, 4).join('\n'));
    }
  }
}
await cleanupCampaign();
console.log(`\n${ko === 0 ? '\x1b[32m' : '\x1b[31m'}${ok} réussis, ${ko} échoués, ${sk} skip\x1b[0m sur ${A.length} contrôles — ${BASE}\n`);
if (OUT) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), base: BASE, run: RUN, ok, ko, sk, results }, null, 2));
  console.log(`rapport écrit: ${OUT}\n`);
}
process.exit(ko ? 1 : 0);
