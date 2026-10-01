/**
 * WhatsApp : ce qui doit être vrai avant d'envoyer le premier message réel.
 *
 * Trois engagements du produit sont testés ici :
 *  1. le site n'affiche un lien WhatsApp que si le numéro est réellement joignable
 *     (pas de bouton mort, pas de wa.me/ à moitié rempli) ;
 *  2. un rappel part au bon format pour Meta Graph API, avec le texte court du SMS
 *     (pas le corps d'e-mail) et le numéro local du fichier converti en format international ;
 *  3. si l'opérateur refuse le message, la notification n'est pas perdue : elle reste
 *     en file avec une tentative comptée et la raison de l'échec — « zéro demande perdue »
 *     vaut aussi pour les messages sortants.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app, call } from './helpers.ts';

const ctxOf = async () => {
  const { loadCtx } = await import('../server/domain/context.ts');
  return loadCtx();
};
const q = async () => (await import('../server/db/index.ts')).db();

const envOf = async () => (await import('../server/lib/env.ts')).env;

/** Réponse Meta toute faite : on ne sort jamais du processus dans les tests. */
function mockFetch(handler: (url: string, init: any) => any) {
  const prev = globalThis.fetch as any;
  const seen: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: any, init: any = {}) => {
    seen.push({ url: String(url), init });
    const r = handler(String(url), init);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  return { seen, restore: () => (globalThis.fetch = prev) };
}

test('waNumber accepte l’écriture locale du registre comme l’écriture internationale', async () => {
  const { waNumber } = await import('../server/domain/notify.ts');
  assert.equal(waNumber('+33 6 44 04 83 85'), '33644048385');
  assert.equal(waNumber('06 44 04 83 85'), '33644048385', 'un numéro français noté à la locale doit partir, pas échouer');
  assert.equal(waNumber('0033644048385'), '33644048385');
  assert.equal(waNumber('+33612345678'), '33612345678');
  assert.equal(waNumber(''), '');
  assert.equal(waNumber('06 44'), '0644', 'un numéro troncé reste troncé : c’est au garde-fou de le refuser plus bas');
});

test('le canal texte par défaut suit le fournisseur réellement branché', async () => {
  const { textChannel } = await import('../server/domain/notify.ts');
  const env = await envOf();
  const saved = { force: process.env.NOTIFY_TEXT_CHANNEL, provider: env.waProvider };
  try {
    process.env.NOTIFY_TEXT_CHANNEL = 'sms';
    assert.equal(textChannel(), 'sms', 'NOTIFY_TEXT_CHANNEL=sms force le SMS même si WhatsApp est prêt');
    process.env.NOTIFY_TEXT_CHANNEL = 'whatsapp';
    assert.equal(textChannel(), 'whatsapp');
    delete process.env.NOTIFY_TEXT_CHANNEL;
    env.waProvider = 'stdout';
    assert.equal(textChannel(), 'sms', 'aucun fournisseur WhatsApp → on ne promet pas ce qu’on ne peut pas envoyer');
    // la faute de branchement réelle : PROVIDER=meta collé sans jeton ni numéro. Les rappels ne
    // doivent pas s'éteindre pour autant — ils partent en SMS, et l'admin voit le bouton WhatsApp éteint.
    env.waProvider = 'meta';
    assert.equal(textChannel(), 'sms', 'fournisseur déclaré mais incomplet → on ne bascule pas');
    const savedCreds = { token: env.waToken, phoneId: env.waPhoneId };
    env.waToken = 'EAAG…';
    env.waPhoneId = '123456789012345';
    const { waReady } = await import('../server/domain/notify.ts');
    assert.equal(waReady(), true);
    assert.equal(textChannel(), 'whatsapp', 'fournisseur complet → WhatsApp devient le canal texte par défaut');
    // et si le salon force WhatsApp, l'incomplet doit crier (ici : rester sur sms n'est pas permis)
    env.waToken = '';
    process.env.NOTIFY_TEXT_CHANNEL = 'whatsapp';
    assert.equal(textChannel(), 'whatsapp', 'une force explicite est respectée, l’erreur remonte dans la file');
    env.waToken = savedCreds.token;
    env.waPhoneId = savedCreds.phoneId;
  } finally {
    if (saved.force === undefined) delete process.env.NOTIFY_TEXT_CHANNEL;
    else process.env.NOTIFY_TEXT_CHANNEL = saved.force;
    env.waProvider = saved.provider;
  }
});

test('la vitrine n’expose un lien WhatsApp que si le numéro est utilisable', async () => {
  await app();
  const owner = await call('/api/public/auth/password', { body: { email: 'owner@zyass.fr', password: 'demo-owner' } }).then((r) => r.cookie);
  const cfg0 = await call('/api/public/config');
  const l0: any = cfg0.json?.links ?? {};
  assert.ok(l0.whatsappHref, 'la démo documente un WhatsApp : le lien doit être présent');
  assert.match(l0.whatsappHref, /^https:\/\/wa\.me\/33644048385\?text=/, l0.whatsappHref);
  const pre = decodeURIComponent(l0.whatsappHref.split('?text=')[1] ?? '');
  assert.match(pre, /réserv/i, 'le message d’accueil est pré-rempli et lisible côté client');
  assert.ok(!l0.whatsappHref.includes('?text=&'), 'jamais de paramètre vide collé au lien');

  // numéro incomplet → plus de bouton du tout (plutôt qu'un lien qui ouvre une conversation orpheline)
  const bad = await call('/api/admin/settings', { method: 'POST', cookie: owner, body: { brand: { whatsapp: '06 44' } } });
  assert.equal(bad.status, 200, bad.text.slice(0, 160));
  const cfg1 = await call('/api/public/config');
  assert.equal(cfg1.json.links.whatsappHref, null, 'un numéro inutilisable ne doit pas produire de lien');

  // champ vidé → idem, et le sillage « contact » du site reste cohérent
  const cleared = await call('/api/admin/settings', { method: 'POST', cookie: owner, body: { brand: { whatsapp: '' } } });
  assert.equal(cleared.status, 200);
  const cfg2 = await call('/api/public/config');
  assert.equal(cfg2.json.links.whatsappHref ?? null, null);

  // la valeur enregistrée depuis l’admin survit au rechargement du contexte
  const back = await call('/api/admin/settings', { method: 'POST', cookie: owner, body: { brand: { whatsapp: '+33 6 44 04 83 85' } } });
  assert.equal(back.status, 200);
  const cfg3 = await call('/api/public/config');
  assert.equal(cfg3.json.links.whatsappHref.split('?')[0], 'https://wa.me/33644048385');
});

test('ZERO CHAOS : un rappel WhatsApp part au format Meta, avec le texte court du SMS', async () => {
  await app();
  const ctx: any = await ctxOf();
  const d = await q();
  const env = await envOf();
  const stamp = Date.now();
  const cid = await d.insert('customers', {
    location_id: ctx.locId,
    first_name: 'Idriss',
    last_name: 'D.',
    phone: '06 11 22 33 44', // tel qu'il est noté dans le registre du salon
    phone_norm: '33611223344',
    email: `idriss.${stamp}@mail.fr`,
    email_norm: `idriss.${stamp}@mail.fr`,
    preferred_channel: 'whatsapp',
    created_ts: Date.now(),
    updated_ts: Date.now(),
  });

  const saved = { provider: env.waProvider, token: env.waToken, phoneId: env.waPhoneId, template: env.waTemplate };
  const m = mockFetch(() => ({ status: 200, body: { messages: [{ id: 'wamid.TEST1' }] } }));
  try {
    env.waProvider = 'meta';
    env.waToken = 'token-de-test';
    env.waPhoneId = '1234567890';
    env.waTemplate = '';

    const { notify } = await import('../server/domain/notify.ts');
    const ids = await notify(ctx, 'reminder_d1', { customerId: cid, channels: ['whatsapp', 'sms'], sendAfter: 0 });
    assert.ok(ids.length >= 1, 'les deux canaux doivent produire un message');
    // on isole la file : le reste de la démo ne doit pas passer par le faux réseau
    await d.exec(`UPDATE notifications SET status = 'superseded' WHERE status = 'queued' AND (customer_id IS NULL OR customer_id <> :c)`, { c: cid });
    await d.exec(`UPDATE notifications SET send_ts = 0 WHERE customer_id = :c`, { c: cid });

    const { dispatchNow } = await import('../server/domain/notify.ts');
    const out = await dispatchNow(ctx as any, 50);
    assert.ok(out.sent >= 1, 'la file doit avoir tourné');

    const wa = m.seen.find((x) => x.url.includes('graph.facebook.com'));
    assert.ok(wa, 'un appel Meta doit avoir été tenté');
    assert.match(wa!.url, /^https:\/\/graph\.facebook\.com\/v[\d.]+\/1234567890\/messages$/);
    assert.equal(wa!.init.headers.Authorization, 'Bearer token-de-test');
    const payload = JSON.parse(wa!.init.body);
    assert.equal(payload.messaging_product, 'whatsapp');
    assert.equal(payload.to, '33611223344', 'le numéro local du registre doit partir en format international');
    assert.equal(payload.type, 'text', 'hors fenêtre de gabarit, on envoie un message libre');
    const body = payload.text.body as string;
    assert.ok(body.length < 320, `message texte court attendu, reçu ${body.length} caractères`);
    assert.ok(!/<\/p>|Bonjour Idriss,/.test(body), 'le corps d’e-mail ne doit pas servir de texte WhatsApp');
    assert.ok(!/:\s*#(\s|$|\.)/.test(body), `aucun lien en point d'interrogation dans un message envoyé : ${body}`);
    assert.match(body, /Demain|confirme/i, 'le gabarit SMS doit être réutilisé tel quel');

    const rows = await d.all<any>(`SELECT * FROM notifications WHERE customer_id = :c AND template_key = 'reminder_d1'`, { c: cid });
    const waRow = rows.find((r) => r.channel === 'whatsapp')!;
    const smsRow = rows.find((r) => r.channel === 'sms')!;
    assert.equal(waRow.status, 'sent');
    assert.equal(JSON.parse(waRow.meta_json).provider, 'whatsapp-meta');
    assert.equal(JSON.parse(waRow.meta_json).provider_id, 'wamid.TEST1', 'l’identifiant Meta est conservé : c’est la preuve traçable de l’envoi');
    assert.equal(waRow.body_text, smsRow.body_text, 'même promesse sur les deux canaux, pas deux versions qui se contredisent');
  } finally {
    m.restore();
    env.waProvider = saved.provider;
    env.waToken = saved.token;
    env.waPhoneId = saved.phoneId;
    env.waTemplate = saved.template;
    await d.exec(`DELETE FROM notifications WHERE customer_id = :c`, { c: cid });
    await d.exec(`DELETE FROM customers WHERE id = :i`, { i: cid });
  }
});

test('un gabarit approuvé est utilisé dès qu’il est déclaré', async () => {
  await app();
  const ctx: any = await ctxOf();
  const d = await q();
  const env = await envOf();
  const cid = await d.insert('customers', {
    location_id: ctx.locId,
    first_name: 'Kaly',
    phone: '+33611223344',
    phone_norm: '33611223344',
    preferred_channel: 'whatsapp',
    created_ts: Date.now(),
    updated_ts: Date.now(),
  });
  const saved = { provider: env.waProvider, token: env.waToken, phoneId: env.waPhoneId, template: env.waTemplate, lang: process.env.WHATSAPP_TEMPLATE_LANG };
  const m = mockFetch(() => ({ status: 200, body: { messages: [{ id: 'wamid.TPL' }] } }));
  try {
    env.waProvider = 'meta';
    env.waToken = 't';
    env.waPhoneId = '99';
    env.waTemplate = 'zyass_rappel_v2';
    process.env.WHATSAPP_TEMPLATE_LANG = 'fr';
    const { notify } = await import('../server/domain/notify.ts');
    const ids = await notify(ctx, 'reminder_h3', { customerId: cid, channels: ['whatsapp'], sendAfter: 0 });
    assert.ok(ids.length >= 1);
    await d.exec(`UPDATE notifications SET status = 'superseded' WHERE status = 'queued' AND (customer_id IS NULL OR customer_id <> :c)`, { c: cid });
    await d.exec(`UPDATE notifications SET send_ts = 0, status = 'queued' WHERE customer_id = :c`, { c: cid });
    const { dispatchNow } = await import('../server/domain/notify.ts');
    await dispatchNow(ctx as any, 50);
    const call2 = m.seen.find((x) => x.url.includes('graph.facebook.com'));
    assert.ok(call2, 'l’appel doit avoir eu lieu');
    const payload = JSON.parse(call2!.init.body);
    assert.equal(payload.type, 'template');
    assert.equal(payload.template.name, 'zyass_rappel_v2');
    assert.equal(payload.template.language.code, 'fr');
    assert.equal(payload.template.components[0].type, 'body');
    assert.ok(payload.template.components[0].parameters[0].text.length <= 600);
  } finally {
    m.restore();
    env.waProvider = saved.provider;
    env.waToken = saved.token;
    env.waPhoneId = saved.phoneId;
    env.waTemplate = saved.template;
    if (saved.lang === undefined) delete process.env.WHATSAPP_TEMPLATE_LANG;
    else process.env.WHATSAPP_TEMPLATE_LANG = saved.lang;
    await d.exec(`DELETE FROM notifications WHERE customer_id = :c`, { c: cid });
    await d.exec(`DELETE FROM customers WHERE id = :i`, { i: cid });
  }
});

test('ZERO DEMANDE PERDUE : si Meta refuse, le message reste dans la boîte d’envoi', async () => {
  await app();
  const ctx: any = await ctxOf();
  const d = await q();
  const env = await envOf();
  const cid = await d.insert('customers', { location_id: ctx.locId, first_name: 'Sami', phone: '+33611223344', phone_norm: '33611223344', preferred_channel: 'whatsapp', created_ts: Date.now(), updated_ts: Date.now() });
  const saved = { provider: env.waProvider, token: env.waToken, phoneId: env.waPhoneId };
  const m = mockFetch(() => ({ status: 400, body: { error: { message: 'Re-engagement message' } } }));
  try {
    env.waProvider = 'meta';
    env.waToken = 't';
    env.waPhoneId = '99';
    const { notify, dispatchNow } = await import('../server/domain/notify.ts');
    const ids = await notify(ctx, 'noshow_notice', { customerId: cid, channels: ['whatsapp'], sendAfter: 0 });
    assert.ok(ids.length >= 1, 'le message doit être créé même si le fournisseur est capricieux');
    await d.exec(`UPDATE notifications SET status = 'superseded' WHERE status = 'queued' AND (customer_id IS NULL OR customer_id <> :c)`, { c: cid });
    await d.exec(`UPDATE notifications SET send_ts = 0, status = 'queued' WHERE customer_id = :c`, { c: cid });
    await dispatchNow(ctx as any, 50);
    const row = await d.one<any>(`SELECT * FROM notifications WHERE id = :i`, { i: ids[0] });
    assert.equal(row.status, 'queued', 'un refus opérateur ne doit jamais effacer la demande : on réessaie avec backoff');
    const meta = JSON.parse(row.meta_json);
    assert.equal(meta.tries, 1);
    assert.match(row.error, /Re-engagement message|whatsapp 400/, row.error);
    assert.ok(row.send_ts > Date.now(), 'la prochaine tentative est repoussée, pas immédiate');
  } finally {
    m.restore();
    env.waProvider = saved.provider;
    env.waToken = saved.token;
    env.waPhoneId = saved.phoneId;
    await d.exec(`DELETE FROM notifications WHERE customer_id = :c`, { c: cid });
    await d.exec(`DELETE FROM customers WHERE id = :i`, { i: cid });
  }
});
