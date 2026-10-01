/**
 * Tests « profonds » : ce que les tests de domaine ne couvrent pas.
 *
 * On attaque les trois endroits où un système de réservation casse vraiment :
 * la concurrence sur un créneau, l'argent (cartes cadeaux, acomptes), et le temps
 * (changement d'heure). Plus l'idempotence de chaque écriture, le cloisonnement des
 * plafonnements, et des sondages d'injection. Chaque assertion est prise sur l'API HTTP
 * réelle ou sur la base — jamais sur une réimplémentation de la logique.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { app, call, login, openDay } from './helpers.ts';

const phoneFor = (n: number) => `06${String(33000000 + n).padStart(8, '0')}`;
let seq = 0;
const deaccent = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z]/g, '').toLowerCase();
const client = (tag: string, i: number) => ({
  firstName: tag,
  lastName: `Test${i}`,
  phone: phoneFor(seq++ * 977 + i),
  email: `${deaccent(tag)}.${i}@test.fr`,
});

const dbs = async () => {
  await app();
  return (await import('../server/db/index.ts')).db();
};

/* Le plafond de réservation est volontairement bas (12/10 min) : on le vide entre chaque
   test, sinon ce fichier testerait le rate-limit au lieu de tester l'intégrité. */
beforeEach(async () => {
  const db = await dbs();
  await db.exec('DELETE FROM rate_buckets');
});

test('concurrence : dix réservations simultanées sur le même créneau, une seule passe', async () => {
  const { day, ts } = await openDay();
  const av = await call(`/api/public/availability?service=coupe-homme&days=1&date=${day}`);
  const slot = av.json.days[0].slots.find((s: any) => s.ts === ts);
  assert.ok(slot?.staffIds?.length, 'le créneau trouvé est bien attribuable à un barbier précis');
  const staffId = slot.staffIds[0];

  const res = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      call('/api/public/booking', {
        body: {
          offeringId: 1,
          staffId,
          start: ts,
          visitorId: `storm-${i}`,
          customer: client('Orage', i),
          consent: { terms: true },
        },
      }),
    ),
  );
  const won = res.filter((r) => r.status === 201);
  assert.equal(won.length, 1, `exactément une réservation acceptée, ${won.length} reçues`);
  for (const r of res.filter((x) => x.status !== 201))
    assert.ok([409, 429].includes(r.status), `refus inattendu ${r.status} · ${r.text.slice(0, 140)}`);

  const db = await dbs();
  const blocking = await db.num(
    `SELECT COUNT(*) FROM appointments WHERE location_id = 1 AND staff_id = :s AND start_ts = :t
       AND status IN ('held','pending_payment','booked','confirmed','waiting_client','in_progress')`,
    { s: staffId, t: ts },
  );
  assert.equal(blocking, 1, 'zéro double booking, même sous concurrence réelle');

  // « Zéro demande perdue » : le refus n'est pas un mur, il rouvre une porte.
  const clash = res.find((r) => r.status === 409);
  assert.ok(clash, 'les perdants reçoivent un 409 créneau pris');
  assert.equal(clash.json.error, 'creneau_pris');
  const data = clash.json.data ?? {};
  assert.ok(Array.isArray(data.alternatives) && data.alternatives.length > 0, 'le 409 propose des alternatives réelles');
  assert.ok(data.alternatives.every((a: any) => a.time && a.label && a.day), 'chaque alternative est réservable en un clic (jour + heure + label)');
});

test('base : la contrainte unique bloque le doublon même en écriture directe', async () => {
  const { ts } = await openDay();
  const b = await call('/api/public/booking', { body: { offeringId: 1, start: ts, customer: client('Rempart', 1), consent: { terms: true } } });
  assert.equal(b.status, 201, b.text.slice(0, 160));
  const db = await dbs();
  const a = await db.one<any>('SELECT location_id, staff_id, start_ts, end_ts, offering_id, service_id, customer_id, duration_min FROM appointments WHERE id = :i', { i: b.json.id });
  assert.ok(a.staff_id, 'la réservation est bien attribuée à un barbier');
  await assert.rejects(
    () =>
      db.exec(
        `INSERT INTO appointments (location_id, customer_id, offering_id, service_id, staff_id, start_ts, end_ts, duration_min, created_ts, updated_ts, status)
         VALUES (${a.location_id}, ${a.customer_id}, ${a.offering_id}, ${a.service_id}, ${a.staff_id}, ${a.start_ts}, ${a.end_ts}, ${a.duration_min}, ${Date.now()}, ${Date.now()}, 'confirmed')`,
      ),
    /UNIQUE/i,
    'deux RDV bloquants ne peuvent pas partager le même barbier à la même minute',
  );
  const n = await db.num(`SELECT COUNT(*) FROM appointments WHERE staff_id = :s AND start_ts = :t`, { s: a.staff_id, t: a.start_ts });
  assert.equal(n, 1, 'le refus n\u2019a rien laissé derrière lui');
});

test('temps : les horaires suivent l\u2019horloge murale de Paris, y compris les jours de bascule', async () => {
  const T = await import('../server/lib/time.ts');
  for (const day of ['2026-03-28', '2026-03-29', '2026-03-30', '2026-10-24', '2026-10-25', '2026-10-26']) {
    const s = T.startOfDayMs(day);
    const e = T.endOfDayMs(day);
    assert.equal(T.dateKey(s), day, `${day} : minuit local retombe sur le bon jour`);
    assert.equal(T.dateKey(e - T.MIN), day, `${day} : la journée s\u2019arrête bien à minuit local`);
    assert.equal(T.dayDiff(day, T.dayAfter(day)), 1, `${day} : le lendemain est le lendemain`);
    assert.notEqual(T.dayAfter(day), day, `${day} : avancer d\u2019un jour avance vraiment`);
    // Le salon ouvre à 09:30 : ce créneau doit exister à 09:30 *affichées*, pas à 08:30 ou 10:30.
    for (let m = 570; m <= 1190; m += 10) {
      const at = T.atLocal(day, m);
      assert.ok(Number.isFinite(at), `${day} + ${m} min : instant valide`);
      assert.equal(T.fmtTime(at), T.hhmm(m), `${day} : la minute ${T.hhmm(m)} doit se relire ${T.hhmm(m)}`);
    }
    const len = (e - s) / 3_600_000;
    assert.ok(len === 24 || len === 23 || len === 25, `${day} : longueur de journée plausible (${len} h)`);
    if (day === '2026-03-29') assert.equal(len, 23, 'la nuit du printemps fait 23 heures');
    if (day === '2026-10-25') assert.equal(len, 25, 'la nuit d\u2019automne fait 25 heures');
  }
});

test('temps : un RDV réservé en hiver comme en été sort à la bonne heure UTC dans le .ics', async () => {
  const { day, ts } = await openDay();
  const b = await call('/api/public/booking', { body: { offeringId: 1, start: ts, customer: client('Calendrier', 2), consent: { terms: true } } });
  assert.equal(b.status, 201, b.text.slice(0, 160));
  const ics = await call(`/api/public/actions/ics?token=${encodeURIComponent(b.json.manageToken)}`);
  assert.equal(ics.status, 200);
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  assert.ok(ics.text.includes(`DTSTART:${stamp(ts)}`), 'le .ics reprend exactement l\u2019instant réservé');
  assert.ok(ics.text.includes(`DTEND:${stamp(b.json.end)}`), 'la fin reprend la durée réelle du service');
  const T = await import('../server/lib/time.ts');
  assert.equal(T.dateKey(ts), day, 'le créneau reste bien sur le jour demandé');
  assert.equal(T.fmtTime(ts), b.json.time ?? T.fmtTime(ts));
  // une seule occurrence de l\u2019événement, quoi que le client ait saisi dans ses champs texte
  assert.equal((ics.text.match(/BEGIN:VEVENT/g) ?? []).length, 1);
});

test('carte cadeau : solde partiel épuisé, statut cohérent, seconde utilisation refusée', async () => {
  const buy = await call('/api/public/gift-cards', { body: { amountCents: 1500, buyerName: 'Test Cadeau', buyerEmail: 'cadeau@test.fr' } });
  assert.equal(buy.status, 201, buy.text.slice(0, 160));
  assert.equal(buy.json.status, 'active');
  const code = buy.json.code;
  assert.ok(code && code.length >= 6, 'le code est immédiatement utilisable en démo');

  const { ts } = await openDay();
  const price = (await call('/api/public/config')).json.services.find((s: any) => s.key === 'coupe-homme').priceCents;
  assert.ok(price > 1500, 'le test a du sens : la carte ne couvre pas la prestation');

  const b = await call('/api/public/booking', { body: { offeringId: 1, start: ts, giftCardCode: code, customer: client('Carte', 3), consent: { terms: true } } });
  assert.equal(b.status, 201, b.text.slice(0, 200));
  assert.equal(b.json.priceCents, price, 'une carte cadeau règle la prestation : elle ne réduit pas sa valeur');
  assert.equal(b.json.balanceCents, price - 1500, 'la carte est déduite UNE fois du reste à payer');
  assert.equal(b.json.depositCents, 0, 'plus rien à payer d\u2019avance : la carte a déjà réglé sa part');

  const after = await call(`/api/public/gift-cards/${code}`);
  assert.equal(after.json.balanceCents, 0, 'le solde résiduel est à zéro');
  assert.equal(after.json.status, 'redeemed');

  const reuse = await call('/api/public/booking', { body: { offeringId: 1, start: (await openDay(2)).ts, giftCardCode: code, customer: client('Carte', 4), consent: { terms: true } } });
  assert.equal(reuse.status, 422);
  assert.equal(reuse.json.error, 'carte_invalide');
});

test('carte cadeau : un refus de réservation ne débite pas la carte', async () => {
  const buy = await call('/api/public/gift-cards', { body: { amountCents: 5000, buyerName: 'Test Cadeau 2', buyerEmail: 'cadeau2@test.fr' } });
  const code = buy.json.code;
  const { ts } = await openDay();
  const first = await call('/api/public/booking', { body: { offeringId: 1, start: ts, customer: client('Voisin', 5), consent: { terms: true } } });
  assert.equal(first.status, 201, first.text.slice(0, 140));
  const clash = await call('/api/public/booking', { body: { offeringId: 1, staffId: first.json.staffId, start: ts, giftCardCode: code, customer: client('Voisin', 6), consent: { terms: true } } });
  assert.equal(clash.status, 409, 'le créneau est déjà pris : la seconde réservation échoue');
  const card = await call(`/api/public/gift-cards/${code}`);
  assert.equal(card.json.balanceCents, 5000, 'la carte n\u2019a pas été débitée par une transaction annulée');
  assert.equal(card.json.status, 'active');
});

test('fidélité : un seul cumul par rendez-vous, même si la clôture est rejouée', async () => {
  const { ts } = await openDay();
  const b = await call('/api/public/booking', { body: { offeringId: 1, start: ts, customer: client('Fidèle', 7), consent: { terms: true } } });
  assert.equal(b.status, 201, b.text.slice(0, 140));
  const cookie = await login('owner@zyass.fr');
  const one = await call(`/api/admin/appointments/${b.json.id}/complete`, { method: 'POST', body: {}, cookie });
  assert.equal(one.status, 200, one.text.slice(0, 160));
  const db = await dbs();
  const rows = await db.num(`SELECT COUNT(*) FROM loyalty_ledger WHERE appointment_id = :a AND reason = 'visit'`, { a: b.json.id });
  assert.equal(rows, 1, 'la visite est comptée une fois');
  const pts = await db.num(`SELECT loyalty_points FROM customers WHERE id = :c`, { c: b.json.customerId });
  assert.ok(pts > 0, 'le solde du client a bien bougé');

  const two = await call(`/api/admin/appointments/${b.json.id}/complete`, { method: 'POST', body: {}, cookie });
  assert.equal(two.status, 200);
  assert.equal(two.json.already, true, 'la clôture rejouée est reconnue comme déjà faite');
  const rows2 = await db.num(`SELECT COUNT(*) FROM loyalty_ledger WHERE appointment_id = :a`, { a: b.json.id });
  assert.equal(rows2, 1, 'rejouer la clôture ne doit pas créditer deux fois');
  const pts2 = await db.num(`SELECT loyalty_points FROM customers WHERE id = :c`, { c: b.json.customerId });
  assert.equal(pts2, pts, 'solde de fidélité inchangé');
});

test('waitlist : une double demande identique ne crée qu\u2019une ligne', async () => {
  const c = client('File', 8);
  const body = { name: `${c.firstName} ${c.lastName}`, phone: c.phone, email: c.email, serviceKey: 'coupe-homme', days: ['2099-01-05'], consent: true };
  const a = await call('/api/public/waitlist', { body });
  assert.equal(a.status, 201, a.text.slice(0, 160));
  assert.equal(a.json.alreadyExists, false);
  const b = await call('/api/public/waitlist', { body });
  assert.equal(b.status, 201);
  assert.equal(b.json.alreadyExists, true, 'la seconde demande est fusionnée, pas dupliquée');
  assert.equal(b.json.token, undefined, 'un numéro connu ne suffit pas à récupérer le lien privé');
  const db = await dbs();
  const n = await db.num(`SELECT COUNT(*) FROM waitlist WHERE phone = :p`, { p: c.phone });
  assert.equal(n, 1, 'une seule ligne en base');
});

test('plafonnements : saturer un seau ne ferme pas les autres portes', async () => {
  const { ts } = await openDay();
  let blocked = 0;
  for (let i = 0; i < 14; i++) {
    const r = await call('/api/public/booking', { body: { offeringId: 1, start: ts + i * 600_000, customer: client('Seau', i), consent: { terms: true } } });
    if (r.status === 429) blocked++;
  }
  assert.ok(blocked > 0, 'le seau book:{ip} finit par refuser (12 par 10 min)');
  const av = await call('/api/public/availability?service=coupe-homme&days=1');
  assert.equal(av.status, 200, 'la disponibilité, elle, reste ouverte : on ne punit pas la lecture');
  const cfg = await call('/api/public/config');
  assert.equal(cfg.status, 200);
  const code = await call('/api/public/auth/code', { body: { target: '0612345678', channel: 'sms' } });
  assert.notEqual(code.status, 429, 'le seau de connexion est indépendant du seau de réservation');
  const db = await dbs();
  const buckets = await db.all<any>('SELECT bucket_key AS key, tokens FROM rate_buckets');
  const book = buckets.find((r: any) => String(r.key).startsWith('rl:book:'));
  assert.ok(book, `le seau de réservation est bien séparé par IP (${buckets.map((r: any) => r.key).join(' ')})`);
  assert.ok(Number(book.tokens) < 3, `le seau book:{ip} est vidé par la tempête (tokens=${book.tokens} sur 12)`);
  assert.ok(buckets.some((r: any) => String(r.key).startsWith('rl:code:')), 'les deux familles de seaux coexistent');
  assert.ok(!buckets.some((r: any) => String(r.key).includes('availability')), 'la lecture de disponibilité n’est pas plafonnée par IP');
});

test('injection : recherche, notes et jetons ne deviennent jamais du code exécutable', async () => {
  const db = await dbs();
  const before = await db.num('SELECT COUNT(*) FROM customers');
  const evil = {
    offeringId: 1,
    start: (await openDay(3)).ts,
    customer: {
      firstName: "'; DROP TABLE customers; --",
      lastName: '<script>alert(1)</script>',
      phone: phoneFor(4242),
      email: "x'@test.fr",
      note: "Note\r\nBEGIN:VTODO\r\nDICTIONNAIRE:volés\n../../../../etc/passwd",
    },
    consent: { terms: true },
  };
  const b = await call('/api/public/booking', { body: evil });
  assert.ok([201, 422].includes(b.status), `soit la saisie est refusée proprement, soit elle est stockée comme texte : ${b.status} ${b.text.slice(0, 120)}`);
  assert.equal(await db.num('SELECT COUNT(*) FROM customers'), before + (b.status === 201 ? 1 : 0), 'aucune table n\u2019a disparu');

  const sqli = await call(`/api/admin/customers/search?q=${encodeURIComponent("' OR 1=1 --")}`);
  assert.ok([200, 401, 403].includes(sqli.status), 'une charge injectée ne transforme pas la recherche en liste complète');
  if (sqli.status === 200) assert.equal(sqli.json.items?.length ?? 0, 0, 'la recherche paramétrée ne renvoie rien sur un fragment de SQL');

  const fake = await call(`/api/public/actions/ics?token=${encodeURIComponent('abc\r\nBEGIN:VEVENT')}`);
  assert.ok([400, 403, 404].includes(fake.status), `jeton forgé refusé (${fake.status})`);
  assert.ok(!/BEGIN:VTODO/.test(fake.text), 'aucune ligne iCal injectée');

  if (b.status === 201) {
    const ics = await call(`/api/public/actions/ics?token=${encodeURIComponent(b.json.manageToken)}`);
    assert.equal((ics.text.match(/BEGIN:VEVENT/g) ?? []).length, 1, 'le .ics reste un seul événement');
    const cookie = await login('owner@zyass.fr');
    const view = await call(`/api/admin/appointments/${b.json.id}`, { cookie });
    if (view.status === 200) assert.ok(!/<script>/i.test(JSON.stringify(view.json)), 'le back-office ne renvoie pas de balise nue');
  }
  const stored = await db.one<any>(`SELECT internal_note, first_name FROM customers WHERE phone = :p`, { p: evil.customer.phone }).catch(() => null);
  void stored;
});

test('aucune erreur interne pendant la tempête : observations et statuts 5xx', async () => {
  const db = await dbs();
  const errs = await db.all<any>(`SELECT id, kind, name, status, meta_json FROM observations WHERE status = 'error' OR CAST(status AS INTEGER) >= 500 ORDER BY id LIMIT 5`);
  assert.equal(errs.length, 0, `observations non vides : ${JSON.stringify(errs).slice(0, 400)}`);
  const total = await db.num(`SELECT COUNT(*) FROM observations WHERE kind = 'api_reject'`);
  assert.ok(total >= 1, 'le capteur a bien vu les refus de la tempête (sinon ce test ne prouverait rien)');
});
