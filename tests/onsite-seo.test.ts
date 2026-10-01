import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app, call, login, openDay } from './helpers.ts';

let createdBooking: any;
async function setup() {
  await app();
  const { env } = await import('../server/lib/env.ts');
  const { loadCtx } = await import('../server/domain/context.ts');
  const { db } = await import('../server/db/index.ts');
  return { env, ctx: await loadCtx(), q: db() };
}

test('paiement sur place force zéro acompte même pour prestation chère et historique no-show', async () => {
  const { env, ctx } = await setup(); const saved = env.payments; env.payments = 'off';
  try {
    const { depositFor, ensurePayment, PayDisabledError } = await import('../server/domain/payments.ts');
    assert.equal(depositFor(ctx, { priceCents: 25000, service: ctx.services[0], customer: { noshow_count: 10 }, durationMin: 180 }), 0);
    await assert.rejects(() => ensurePayment(ctx, { appointmentId: 0, customerId: 0, amountCents: 2500, kind: 'deposit' }), PayDisabledError);
    const cfg = await call('/api/public/config');
    assert.equal(cfg.json.payments.online, false); assert.equal(cfg.json.features.deposits, false); assert.equal(cfg.json.policy.deposit.mode, 'none');
  } finally { env.payments = saved; }
});

test('réservation sans Stripe : booked, zero payé, aucune écriture de paiement', async () => {
  const { env, q } = await setup(); const saved = env.payments; env.payments = 'off';
  try {
    const before = await q.num('SELECT count(*) FROM payments');
    const { ts } = await openDay(4);
    const r = await call('/api/public/booking', { body: { offeringId: 1, start: ts, customer: { firstName: 'Clienttest', phone: '0677889921', email: 'test-onsite@example.test' }, consent: { terms: true, marketingEmail: false, marketingSms: false } } });
    assert.equal(r.status, 201, r.text); createdBooking = r.json; assert.equal(r.json.status, 'booked'); assert.equal(r.json.depositCents, 0);
    assert.equal(await q.num('SELECT paid_cents FROM appointments WHERE id = :i', { i: r.json.id }), 0);
    assert.equal(await q.num('SELECT count(*) FROM payments'), before);
  } finally { env.payments = saved; }
});

test('carte cadeau : achat public refusé, encaissement explicite admin enregistré sur place', async () => {
  const { env, q } = await setup(); const saved = env.payments; env.payments = 'off';
  try {
    const body = { amountCents: 3000, buyerName: 'Client test', buyerEmail: 'gift@example.test' };
    const before = await q.num('SELECT count(*) FROM gift_cards');
    const r = await call('/api/public/gift-cards', { body }); assert.equal(r.status, 409);
    assert.equal(await q.num('SELECT count(*) FROM gift_cards'), before);
    const r2 = await call('/api/admin/gift-cards', { body, cookie: await login('owner@zyass.fr') });
    assert.equal(r2.status, 201, r2.text); assert.equal(r2.json.status, 'active');
    const pay = await q.one<any>('SELECT * FROM payments WHERE id = :i', { i: r2.json.payment_id });
    assert.equal(pay.provider, 'on_site'); assert.equal(pay.amount_cents, 3000);
  } finally { env.payments = saved; }
});

test('code de connexion transactionnel : transmis sans consentement marketing, immédiatement et à chaque demande', async () => {
  const { q } = await setup();
  for (let i = 0; i < 2; i++) {
    const r = await call('/api/public/auth/code', { body: { target: 'test-onsite@example.test' } });
    assert.equal(r.status, 200, r.text); assert.match(r.json.demoCode, /^\d{6}$/);
    const row = await q.one<any>("SELECT * FROM notifications WHERE kind = 'login_code' ORDER BY id DESC LIMIT 1");
    assert.ok(row); assert.match(row.body_text, new RegExp(r.json.demoCode));
    assert.ok(Number(row.send_ts) <= Date.now()); assert.equal(row.channel, 'email');
  }
  assert.equal(await q.num("SELECT count(*) FROM notifications WHERE kind = 'login_code'"), 2);
});

test('sitemap canonique, routes privées exclues et robots IA sans fuite', async () => {
  await setup();
  const map = await call('/sitemap.xml'); assert.equal(map.status, 200); assert.match(map.text, /\/infos<\/loc>/); assert.doesNotMatch(map.text, /\/infos-pratique|\/admin|\/espace|token=/);
  const robots = await call('/robots.txt');
  assert.match(robots.text, /OAI-SearchBot/); assert.match(robots.text, /Claude-SearchBot/); assert.match(robots.text, /Disallow: \/rdv\//);
  assert.equal((await call('/infos-pratique')).status, 301);
  assert.equal((await call('/url-totalement-inexistante')).status, 404);
  const privatePage = await call('/rdv/1?token=exemple');
  assert.match(privatePage.headers.get('x-robots-tag') || '', /noindex/);
  assert.match(privatePage.headers.get('cache-control') || '', /no-store/);
});

test('métadonnées distinctes, canonical absolu et JSON-LD HairSalon cohérent', async () => {
  const { env, ctx } = await setup();
  const home = (await call('/api/public/seo/home')).json;
  const prices = (await call('/api/public/seo/tarifs')).json;
  const staff = (await call('/api/public/seo/barbier-' + ctx.staff[0].slug)).json;
  assert.notEqual(home.meta.title, prices.meta.title);
  assert.equal(prices.meta.canonical, env.appUrl + '/tarifs');
  assert.equal(staff.meta.canonical, env.appUrl + '/barbier/' + ctx.staff[0].slug);
  assert.ok(home.jsonLd.some((x: any) => x['@type'] === 'HairSalon'));
  assert.ok(staff.jsonLd.some((x: any) => x['@type'] === 'BreadcrumbList'));
});

test('fichiers IA dynamiques : données publiques, prix décimaux, pas de dossiers clients', async () => {
  const { env } = await setup(); const saved = env.payments; env.payments = 'off';
  try {
    for (const path of ['/llms.txt', '/llms-full.txt']) {
      const r = await call(path); assert.equal(r.status, 200); assert.match(r.text, /20 boulevard Roy/); assert.match(r.text, /aucun paiement en ligne/); assert.match(r.text, /dimanche fermé/); assert.match(r.text, /25\.00 EUR/);
      assert.doesNotMatch(r.text, /demo-owner|password_hash|manageToken|test-onsite@example/);
    }
  } finally { env.payments = saved; }
});


test('report : un RDV ne se bloque pas lui-même, sans lever le blocage des autres clients', async () => {
  const { q } = await setup();
  assert.ok(createdBooking);
  const move = await call('/api/public/appointment/reschedule', { body: { token: createdBooking.manageToken, start: createdBooking.start } });
  assert.equal(move.status, 200, move.text);
  const a = await q.one<any>('SELECT * FROM appointments WHERE id = :i', { i: createdBooking.id });
  const other = await q.one<any>("SELECT start_ts FROM appointments WHERE staff_id = :s AND id != :i AND status IN ('booked','confirmed') AND start_ts > :n ORDER BY start_ts LIMIT 1", { s: a.staff_id, i: a.id, n: Date.now() });
  assert.ok(other);
  const conflict = await call('/api/public/appointment/reschedule', { body: { token: createdBooking.manageToken, start: Number(other.start_ts) } });
  assert.equal(conflict.status, 409, conflict.text);
});


test('cartes cadeaux : deux e-mails au bon acheteur, solde et revenu de prestation sans double déduction', async () => {
  const { env, q, ctx } = await setup(); const saved = env.payments; env.payments = 'off';
  try {
    const { buyGiftCard } = await import('../server/domain/loyalty.ts');
    const { completeBooking, cancelBooking } = await import('../server/domain/booking.ts');
    const a = await buyGiftCard(ctx, { amountCents: 1500, buyerName: 'Acheteur test', buyerEmail: 'cards@example.test', pay: false });
    const b = await buyGiftCard(ctx, { amountCents: 5000, buyerName: 'Acheteur test', buyerEmail: 'cards@example.test', pay: false });
    const mails = await q.all<any>("SELECT * FROM notifications WHERE kind = 'gift_card_received' AND recipient = 'cards@example.test'");
    assert.equal(mails.length, 2); assert.ok(mails.some(m => m.body_text.includes(a.code))); assert.ok(mails.some(m => m.body_text.includes(b.code)));
    assert.ok(a.expiry_ts > Date.now() + 364 * 86400000);
    const booked = await call('/api/public/booking', { body: { offeringId: 1, start: (await openDay(6)).ts, giftCardCode: a.code, customer: { firstName: 'Giftclient', phone: '0677889955' }, consent: { terms: true } } });
    assert.equal(booked.status, 201, booked.text); const gross = booked.json.priceCents;
    assert.equal(booked.json.balanceCents, gross - 1500);
    const completed = await completeBooking(ctx, booked.json.id); assert.equal(completed.revenue, gross);
    assert.equal(await q.num('SELECT paid_cents FROM appointments WHERE id = :i', { i: booked.json.id }), gross);
    const second = await call('/api/public/booking', { body: { offeringId: 1, start: (await openDay(7)).ts, giftCardCode: b.code, customer: { firstName: 'Giftcancel', phone: '0677889966' }, consent: { terms: true } } });
    assert.equal(second.status, 201, second.text); await cancelBooking(ctx, second.json.id, { by: 'owner' });
    assert.equal(await q.num('SELECT balance_cents FROM gift_cards WHERE id = :i', { i: b.id }), 5000);
  } finally { env.payments = saved; }
});
