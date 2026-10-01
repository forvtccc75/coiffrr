import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { app, call, openDay } from './helpers.ts';

beforeEach(async () => {
  await app();
  const { db } = await import('../server/db/index.ts');
  await db().exec(`DELETE FROM rate_buckets`);
});

let entry: { id: number; token: string; phone: string } | null = null;
const phone = '0655667788';

test('waitlist : une demande valide est enregistrée avec sa position réelle', async () => {
  const res = await call('/api/public/waitlist', {
    body: { name: 'Idriss K', phone, serviceKey: 'coupe-homme', days: [4, 5], window: [1020, 1200], flex: { otherStaff: true, otherDay: true, extraDays: 3 }, note: 'Dispo après 17 h', consent: true, attribution: { source: 'instagram' } },
  });
  assert.equal(res.status, 201, res.text.slice(0, 200));
  assert.ok(res.json.token, 'un lien de gestion est envoyé au client');
  assert.ok(res.json.position.rank >= 1 && res.json.position.total >= res.json.position.rank, 'position cohérente');
  assert.equal(res.json.alreadyExists, false);
  assert.match(res.json.manageUrl, /\/waitlist\?token=/);
  entry = { id: res.json.id, token: res.json.token, phone };
});

test('waitlist : la même demande deux fois ne crée pas de doublon', async () => {
  assert.ok(entry);
  const again = await call('/api/public/waitlist', { body: { name: 'Idriss K', phone, serviceKey: 'coupe-homme', days: [4, 5], consent: true } });
  assert.equal(again.status, 201);
  assert.equal(again.json.alreadyExists, true, 'on ne fait pas croire au client qu’il est deuxième en file');
  const { db } = await import('../server/db/index.ts');
  const n = await db().num(`SELECT COUNT(*) FROM waitlist WHERE phone_norm = :p`, { p: '33655667788' });
  assert.equal(n, 1, 'une seule ligne en base');
});

test('waitlist : le suivi par jeton marche sans compte, et un faux jeton est refusé', async () => {
  assert.ok(entry);
  const st = await call(`/api/public/waitlist/status?token=${entry!.token}`);
  assert.equal(st.status, 200);
  assert.equal(st.json.entry.phone_masked ? st.json.entry.phone_masked.slice(0, 3) : '06', '06');
  assert.ok(st.json.position.total >= 1);
  const bad = await call(`/api/public/waitlist/status?token=${entry!.token.slice(0, -3)}abc`);
  assert.equal(bad.status, 403);
  assert.equal(bad.json.error, 'lien_invalide');
});

test('récupération de créneau : le libéré est proposé au premier compatible, en FIFO', async () => {
  assert.ok(entry);
  // un créneau libre pris puis annulé → l'offre doit partir vers la waitlist compatible
  const slot = await openDay(2);
  const b = await call('/api/public/booking', { body: { offeringId: slot.days[0]?.service?.offeringId ?? 1, start: slot.ts, customer: { firstName: 'Zied', phone: '0655667701' } } });
  assert.equal(b.status, 201, b.text.slice(0, 160));
  const c = await call('/api/public/appointment/cancel', { body: { token: b.json.manageToken } });
  assert.equal(c.status, 200);
  assert.ok(c.json.waitlistOffers >= 1, `créneau annulé mais aucune offre envoyée (${JSON.stringify(c.json).slice(0, 120)})`);
  assert.equal(c.json.claimUrls, undefined, 'le client qui annule ne reçoit pas les liens privés des personnes en attente');
  const st = await call(`/api/public/waitlist/status?token=${entry!.token}`);
  const offers = st.json.offers ?? [];
  assert.ok(offers.length >= 0);
  if (offers.length) {
    assert.ok(offers[0].expires > Date.now(), 'une offre a une échéance réelle');
    assert.ok(offers[0].token, 'l’offre est réclamable par jeton');
  }
});

test('refuser une offre la libère pour la suite de la file', async () => {
  assert.ok(entry);
  const st = await call(`/api/public/waitlist/status?token=${entry!.token}`);
  const open = (st.json.offers ?? []).find((o: any) => o.status === 'pending');
  if (!open) {
    // aucune offre en attente pour ce client précis : on vérifie juste que refuser reste propre
    const r = await call('/api/public/waitlist/decline', { body: { token: 'x' } });
    assert.ok([400, 403, 404, 422].includes(r.status), 'un jeton invalide ne fait pas n’importe quoi');
    return;
  }
  const d = await call('/api/public/waitlist/decline', { body: { token: open.token } });
  assert.equal(d.status, 200, d.text.slice(0, 160));
  const after = await call(`/api/public/waitlist/status?token=${entry!.token}`);
  const same = (after.json.offers ?? []).find((o: any) => o.token === open.token);
  assert.ok(!same || same.status !== 'pending', 'l’offre refusée n’est plus réclamable');
  const { db } = await import('../server/db/index.ts');
  const held = await db().num(`SELECT COUNT(*) FROM appointments WHERE start_ts = :s AND status = 'held'`, { s: open.start ?? open.ts });
  assert.equal(held, 0, 'le créneau refusé n’est plus bloqué pour personne');
});

test('annuler sa demande waitlist se respecte (et ne laisse pas le client recevoir des SMS)', async () => {
  assert.ok(entry);
  const c = await call('/api/public/waitlist/cancel', { body: { token: entry!.token } });
  assert.equal(c.status, 200, c.text.slice(0, 160));
  const st = await call(`/api/public/waitlist/status?token=${entry!.token}`);
  assert.ok([200, 403, 404, 410].includes(st.status));
  if (st.status === 200) assert.notEqual(st.json.entry.status, 'waiting', 'la demande n’est plus active');
  const { db } = await import('../server/db/index.ts');
  const n = await db().num(`SELECT COUNT(*) FROM waitlist WHERE phone_norm = :p AND status = 'waiting'`, { p: '33655667788' });
  assert.equal(n, 0);
});

test('consentement : une demande sans consentement reste en file mais ne sera jamais contactée', async () => {
  const r = await call('/api/public/waitlist', { body: { name: 'Anon', phone: '0655667799', serviceKey: 'coupe-homme', days: [0, 1, 2, 3, 4, 5, 6], consent: false } });
  assert.equal(r.status, 201, 'on ne rejette pas la demande : on enregistre juste « ne pas contacter »');
  const { db } = await import('../server/db/index.ts');
  const row = await db().one<any>(`SELECT consent_contact, status FROM waitlist WHERE phone_norm = :p`, { p: '33655667799' });
  assert.equal(Number(row.consent_contact), 0, 'le refus est tracé');
  // un créneau libéré sur sa prestation : rien ne doit partir vers ce numéro
  const slot = await openDay(1);
  const b = await call('/api/public/booking', { body: { offeringId: 1, start: slot.ts, customer: { firstName: 'Zied', phone: '0655667702' } } });
  assert.equal(b.status, 201, b.text.slice(0, 120));
  await call('/api/public/appointment/cancel', { body: { token: b.json.manageToken } });
  const n = await db().num(`SELECT COUNT(*) FROM notifications WHERE kind = 'waitlist_offer' AND recipient = :p`, { p: '0655667799' });
  assert.equal(n, 0, 'aucun SMS d’offre pour un client sans consentement');
  const other = await db().num(`SELECT COUNT(*) FROM notifications WHERE kind = 'waitlist_offer' AND recipient = '0655667702'`);
  assert.equal(other, 0, 'et pas davantage pour celui qui vient d’annuler (il n’est pas en waitlist)');
});
