import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmail } from '../server/lib/email-template.ts';
import { publicMapsUrl, SALON_MAPS_URL, REFERENCE_HOURS, hoursForDay } from '../shared/salon.ts';
process.env.TEST_DB = 'memory'; process.env.DEMO_MODE = '0'; process.env.NODE_ENV = 'test';

test('Brevo : HTML + texte + expéditeur vérifié + reply-to, API simulée sans envoi réel', async () => {
  const { env } = await import('../server/lib/env.ts'); const { sendEmail } = await import('../server/domain/notify.ts');
  const saved = { emailProvider: env.emailProvider, brevoKey: env.brevoKey, emailFrom: env.emailFrom, emailReplyTo: env.emailReplyTo };
  const oldFetch = globalThis.fetch; let payload: any;
  try {
    Object.assign(env, { emailProvider: 'brevo', brevoKey: 'test-key', emailFrom: 'Z.YASS <reservation@example.test>', emailReplyTo: 'contact@example.test' });
    globalThis.fetch = (async (url: any, init: any) => { assert.equal(url, 'https://api.brevo.com/v3/smtp/email'); assert.equal(init.headers['api-key'], 'test-key'); payload = JSON.parse(init.body); return new Response(JSON.stringify({ messageId: 'test-message' }), { status: 201 }); }) as any;
    assert.deepEqual(await sendEmail('client@example.test', 'Confirmation', 'À bientôt', { kind: 'booking_confirmed' }), { provider: 'brevo', id: 'test-message' });
    assert.equal(payload.textContent, 'À bientôt'); assert.match(payload.htmlContent, /<!doctype html>/); assert.equal(payload.sender.email, 'reservation@example.test'); assert.equal(payload.replyTo.email, 'contact@example.test');
    globalThis.fetch = (async () => new Response('{}', { status: 401 })) as any;
    await assert.rejects(() => sendEmail('client@example.test', 'Test', 'Test'), /brevo HTTP 401/);
    env.brevoKey = ''; await assert.rejects(() => sendEmail('client@example.test', 'Test', 'Test'), /BREVO_API_KEY/);
  } finally { Object.assign(env, saved); globalThis.fetch = oldFetch; }
});
test('gabarits : échappement HTML, code visible, URL dangereuse sans bouton', () => {
  const html = buildEmail({ appUrl: 'https://example.test', subject: '<script>oops</script>', body: 'Ton code : 123456 <img onerror="x">', kind: 'login_code', vars: { link_manage: 'javascript:alert(1)' } });
  assert.ok(!html.includes('<script>')); assert.match(html, /&lt;img/); assert.match(html, /123456/); assert.ok(!html.includes('href="javascript:'));
  for (const kind of ['booking_confirmed', 'reminder_d1', 'cancelled', 'rescheduled', 'waitlist_offer', 'gift_card_received']) assert.match(buildEmail({ appUrl: 'https://example.test', kind, subject: 'Test', body: 'Test', vars: { code: 'ZY-TEST', link_book: 'https://example.test/book', link_manage: 'https://example.test/rdv/1', link_claim: 'https://example.test/waitlist' } }), /role="presentation"/);
});
test('Maps : champ admin, ancien champ, lien vide et schéma dangereux', () => {
  assert.equal(publicMapsUrl({ googleMapsUrl: '' }), SALON_MAPS_URL); assert.equal(publicMapsUrl({ mapsUrl: 'https://maps.google.com/' }), 'https://maps.google.com/');
  assert.equal(publicMapsUrl({ googleMapsUrl: 'javascript:alert(1)' }), SALON_MAPS_URL);
  assert.equal(hoursForDay(REFERENCE_HOURS, 1), '09:30–20:00'); assert.equal(hoursForDay(REFERENCE_HOURS, 0), 'Fermé'); assert.equal(hoursForDay({ '1': [['09:00','12:00'],['14:00','19:00']] }, 1), '09:00–12:00 · 14:00–19:00');
});
test('base vide : config exploitable sans bootstrap owner, modèles privés et idempotents', async () => {
  const { bootstrap, createApp } = await import('../server/app.ts'); const { db } = await import('../server/db/index.ts'); const { prepareDraftCatalogue } = await import('../server/seed/drafts.ts');
  await bootstrap(); const q = db(); const loc = await q.one<any>('SELECT id FROM locations LIMIT 1');
  const app = createApp(); assert.equal((await app.request('/api/public/config')).status, 200);
  assert.deepEqual(await prepareDraftCatalogue(loc.id), { services: 4, staff: 3 }); assert.deepEqual(await prepareDraftCatalogue(loc.id), { services: 0, staff: 0 });
  const { invalidateCtx } = await import('../server/domain/context.ts'); invalidateCtx();
  const config = await (await app.request('/api/public/config')).json() as any; assert.equal(config.services.length, 0); assert.equal(config.staff.length, 0);
  for (const t of ['customers', 'appointments', 'reviews']) assert.equal(await q.num(`SELECT count(*) FROM ${t}`), 0);
  const { ensureOwner } = await import('../server/lib/access.ts'); await ensureOwner({ email: 'setup@example.test', password: 'setup-password-12345' });
  const login = await app.request('/api/public/auth/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'setup@example.test', password: 'setup-password-12345', scope: 'admin' }) });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const settings = await (await app.request('/api/admin/settings', { headers: { cookie } })).json() as any;
  assert.equal(settings.staff.length, 3); assert.equal(settings.services.length, 4);
  const staffId = settings.staff[0].id;
  const hoursEdit = await app.request('/api/admin/staff', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id: staffId, name: settings.staff[0].name, hours: [{ dow: 1, start: '10:00', end: '18:00' }] }) });
  assert.equal(hoursEdit.status, 200); assert.equal(await q.num('SELECT is_active FROM staff WHERE id = :i', { i: staffId }), 0, 'éditer les horaires ne doit pas publier un modèle');
  const svc = settings.services[0]; const publish = await app.request('/api/admin/services', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id: svc.id, key: svc.key, name: 'Coupe validée en test isolé', priceCents: 2200, durationMin: 30, active: true }) });
  assert.equal(publish.status, 200, await publish.text());
  assert.equal((await (await app.request('/api/public/config')).json() as any).services[0].priceCents, 2200);
});


test('le propriétaire peut changer son mot de passe, sans exposer ni réinitialiser les autres comptes', async () => {
  const { createApp } = await import('../server/app.ts'); const app = createApp();
  const request = async (path: string, body: any, cookie = '') => app.request(path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const login = await request('/api/public/auth/password', { email: 'setup@example.test', password: 'setup-password-12345', scope: 'admin' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await request('/api/admin/account/password', { currentPassword: 'incorrect', password: 'new-test-password-456' }, cookie)).status, 403);
  assert.equal((await request('/api/admin/account/password', { currentPassword: 'setup-password-12345', password: 'new-test-password-456' }, cookie)).status, 200);
  assert.equal((await request('/api/public/auth/password', { email: 'setup@example.test', password: 'setup-password-12345', scope: 'admin' })).status, 401);
  assert.equal((await request('/api/public/auth/password', { email: 'setup@example.test', password: 'new-test-password-456', scope: 'admin' })).status, 200);
});


test('galerie Google : import local idempotent, une suppression admin est respectée', async () => {
  const { db, transaction } = await import('../server/db/index.ts');
  const { importApprovedGoogleGallery } = await import('../server/seed/google-gallery.ts');
  const q = db(); const loc = await q.one<any>('SELECT id FROM locations LIMIT 1');
  const count = await q.num('SELECT count(*) FROM media WHERE location_id = :l', { l: loc.id }); assert.equal(count, 1);
  await transaction(t => importApprovedGoogleGallery(t, loc.id), 731004);
  assert.equal(await q.num('SELECT count(*) FROM media WHERE location_id = :l', { l: loc.id }), 1);
  await q.exec('DELETE FROM media WHERE location_id = :l', { l: loc.id });
  await transaction(t => importApprovedGoogleGallery(t, loc.id), 731004);
  assert.equal(await q.num('SELECT count(*) FROM media WHERE location_id = :l', { l: loc.id }), 0);
});
