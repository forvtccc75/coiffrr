import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { app, call, openDay } from './helpers.ts';
import { db } from '../server/db/index.ts';
import { loadCtx } from '../server/domain/context.ts';
import { bumpAvailabilityCache } from '../server/domain/availability.ts';
import { replayWaitlist, scoreEntry, expireStaleOffers, fulfillPromises } from '../server/domain/waitlist.ts';
import { dispatchNow } from '../server/domain/notify.ts';
import { dow, minutesOfDay } from '../server/lib/time.ts';

beforeEach(async () => {
  await app(); const q = db();
  await q.exec('DELETE FROM waitlist_offers'); await q.exec('DELETE FROM waitlist');
  await q.exec("DELETE FROM appointments WHERE status = 'held'");
  await q.exec('DELETE FROM notifications'); await q.exec('DELETE FROM rate_buckets'); bumpAvailabilityCache();
});
async function join(n = 1) {
  const r = await call('/api/public/waitlist', { body: { name: 'Attente test', phone: `06775533${String(n).padStart(2,'0')}`, email: `attente${n}@example.test`, serviceKey: 'coupe-homme', days: [], flex: { otherDays: true, otherStaff: true, sameDayOtherTime: true }, consent: true } });
  assert.equal(r.status, 201, r.text); return r.json;
}
async function offered() {
  const entry = await join(); const ctx = await loadCtx(); const { ts } = await openDay(3);
  const r = await replayWaitlist(ctx, { staffId: ctx.staff[0].id, serviceId: ctx.services[0].id, offeringId: ctx.offerings[0].id, start: ts, end: ts + ctx.offerings[0].duration_min * 60000 });
  // openDay peut viser un autre barbier : chercher sa disponibilité réelle si nécessaire.
  if (!r.offers) {
    const { fulfillPromises } = await import('../server/domain/waitlist.ts'); await fulfillPromises(ctx);
  }
  const offer = await db().one<any>("SELECT * FROM waitlist_offers WHERE waitlist_id = :i AND status = 'pending'", { i: entry.id });
  assert.ok(offer, 'une véritable offre a été produite'); return { entry, offer, ctx };
}

test('inscription : e-mail transactionnel de suivi, pas de doublon ni fuite du lien privé', async () => {
  const a = await join(); const b = await join(); assert.equal(b.alreadyExists, true); assert.equal(b.token, undefined); assert.equal(b.manageUrl, undefined); assert.equal(await db().num('SELECT count(*) FROM waitlist'), 1);
  const rows = await db().all<any>("SELECT * FROM notifications WHERE kind = 'waitlist_joined'");
  assert.equal(rows.length, 1); assert.equal(rows[0].recipient, 'attente1@example.test'); assert.ok(rows[0].body_text.includes(a.token));
});

test('jours, heures et barbier stricts : la priorité ne contourne pas le refus de flexibilité', async () => {
  const ctx = await loadCtx(); const { ts } = await openDay(3); const slot = { start: ts, staffId: ctx.staff[0].id, serviceId: ctx.services[0].id };
  const e = { days: JSON.stringify([(dow(ts)+1)%7]), flex_json: '{}', priority: 999, created_ts: Date.now() - 10*86400000 };
  assert.equal(scoreEntry(ctx, e, slot).score, -Infinity);
  assert.equal(scoreEntry(ctx, { ...e, days: '[]', staff_id: slot.staffId + 999 }, slot).score, -Infinity);
  assert.equal(scoreEntry(ctx, { ...e, days: '[]', window_start_min: minutesOfDay(ts)+10, window_end_min: minutesOfDay(ts)+20 }, slot).score, -Infinity);
  assert.ok(Number.isFinite(scoreEntry(ctx, { ...e, flex_json: '{"otherDays":true}' }, slot).score));
});

test('offre en lecture seule, confirmation explicite, lien RDV fonctionnel, refus tardif non destructif', async () => {
  const { offer } = await offered();
  const preview = await call('/api/public/waitlist/offer?token=' + encodeURIComponent(offer.token)); assert.equal(preview.status, 200);
  assert.equal((await db().one<any>('SELECT status FROM appointments WHERE id = :i', { i: offer.appointment_id }))?.status, 'held');
  const claim = await call('/api/public/waitlist/claim', { body: { token: offer.token } }); assert.equal(claim.status, 200, claim.text); assert.ok(claim.json.manageToken);
  assert.equal((await call('/api/public/appointment?token='+encodeURIComponent(claim.json.manageToken))).status, 200);
  const again = await call('/api/public/waitlist/claim', { body: { token: offer.token } }); assert.equal(again.status, 200); assert.ok(again.json.manageToken);
  const decline = await call('/api/public/waitlist/decline', { body: { token: offer.token } }); assert.equal(decline.status, 409);
  assert.equal((await db().one<any>('SELECT status FROM appointments WHERE id = :i', { i: offer.appointment_id }))?.status, 'booked');
});

test('retrait : libère le hold et empêche les notifications et la confirmation ultérieure', async () => {
  const { entry, offer } = await offered();
  const cancel = await call('/api/public/waitlist/cancel', { body: { token: entry.token } }); assert.equal(cancel.status, 200);
  assert.equal((await db().one<any>('SELECT status FROM appointments WHERE id = :i', { i: offer.appointment_id }))?.status, 'cancelled');
  assert.equal(await db().num("SELECT count(*) FROM notifications WHERE waitlist_offer_id = :i AND status = 'queued'", { i: offer.id }), 0);
  assert.equal((await call('/api/public/waitlist/claim', { body: { token: offer.token } })).status, 409);
  const status = await call('/api/public/waitlist/status?token='+entry.token); assert.equal(status.json.entry.status, 'withdrawn'); assert.equal(status.json.position.rank, null);
});

test('expiration : aucun e-mail périmé ; passage au suivant, pas de boucle sur le même client', async () => {
  const { offer, ctx } = await offered(); const next = await join(2);
  // Simule des messages encore en file à la suite d'une panne fournisseur.
  await db().exec("UPDATE notifications SET status = 'queued', sent_ts = NULL WHERE waitlist_offer_id = :i", { i: offer.id });
  await db().update('waitlist_offers', offer.id, { expires_ts: Date.now()-1000 });
  await dispatchNow(ctx, 30);
  assert.equal(await db().num("SELECT count(*) FROM notifications WHERE waitlist_offer_id = :i AND status = 'sent'", { i: offer.id }), 0);
  const expired = await expireStaleOffers(ctx); assert.equal(expired.expired, 1); assert.equal(expired.promoted, 1);
  const following = await db().one<any>("SELECT * FROM waitlist_offers WHERE status = 'pending'"); assert.equal(following.waitlist_id, next.id);
});

test('concurrence : deux confirmations ne créent ni double RDV ni erreur 500', async () => {
  const { offer } = await offered();
  const responses = await Promise.all([1,2].map(() => call('/api/public/waitlist/claim', { body: { token: offer.token } })));
  assert.ok(responses.some(r => r.status === 200)); assert.ok(responses.every(r => [200,409].includes(r.status)), responses.map(r=>r.text).join('\n'));
  assert.equal(await db().num("SELECT count(*) FROM appointments WHERE waitlist_offer_id = :i AND status = 'booked'", { i: offer.id }), 1);
});

test('capacité ouverte : propose un vrai créneau même pour une demande sans fiche client initiale', async () => {
  const e = await join(3); assert.equal((await db().one<any>('SELECT customer_id FROM waitlist WHERE id = :i', { i:e.id }))?.customer_id, null);
  const result = await fulfillPromises(await loadCtx()); assert.ok(result.notified > 0);
  const offer = await db().one<any>('SELECT * FROM waitlist_offers WHERE waitlist_id = :i', { i:e.id }); assert.ok(offer);
  const mail = await db().one<any>("SELECT * FROM notifications WHERE waitlist_offer_id = :i AND channel = 'email'", { i:offer.id }); assert.ok(mail.body_text.includes('/waitlist/reserver?token=')); assert.ok(mail.body_text.includes(offer.token));
});

test('validation API : jours et plage invalides, prestation non publiée refusés', async () => {
  const common = { name: 'Attente test', phone: '0677553388', consent: true };
  for (const patch of [{ days: [9] }, { window: [1000,900] }, { serviceKey: 'modele-inactif' }]) assert.equal((await call('/api/public/waitlist', { body: { ...common, ...patch } })).status, 422);
});

test('inscriptions simultanées : une seule demande et aucun lien privé dans la réponse du doublon', async () => {
  const results = await Promise.all([join(9), join(9)]);
  assert.equal(await db().num('SELECT count(*) FROM waitlist'), 1);
  assert.equal(results.filter(r => !r.alreadyExists && r.token).length, 1);
  const duplicate = results.find(r => r.alreadyExists); assert.ok(duplicate); assert.equal(duplicate.token, undefined);
});
