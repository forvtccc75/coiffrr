import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.TEST_DB = 'memory';
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = '0';

const password = 'test-password-long-2809';
const email = 'patron@example.test';

test('base vide : bootstrap initialise le salon et UN propriétaire, sans clients ni démo', async () => {
  const { ensureOwner } = await import('../server/lib/access.ts');
  const { db } = await import('../server/db/index.ts');
  const results = await Promise.all(Array.from({ length: 8 }, () => ensureOwner({ email, password, name: 'Patron' })));
  assert.equal(results.filter(x => x.status === 'created').length, 1);
  assert.equal(results.filter(x => x.status === 'skipped').length, 7);
  assert.equal(await db().num('SELECT count(*) FROM locations'), 1);
  assert.equal(await db().num('SELECT count(*) FROM users'), 1);
  for (const table of ['customers', 'appointments', 'staff', 'services', 'reviews', 'payments']) assert.equal(await db().num(`SELECT count(*) FROM ${table}`), 0, table);
  assert.ok(await db().num('SELECT count(*) FROM automations') > 0);
});

test('le mot de passe choisi donne un accès owner à /admin, jamais un compte Supabase Auth', async () => {
  const { createApp } = await import('../server/app.ts');
  const app = createApp();
  const r = await app.request('/api/public/auth/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  assert.equal(r.status, 200, await r.clone().text());
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  const settings = await app.request('/api/admin/settings', { headers: { cookie } });
  assert.equal(settings.status, 200);
});

test('bootstrap ne remplace ni ne multiplie les admins, même si une nouvelle adresse est configurée', async () => {
  const { ensureOwner } = await import('../server/lib/access.ts');
  const { db } = await import('../server/db/index.ts');
  const before = await db().one<any>('SELECT password_hash FROM users WHERE email = :e', { e: email });
  assert.equal((await ensureOwner({ email, password: 'different-password-123' })).status, 'skipped');
  assert.equal((await ensureOwner({ email: 'other@example.test', password })).status, 'skipped');
  assert.equal((await db().one<any>('SELECT password_hash FROM users WHERE email = :e', { e: email }))?.password_hash, before!.password_hash);
  assert.equal(await db().num('SELECT count(*) FROM users'), 1);
});

test('mot de passe faible refusé, admin désactivé jamais réactivé par un ancien bootstrap', async () => {
  const { ensureOwner } = await import('../server/lib/access.ts');
  const { db } = await import('../server/db/index.ts');
  assert.equal((await ensureOwner({ email, password: 'court' })).status, 'refused');
  await db().exec('UPDATE users SET is_active = 0');
  assert.equal((await ensureOwner({ email, password })).status, 'skipped');
  assert.equal(await db().num('SELECT is_active FROM users LIMIT 1'), 0);
});

test('reset explicite CLI révoque les sessions existantes et remplace uniquement le mot de passe owner', async () => {
  const { ensureOwner } = await import('../server/lib/access.ts');
  const { db } = await import('../server/db/index.ts');
  const { verifyPassword } = await import('../server/lib/secrets.ts');
  const next = 'nouveau-password-789';
  assert.equal((await ensureOwner({ email, password: next, allowPasswordChange: true })).status, 'updated');
  const user = await db().one<any>('SELECT * FROM users WHERE email = :e', { e: email });
  assert.ok(verifyPassword(next, user.password_hash));
  assert.equal(await db().num('SELECT count(*) FROM sessions WHERE revoked_ts IS NULL'), 0);
  assert.equal((await ensureOwner({ email: 'absent@example.test', password, allowPasswordChange: true })).status, 'refused');
});
