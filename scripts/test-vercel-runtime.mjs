/** Régression du crash /var/task/server/app.ts : exécuter Node SANS tsx et SANS sources TS.
 * Précondition : npm run build. Base SQLite mémoire de test, aucun accès Supabase.
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = process.cwd();
assert.ok(existsSync('dist/server/app.cjs'), 'Lancer npm run build avant test:vercel');
assert.ok(existsSync('dist/client/index.html'), 'HTML de production absent');
const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
assert.equal(config.functions['api/index.ts'].includeFiles, 'dist/**');
assert.ok(!config.crons, 'ne pas réintroduire un cron incompatible Hobby');
assert.ok(config.rewrites.some(r => r.source === '/(.*)' && r.destination === '/api/index'), 'Les routes /api/public/* et /api/admin/* doivent atteindre la fonction');
mkdirSync('.scratch', { recursive: true });
const stage = mkdtempSync(resolve('.scratch/vercel-runtime-'));
try {
  mkdirSync(join(stage, 'api'), { recursive: true });
  cpSync('dist', join(stage, 'dist'), { recursive: true });
  symlinkSync(resolve('node_modules'), join(stage, 'node_modules'), 'dir');
  writeFileSync(join(stage, 'package.json'), '{"type":"module"}');
  // Comme le compilateur Vercel : transforme uniquement l'entrée TS en JS, sans bundler l'import.
  await build({ entryPoints: ['api/index.ts'], outfile: join(stage, 'api/index.js'), platform: 'node', target: 'node20', format: 'esm', bundle: false, logLevel: 'silent' });
  assert.ok(!existsSync(join(stage, 'server')), 'le test ne doit pas emporter server/*.ts');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    import { readdirSync } from 'node:fs';
    import handler from './api/index.js';
    const server = createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    let count = 0;
    const check = (ok, message) => { assert.ok(ok, message); count++; };
    try {
      const health = await fetch(base + '/healthz');
      check(health.status === 200 && (await health.json()).ok, 'GET /healthz sous Node natif');
      const html = await fetch(base + '/');
      check(html.status === 200 && (await html.text()).includes('<html'), 'HTML construit lisible dans dist/client');
      const asset = readdirSync('dist/client/assets').find(x => x.endsWith('.css'));
      check((await fetch(base + '/assets/' + asset)).status === 200, 'assets dist disponibles');
      const cfg = await fetch(base + '/api/public/config');
      const cfgBody = await cfg.json();
      check(cfg.status === 200 && cfgBody.payments.online === false, 'configuration publique sans Stripe');
      check(cfgBody.gallery.some(g => g.path === '/gallery/zyass-devanture-google.webp'), 'photo autorisée importée dans la configuration de production');
      const photo = await fetch(base + '/gallery/zyass-devanture-google.webp');
      check(photo.status === 200 && photo.headers.get('content-type').includes('image/webp'), 'photo WebP locale présente dans le bundle');
      const manifest = await fetch(base + '/manifest.webmanifest');
      check(manifest.status === 200 && (await manifest.json()).short_name === 'Z.YASS', 'manifeste indépendant des modèles actifs');
      check((await fetch(base + '/api/public/waitlist/offer?token=invalide')).status === 403, 'offre privée protégée sous Node natif');
      const login = await fetch(base + '/api/public/auth/password', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email:'owner@example.test', password:'test-vercel-password-2026'}) });
      check(login.status === 200, 'POST JSON via IncomingMessage');
      const cookie = login.headers.get('set-cookie');
      check(cookie && cookie.includes('zyass_session=') && cookie.includes('HttpOnly'), 'cookie Node standard sans res.append');
      const admin = await fetch(base + '/api/admin/settings', {headers: {cookie:cookie.split(';')[0]}});
      check(admin.status === 200, 'session owner réutilisable');
      check((await fetch(base + '/api/admin/settings')).status === 401, 'admin anonyme refusé');
      check((await fetch(base + '/api/public/seo/home')).status === 200, 'route SEO');
      check((await fetch(base + '/api/internal/cron')).status === 403, 'cron protégé');
      const cron = await fetch(base + '/api/internal/cron', {headers:{Authorization:'Bearer test-cron-vercel-2026'}});
      check(cron.status === 200, 'appel cron authentifié');
      const notFound = await fetch(base + '/page-absente-test-runtime');
      check(notFound.status === 404, '404 applicative, pas crash de fonction');
      console.log('✓ ' + count + '/16 contrôles runtime : aucun fichier source TS, aucun loader tsx, Node natif');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  `], {
    cwd: stage,
    env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'production', DEMO_MODE: '0', TEST_DB: 'memory', APP_ROOT: stage, DATABASE_URL: 'postgresql://test:test@unused.invalid/test', SESSION_SECRET: 'test-session-secret-vercel-2026-long', TOKEN_SECRET: 'test-token-secret-vercel-2026-long', CRON_SECRET: 'test-cron-vercel-2026', PAYMENTS_PROVIDER: 'off', APP_URL: 'https://example.test', BOOTSTRAP_OWNER_EMAIL: 'owner@example.test', BOOTSTRAP_OWNER_PASSWORD: 'test-vercel-password-2026', BOOTSTRAP_OWNER_NAME: 'Owner test' },
    encoding: 'utf8', timeout: 60_000,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  assert.equal(result.status, 0, result.error?.message ?? 'échec du runtime compilé');
} finally { rmSync(stage, { recursive: true, force: true }); }
