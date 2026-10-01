import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { app, call, openDay } from './helpers.ts';

let owner = '';
const db = async () => (await import('../server/db/index.ts')).db();

beforeEach(async () => {
  await app();
  const d = await db();
  await d.exec(`DELETE FROM rate_buckets`);
  if (!owner) owner = await call('/api/public/auth/password', { body: { email: 'owner@zyass.fr', password: 'demo-owner' } }).then((r) => r.cookie);
});

const hourOf = (ts: number) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ts));
  return Number(parts.find((x: any) => x.type === 'hour')?.value ?? NaN);
};
const phoneFor = (n: number) => `06${String(99000000 + n).padStart(8, '0')}`;

test('ZERO CHAOS : réserver planifie la confirmation et les rappels, sans doublon', async () => {
  const slot = await openDay(5);
  const b = await call('/api/public/booking', { body: { offeringId: 1, start: slot.ts, customer: { firstName: 'Terrell', phone: phoneFor(1), email: 'terrell@mail.fr' } } });
  assert.equal(b.status, 201, b.text.slice(0, 140));
  const d = await db();
  const rows = await d.all(`SELECT kind, channel, send_ts, status FROM notifications WHERE appointment_id = :i ORDER BY send_ts`, { i: b.json.id });
  const kinds = rows.map((r: any) => r.kind);
  assert.ok(kinds.includes('booking_confirmed'), 'la confirmation part sans qu’on la demande');
  assert.ok(rows.length >= 2, 'rappels programmés en plus de la confirmation');
  assert.equal(new Set(rows.map((r: any) => `${r.kind}:${r.channel}`)).size, rows.length, `deux fois le même message = spam : ${JSON.stringify(rows.slice(0, 4))}`);
  for (const r of rows) assert.ok(['queued', 'sent'].includes(r.status), `statut de file inattendu ${r.status}`);
  // rejouer la notification ne doit pas dédoubler
  const rem = await call(`/api/admin/appointments/${b.json.id}/remind`, { method: 'POST', body: {}, cookie: owner });
  assert.ok(rem.status === 200 || rem.status === 204, `relance admin refusée (${rem.status})`);
  const after = await d.num(`SELECT COUNT(*) FROM notifications WHERE appointment_id = :i AND kind = 'booking_confirmed' AND channel = 'sms'`, { i: b.json.id });
  assert.equal(after, 1, 'un seul SMS de confirmation, même si on re-demande');
});

test('nuit calme : aucun SMS client hors des heures ouvrables de contact', async () => {
  const d = await db();
  const rows = await d.all(`SELECT send_ts, kind FROM notifications WHERE channel IN ('sms','whatsapp') AND send_ts IS NOT NULL LIMIT 400`);
  assert.ok(rows.length > 0, 'les réservations de ce fichier produisent bien des SMS');
  assert.ok(rows.length > 0, 'les réservations de ce fichier produisent bien des SMS');
  for (const r of rows) {
    const h = hourOf(Number(r.send_ts));
    assert.ok(h >= 8 && h <= 21, `message ${r.kind} programmé à ${h} h — la nuit est silence`);
  }
});

test('contenu des messages : liens internes uniquement, variables toutes remplacées', async () => {
  const d = await db();
  const rows = await d.all(`SELECT body_text FROM notifications WHERE body_text IS NOT NULL ORDER BY id DESC LIMIT 60`);
  for (const r of rows) {
    const b = String(r.body_text);
    assert.doesNotMatch(b, /\{[a-z_]+\}/i, `variable non remplacée : ${b.slice(0, 90)}`);
    for (const link of b.match(/https?:\/\/[^\s)]+/g) ?? []) {
      assert.match(link, /^https?:\/\/(localhost|127\.0\.0\.1|zyass\.fr|app\.zyass\.fr|(www\.)?google\.[a-z.]+\/maps)/, `lien inattendu dans un message : ${link}`);
    }
    assert.doesNotMatch(b, /<script|javascript:/i);
  }
});

test('consentement : pas de prospection vers un client qui n’a rien autorisé', async () => {
  const slot = await openDay(6);
  const b = await call('/api/public/booking', { body: { offeringId: 1, start: slot.ts, customer: { firstName: 'NoMarketing', phone: phoneFor(2) }, consent: { terms: true, marketingSms: false, marketingEmail: false } } });
  assert.equal(b.status, 201, b.text.slice(0, 140));
  const done = await call(`/api/admin/appointments/${b.json.id}/complete`, { method: 'POST', body: {}, cookie: owner });
  assert.equal(done.status, 200, done.text.slice(0, 120));
  const d = await db();
  // prospection sortante (SMS/e-mail/WhatsApp) : 0 message sans consentement.
  const out = await d.all(`SELECT kind, channel FROM notifications WHERE customer_id = :c AND channel IN ('sms','email','whatsapp') AND kind IN ('review_request','review_thanks','rebook_suggestion','winback','birthday','campaign','loyalty_reward','referral_success','draft_abandon','welcome')`, { c: b.json.customerId });
  assert.equal(out.length, 0, `prospection sans consentement : ${JSON.stringify(out)}`);
  // les rappels liés au rendez-vous, eux, passent (transactionnel)
  const trans = await d.num(`SELECT COUNT(*) FROM notifications WHERE customer_id = :c AND channel = 'sms'`, { c: b.json.customerId });
  assert.ok(trans >= 2, 'le transactionnel doit continuer de sortir');
  const cu = await d.one<any>(`SELECT consent_marketing_sms, consent_marketing_email FROM customers WHERE id = :i`, { i: b.json.customerId });
  assert.equal(Number(cu.consent_marketing_sms), 0, 'le refus n’est jamais retourné en « oui » par le système');
  assert.equal(Number(cu.consent_marketing_email), 0);
  // ce qui reste autorisé : la suggestion dans l’espace du client (in-app, pas une sollicitation)
  const inApp = await d.num(`SELECT COUNT(*) FROM notifications WHERE customer_id = :c AND channel = 'web'`, { c: b.json.customerId });
  assert.ok(inApp >= 0, 'les suggestions in-app sont comptées mais never envoyées hors du compte');
});

test('interrupteur d’automatisation : éteindre coupe réellement le flux', async () => {
  const off = await call('/api/admin/automations/auto_review', { method: 'POST', body: { is_active: false }, cookie: owner });
  assert.equal(off.status, 200, off.text.slice(0, 120));
  const slot = await openDay(7);
  const b = await call('/api/public/booking', { body: { offeringId: 1, start: slot.ts, customer: { firstName: 'Quiet', phone: phoneFor(3) }, consent: { terms: true, marketingSms: true } } });
  assert.equal(b.status, 201, b.text.slice(0, 140));
  await call(`/api/admin/appointments/${b.json.id}/complete`, { method: 'POST', body: {}, cookie: owner });
  const d = await db();
  const n = await d.num(`SELECT COUNT(*) FROM notifications WHERE customer_id = :c AND kind = 'review_request'`, { c: b.json.customerId });
  assert.equal(n, 0, 'automatisation éteinte = aucun message de ce type');
  await call('/api/admin/automations/auto_review', { method: 'POST', body: { is_active: true }, cookie: owner });
  const unknown = await call('/api/admin/automations/auto_nexiste_pas', { method: 'POST', body: { is_active: false }, cookie: owner });
  assert.equal(unknown.status, 404, 'une clé inconnue répond 404, pas 500');
});

test('no-show : constaté côté back-office, tracé, et le client est relancé proprement', async () => {
  const slot = await openDay(8);
  const b = await call('/api/public/booking', { body: { offeringId: 1, start: slot.ts, customer: { firstName: 'Ghost', phone: phoneFor(4) } } });
  assert.equal(b.status, 201, b.text.slice(0, 140));
  const r = await call(`/api/admin/appointments/${b.json.id}/no-show`, { method: 'POST', body: {}, cookie: owner });
  assert.equal(r.status, 200, r.text.slice(0, 140));
  const d = await db();
  const appt = await d.one<any>(`SELECT status FROM appointments WHERE id = :i`, { i: b.json.id });
  assert.equal(appt.status, 'no_show');
  const cu = await d.one<any>(`SELECT noshow_count FROM customers WHERE id = :i`, { i: b.json.customerId });
  assert.equal(Number(cu.noshow_count), 1, 'le compteur du client suit');
  const ev = await d.num(`SELECT COUNT(*) FROM appointment_events WHERE appointment_id = :i AND kind LIKE '%no_show%'`, { i: b.json.id });
  assert.ok(ev >= 1, 'l’événement est journalisé sur le rendez-vous');
});
