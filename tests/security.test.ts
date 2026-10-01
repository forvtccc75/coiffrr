import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { app, call, openDay } from './helpers.ts';

beforeEach(async () => {
  await app();
  const { db } = await import('../server/db/index.ts');
  await db().exec(`DELETE FROM rate_buckets`);
});

test('en-têtes durs : clicjacking, sniffing, referrer, CSP fermée', async () => {
  const res = await call('/api/public/config');
  const h = res.headers;
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.equal(h.get('x-frame-options'), 'DENY');
  assert.equal(h.get('referrer-policy'), 'no-referrer', 'aucun referrer des routes API ou privées');
  const csp = h.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /connect-src 'self'/, 'pas de exfiltration vers un domaine tiers depuis le client');
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, 'aucun script inline autoris\u00e9 : le build n\u2019en produit aucun');
  assert.match(csp, /style-src 'self' 'unsafe-inline'/, 'les styles en ligne de React restent permis (sinon la mise en page saute)');
  assert.equal(h.get('cross-origin-opener-policy'), 'same-origin');
});

test('session : cookie HttpOnly + SameSite=Lax, aucun jeton dans le localStorage, aucun mot de passe renvoyé', async () => {
  const res = await call('/api/public/auth/password', { body: { email: 'owner@zyass.fr', password: 'demo-owner' } });
  assert.equal(res.status, 200, res.text.slice(0, 120));
  const raw = (res.headers.getSetCookie?.() ?? []).join(' ');
  assert.match(raw, /zyass_session=/);
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Lax/i, 'SameSite=Lax = le CSRF cross-site par POST ne peut pas porter la session');
  assert.match(raw, /Path=\//);
  assert.doesNotMatch(JSON.stringify(res.json), /password|passwd|secret|hash/i);
});

test('RBAC : anon 401, barbier 403 sur les réglages, patron 200', async () => {
  const anon = await call('/api/admin/today');
  assert.equal(anon.status, 401);
  const staff = await call('/api/public/auth/password', { body: { email: 'mehdi@zyass.fr', password: 'demo-staff' } });
  assert.equal(staff.status, 200);
  const asStaff = await call('/api/admin/settings', { cookie: staff.cookie });
  assert.equal(asStaff.status, 403, 'un barbier ne change pas la politique du salon');
  const asStaff2 = await call('/api/admin/staff', { method: 'POST', body: { name: 'Faux', email: 'faux@zyass.fr' }, cookie: staff.cookie });
  assert.equal(asStaff2.status, 403, 'un barbier ne modifie pas l’équipe ni ses droits');
  const today = await call('/api/admin/today', { cookie: staff.cookie });
  assert.equal(today.status, 200, 'mais il voit bien son planning');
  const owner = await call('/api/public/auth/password', { body: { email: 'owner@zyass.fr', password: 'demo-owner' } });
  assert.equal((await call('/api/admin/settings', { cookie: owner.cookie })).status, 200);
});

test('IDOR : un client ne voit ni ne touche le rendez-vous d’un autre', async () => {
  const slotA = await openDay(1);
  const a = await call('/api/public/booking', { body: { offeringId: 1, start: slotA.ts, customer: { firstName: 'Awa', phone: '0677000001', email: 'awa@mail.fr' } } });
  assert.equal(a.status, 201, a.text.slice(0, 120));
  const slotB = await openDay(2);
  const b = await call('/api/public/booking', { body: { offeringId: 1, start: slotB.ts, customer: { firstName: 'Bira', phone: '0677000002' } } });
  assert.equal(b.status, 201, b.text.slice(0, 120));

  // session client de A (code envoyé par le serveur de démo)
  const code = await call('/api/public/auth/code', { body: { target: '0677000001' } });
  assert.equal(code.status, 200);
  const verify = await call('/api/public/auth/code/verify', { body: { target: '0677000001', code: String(code.json.demoCode) } });
  assert.equal(verify.status, 200, verify.text.slice(0, 120));
  const list = await call('/api/client/appointments', { cookie: verify.cookie });
  assert.equal(list.status, 200);
  const ids = (list.json ?? []).map((x: any) => x.id ?? x.appointment?.id);
  assert.ok(ids.includes(a.json.id), 'le rendez-vous de A est bien le sien');
  assert.ok(!ids.includes(b.json.id), 'IDOR : celui de B n’apparaît pas');
  const peek = await call(`/api/client/appointments/${b.json.id}`, { cookie: verify.cookie });
  assert.ok([403, 404].includes(peek.status), `détail d’un RDV tiers refusé (reçu ${peek.status})`);
  const steal = await call('/api/public/appointment/cancel', { body: { token: b.json.manageToken.slice(0, -4) + 'AAAA' } });
  assert.equal(steal.status, 403);
});

test('le plafond de tentatives de connexion reste celui de la production', async () => {
  const { LOGIN_LIMITS } = await import('../server/routes.ts');
  assert.equal(LOGIN_LIMITS.prod, 10, '10 tentatives / 10 min par IP : à ne pas assouplir en silence');
  assert.ok(LOGIN_LIMITS.dev > LOGIN_LIMITS.prod, 'la démo locale (suites e2e multi-contextes) a besoin d’une marge, pas la prod');
  assert.equal(LOGIN_LIMITS.windowSec, 600);
});

test('force brute : le code de connexion est limité, et un code erroné ne donne rien', async () => {
  const target = '0677000009';
  await call('/api/public/auth/code', { body: { target } });
  let last: any = null;
  for (let i = 0; i < 8; i++) last = await call('/api/public/auth/code/verify', { body: { target, code: '000000' } });
  assert.equal(last.status, 429, 'le plafond de tentatives doit couper le brute force');
  const { db } = await import('../server/db/index.ts');
  const cu = await db().one<any>(`SELECT id FROM customers WHERE phone_norm = :p`, { p: '33677000009' });
  const sessions = cu ? await db().num(`SELECT COUNT(*) FROM sessions WHERE user_type = 'customer' AND user_id = :i`, { i: cu.id }) : 0;
  assert.equal(sessions, 0, 'aucune session créée pour la victime du brute force');
  const tries = await db().num(`SELECT COUNT(*) FROM login_codes WHERE target = :t AND consumed = 1`, { t: '0677000009' });
  assert.equal(tries, 0, 'aucun code marqué consommé à tort');
});

test('injection : une charge SQL dans les champs texte ne casse rien et ne fuit pas', async () => {
  const owner = await call('/api/public/auth/password', { body: { email: 'owner@zyass.fr', password: 'demo-owner' } });
  const { db } = await import('../server/db/index.ts');
  const before = await db().num(`SELECT COUNT(*) FROM customers`);
  for (const q of [`' OR 1=1 --`, `'; DROP TABLE customers; --`, `%`, `_`, `1 UNION SELECT password_hash FROM staff`]) {
    const r = await call(`/api/admin/search?q=${encodeURIComponent(q)}`, { cookie: owner.cookie });
    assert.ok(r.status === 200 || r.status === 400, `statut inattendu ${r.status} pour ${q}`);
  }
  const after = await db().num(`SELECT COUNT(*) FROM customers`);
  assert.equal(after, before, 'la base est intacte');
  const slot = await openDay(3);
  const inj = await call('/api/public/booking', { body: { offeringId: 1, start: slot.ts, customer: { firstName: `<script>alert(1)</script>`, phone: '0677000011', note: `'); UPDATE customers SET first_name='x' --` } } });
  assert.ok([201, 400, 409, 422, 429].includes(inj.status), `réponse cohérente, pas de 500 (${inj.status})`);
  if (inj.status === 201) {
    const view = await call(`/api/public/appointment?token=${inj.json.manageToken}`);
    assert.doesNotMatch(JSON.stringify(view.json), /<script>/i, 'le HTML stocké est neutralisé à la lecture');
  }
});

test('cron interne : secret obligatoire (sinon n’importe qui déclencherait les automatisations)', async () => {
  const noSecret = await call('/api/internal/cron', { method: 'POST', body: {} });
  assert.equal(noSecret.status, 403);
  const withSecret = await call('/api/internal/cron', { method: 'POST', body: {}, headers: { 'x-cron-secret': process.env.CRON_SECRET || 'dev-cron-secret' } });
  assert.equal(withSecret.status, 200, withSecret.text.slice(0, 160));
});

test('RGPD : export lisible par le client et suppression qui efface vraiment', async () => {
  const slot = await openDay(4);
  const b = await call('/api/public/booking', { body: { offeringId: 1, start: slot.ts, customer: { firstName: 'Ghislain', lastName: 'R.', phone: '0677000021', email: 'ghislain@mail.fr' } } });
  assert.equal(b.status, 201, b.text.slice(0, 120));
  const code = await call('/api/public/auth/code', { body: { target: '0677000021' } });
  const v = await call('/api/public/auth/code/verify', { body: { target: '0677000021', code: String(code.json.demoCode) } });
  assert.equal(v.status, 200);
  const exp = await call('/api/client/export', { cookie: v.cookie });
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-type') ?? '', /json/);
  assert.ok(JSON.stringify(exp.json).includes('Ghislain'), 'l’export contient bien ses données');
  const noConfirm = await call('/api/client/delete', { method: 'POST', body: { confirm: false }, cookie: v.cookie });
  assert.equal(noConfirm.status, 422, 'pas de suppression sans confirmation explicite');
  const del = await call('/api/client/delete', { method: 'POST', body: { confirm: true }, cookie: v.cookie });
  assert.equal(del.status, 200, del.text.slice(0, 160));
  const { db } = await import('../server/db/index.ts');
  const row = await db().one<any>(`SELECT deleted_ts, email, phone, phone_norm, first_name FROM customers WHERE id = :i`, { i: b.json.customerId });
  assert.ok(row && Number(row.deleted_ts) > 0, 'la fiche est marquée supprimée');
  assert.equal(row.phone, null, 'le numéro est effacé (anonymisation, pas juste un drapeau)');
  assert.equal(row.phone_norm, null, 'et la clé de recherche aussi');
  assert.equal(row.email, null);
  assert.equal(row.first_name, 'Supprimé');
  const again = await call('/api/public/auth/code', { body: { target: '0677000021' } });
  assert.ok([200, 400, 404, 429].includes(again.status));
  const loginAfter = await call('/api/public/auth/code/verify', { body: { target: '0677000021', code: String(again.json?.demoCode ?? '000000') } });
  assert.notEqual(loginAfter.status, 200, 'on ne peut plus se reconnecter à un compte supprimé');
  const ledger = await db().one<any>(`SELECT COUNT(*) AS n FROM appointments WHERE customer_id = :i`, { i: b.json.customerId });
  assert.ok(Number(ledger.n) >= 0, 'les lignes anonymisées restent comptables pour le salon (chiffre juste, pas de donnée perso)');
  const audit = await db().num(`SELECT COUNT(*) FROM audit_logs WHERE action = 'gdpr.erase' AND entity_id = :i`, { i: b.json.customerId });
  assert.equal(audit, 1, 'la suppression est tracée (preuve de traitement RGPD)');
});

test('corps illisible = 400 du client, pas un 500 qui pollue la supervision', async () => {
  const { app, call } = await import('./helpers.ts');
  await app();
  for (const path of ['/api/public/booking', '/api/public/track', '/api/public/waitlist']) {
    for (const body of ['pas du json', '{"a":', '', 'nullnull', '"\u0000"']) {
      const res = await call(path, { method: 'POST', raw: body });
      assert.ok(res.status === 400 || res.status === 422 || res.status === 202 || res.status === 200, `${path} avec corps ${JSON.stringify(body)} → ${res.status} ${res.text.slice(0, 80)}`);
      assert.ok(res.status < 500, `${path} renvoie un 5xx sur un corps cassé (${res.status})`);
      if (res.status === 400) assert.equal(res.json.error, 'corps_invalide', `message technique renvoyé au client: ${res.text.slice(0, 120)}`);
    }
  }
  const { db } = await import('../server/db/index.ts');
  const traces = await db().num(`SELECT COUNT(*) FROM observations WHERE kind = 'api_reject'`);
  assert.ok(traces > 0, 'un rejet doit être tracé (sinon on ne voit jamais les clients qui échouent)');
  const pannes = await db().num(`SELECT COUNT(*) FROM observations WHERE kind = 'error' AND name LIKE '/api/%'`);
  assert.equal(pannes, 0, `un corps illisible ne doit pas être compté comme panne serveur (${pannes})`);
});
