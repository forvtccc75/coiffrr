import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const MOD = `${repo}server/lib/env.ts`;
const SCRIPT = 'import(process.argv[1]).then((m) => console.log(JSON.stringify({ isProd: m.env.isProd, demo: m.env.demo })))';

/** Le module `env` se fige à l'import : on ne peut pas le tester en changeant process.env dans le
    process courant. On relance donc un mini-process avec l'environnement demandé — et rien d'autre
    (les variables héritées du shell fausseraient la mesure). */
function lire(set: Record<string, string>, script = SCRIPT, mod = MOD) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  for (const k of ['NODE_ENV', 'DEMO_MODE', 'IS_PROD', 'DATABASE_URL', 'DATA_FILE']) if (process.env[k]) delete process.env[k];
  // Une URL factice : `env.ts` ne se connecte pas, mais il refuse une production sans base — et c'est
  // exactement le garde qu'on vérifie au test 4, donc il faut pouvoir le neutraliser ici.
  Object.assign(
    env,
    {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://u:p@h:5432/db',
      SESSION_SECRET: 'a'.repeat(40),
      TOKEN_SECRET: 'b'.repeat(40),
      CRON_SECRET: 'c'.repeat(24),
    },
    set,
  );
  const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', script, mod], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `mini-process en échec : ${r.stderr.slice(0, 300)}`);
  return JSON.parse(r.stdout.trim());
}

test('NODE_ENV=production éteint le mode démo sans qu’on ait à y penser', () => {
  const prod = lire({ NODE_ENV: 'production' });
  assert.equal(prod.isProd, true, 'NODE_ENV=production doit faire isProd');
  assert.equal(prod.demo, false, 'le mode démo (logins de démo, seed, notifications stdout) ne doit pas rester allumé en production par simple oubli');
  const dev = lire({});
  assert.equal(dev.demo, true, 'en dev, la démo reste le comportement par défaut : sinon `npm run dev` sort une base vide');
});

test('DEMO_MODE reste un ordre explicite, dans les deux sens', () => {
  assert.equal(lire({ NODE_ENV: 'production', DEMO_MODE: '1' }).demo, true, 'un staging de démo assumé doit pouvoir forcer le mode démo');
  assert.equal(lire({ NODE_ENV: 'development', DEMO_MODE: '0' }).demo, false, 'DEMO_MODE=0 éteint la démo même en dev');
});

test('IS_PROD=1 compte comme une mise en production', () => {
  const e = lire({ NODE_ENV: 'development', IS_PROD: '1' });
  assert.equal(e.isProd, true, 'IS_PROD doit être compris comme un ordre de mise en production');
  assert.equal(e.demo, false, 'et donc éteindre la démo');
});

test('une production sans DATABASE_URL meurt au lieu de servir SQLite', () => {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production' };
  const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', SCRIPT, MOD], { cwd: repo, env, encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'le démarrage doit échouer franchement plutôt que de tourner sur un fichier SQLite éphémère');
  assert.match(r.stderr, /DATABASE_URL/, `message attendu à propos de DATABASE_URL, reçu : ${r.stderr.slice(0, 200)}`);
});

const SCRIPT_IP =
  "import(process.argv[1]).then((m) => { const h = new Headers({ 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '8.8.8.8' });" +
  " console.log(JSON.stringify({ ip: m.clientIp({ headers: h }) })); })";
const SEC = `${repo}server/lib/security.ts`;

test('TRUST_PROXY=0 : la limite ne se contourne plus en fabriqueant un en-tête X-Forwarded-For', () => {
  // Le rate limiting est indexé sur l IP. Si l app fait confiance à X-Forwarded-For sans proxy de
  // confiance, un attaquant change d IP a chaque requete et franchit les 429 — le mode deploye (Vercel)
  // ecrase cet en-tete, donc la confiance est justifiee ; mais TRUST_PROXY=0 doit vraiment la couper.
  const trust = lire({}, SCRIPT_IP, SEC);
  assert.equal(trust.ip, '9.9.9.9', 'par defaut (derriere un proxy), X-Forwarded-For fait foi');
  const strict = lire({ TRUST_PROXY: '0' }, SCRIPT_IP, SEC);
  assert.equal(strict.ip, 'local', 'TRUST_PROXY=0 doit ignorer x-forwarded-for ET x-real-ip');
});
