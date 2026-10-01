import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app, call, openDay } from './helpers.ts';

const db = async () => (await import('../server/db/index.ts')).db();
const ctxOf = async () => (await import('../server/domain/context.ts')).loadCtx('zyass');
/** offeringId réel (et pas un id codé en dur : la graine change selon le moteur de base). */
const coupe = async () => {
  const cfg = await call('/api/public/config');
  const svc = cfg.json.services.find((x: any) => x.key === 'coupe-homme') ?? cfg.json.services[0];
  return svc.offeringId as number;
};
const tickNow = async () => {
  const { tick } = await import('../server/domain/automations.ts');
  return tick({ ctx: await ctxOf(), full: false });
};

/**
 * Un brouillon d'abandon de panier n'est pas un client. Ces trois tests verrouillent le bug
 * mesuré en conditions réelles : `cust.id` sur un client null faisait exploser tout le tick, donc
 * plus aucune automatisation du salon ne tournait (waitlist, no-show, anniversaires, segments).
 */
test('brouillon sans client : le tick survit, mark skipped, et ne spamme personne', async () => {
  await app();
  const d = await db();
  await d.exec(`DELETE FROM rate_buckets`);
  const slot = await openDay(4);
  const phone = `06${String(97100000 + (Date.now() % 100000)).padStart(8, '0')}`;
  const dr = await call('/api/public/draft', {
    method: 'POST',
    body: {
      visitorId: `orphelin-${Date.now()}`,
      offeringId: await coupe(),
      slot: slot.ts,
      step: 'contact',
      contact: { firstName: 'Orphelin', phone, email: `orphelin${Date.now() % 100000}@mail.fr` },
      attribution: { source: 'instagram' },
    },
  });
  assert.ok(dr.status < 400, `draft → ${dr.status} ${dr.text.slice(0, 140)}`);
  // contact_ts posé + délai de relance purgé : le brouillon est « mûr » pour la relance
  await d.exec(`UPDATE booking_drafts SET contact_ts = :t, updated_ts = :t2 WHERE id = :i`, { t: Date.now() - 90 * 60000, t2: Date.now() - 90 * 60000, i: dr.json.id });

  const rep = await tickNow();
  assert.equal(rep.draftErrors, 0, `le tick a cassé sur un brouillon orphelin: ${JSON.stringify(rep)}`);
  const after = await d.one<any>(`SELECT status FROM booking_drafts WHERE id = :i`, { i: dr.json.id });
  assert.equal(after?.status, 'skipped_no_customer', `le brouillon orphelin devrait être marqué, pas planté (${after?.status})`);
  const n = await d.num(`SELECT COUNT(*) FROM notifications WHERE kind = 'draft_abandon' AND customer_id IN (SELECT id FROM customers WHERE phone = :p)`, { p: phone });
  assert.equal(n, 0, 'aucun message de relance pour un inconnu sans compte');
  // et le tick reste utile : les autres sections ont tourné
  assert.ok(typeof rep.birthdays === 'number' && typeof rep.rebook === 'number', 'les autres automatisations ont bien été exécutées');
});

test('brouillon d’un client qui a donné son consentement : une seule relance, jamais deux', async () => {
  await app();
  const d = await db();
  await d.exec(`DELETE FROM rate_buckets`);
  const slot = await openDay(3);
  const phone = `06${String(97200000 + (Date.now() % 100000)).padStart(8, '0')}`;
  const email = `fidel${Date.now() % 100000}@mail.fr`;
  const b = await call('/api/public/booking', { body: { offeringId: await coupe(), start: slot.ts, customer: { firstName: 'Fidele', phone, email }, consent: { terms: true, marketingEmail: true } } });
  assert.equal(b.status, 201, b.text.slice(0, 140));
  const { normalizePhone } = await import('../server/lib/inputs.ts');
  const cust = await d.one<any>(`SELECT id FROM customers WHERE phone_norm = :p`, { p: normalizePhone(phone) });
  assert.ok(cust, 'le client de test devrait exister');

  const dr = await call('/api/public/draft', {
    method: 'POST',
    body: { visitorId: `fidele-${Date.now()}`, offeringId: await coupe(), slot: slot.ts + 3600000, step: 'contact', contact: { firstName: 'Fidele', phone, email } },
  });
  assert.ok(dr.status < 400, `draft → ${dr.status}`);
  await d.exec(`UPDATE booking_drafts SET contact_ts = :t, updated_ts = :t2 WHERE id = :i`, { t: Date.now() - 90 * 60000, t2: Date.now() - 90 * 60000, i: dr.json.id });

  const rep = await tickNow();
  assert.equal(rep.draftErrors, 0);
  const sent = await d.num(`SELECT COUNT(*) FROM notifications WHERE kind = 'draft_abandon' AND customer_id = :c`, { c: cust.id });
  assert.ok(sent >= 1, `la relance aurait dû partir (brouillon mûr, consentement email) : ${JSON.stringify(rep)}`);
  const st = await d.one<any>(`SELECT status FROM booking_drafts WHERE id = :i`, { i: dr.json.id });
  assert.equal(st?.status, 'recovered');
  const rep2 = await tickNow();
  const sent2 = await d.num(`SELECT COUNT(*) FROM notifications WHERE kind = 'draft_abandon' AND customer_id = :c`, { c: cust.id });
  assert.equal(sent2, sent, `deux tick = deux relances : spam (${sent} → ${sent2})`);
  assert.equal(rep2.draftErrors, 0);
});

test('le tick enregistre son rapport, y compris quand une section a été dégradée', async () => {
  await app();
  const d = await db();
  const rep = await tickNow();
  const obs = await d.one<any>(`SELECT status, meta_json FROM observations WHERE kind = 'cron' AND name = 'tick' ORDER BY id DESC LIMIT 1`);
  assert.ok(obs, 'le tick doit laisser une trace (observations) pour être pilotable en production');
  assert.ok(['ok', 'warn'].includes(obs.status), `statut de trace inattendu: ${obs.status}`);
  const meta = JSON.parse(obs.meta_json ?? '{}');
  assert.equal(typeof meta.dispatched, 'number', 'le rapport est stocké, pas seulement renvoyé');
  assert.equal(rep.draftErrors, meta.draftErrors ?? 0, 'le nombre de brouillons cassés est bien dans la trace');
});

test('le cron serveurless répond aussi en GET (Vercel Cron ne fait que des GET)', async () => {
  await app();
  const secret = process.env.CRON_SECRET || 'dev-cron-secret';
  const bon = await call(`/api/internal/cron?secret=${secret}&source=test-get`);
  assert.equal(bon.status, 200, `GET /api/internal/cron → ${bon.status} ${bon.text.slice(0, 160)} (Vercel Cron n’émet que des GET : un 404 ici coupe toutes les automatisations en silence)`);
  assert.ok(bon.json && typeof bon.json === 'object', 'le tick doit rendre un rapport, même vide');
  const mauvais = await call('/api/internal/cron?secret=mauvais-secret');
  assert.equal(mauvais.status, 403, `secret erroné → ${mauvais.status}`);
  const post = await call('/api/internal/cron?secret=' + secret, { body: { source: 'test-post' } });
  assert.equal(post.status, 200, 'POST doit continuer de fonctionner (smoke, pg-check, cron Vercel Pro)');
});
