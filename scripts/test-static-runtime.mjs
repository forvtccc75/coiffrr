/** Artefact Vercel, Node natif : le backend échoue volontairement, les fichiers restent lisibles. */
import { build } from 'esbuild';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
mkdirSync('.scratch', { recursive: true });
const stage = mkdtempSync(resolve('.scratch/static-runtime-'));
const original = process.cwd(); let server; let count = 0;
const check = (value, label) => { assert.ok(value, label); count++; };
try {
  cpSync('dist/client', join(stage, 'dist/client'), { recursive: true });
  mkdirSync(join(stage, 'dist/server'), { recursive: true });
  cpSync('dist/server/static.cjs', join(stage, 'dist/server/static.cjs'));
  writeFileSync(join(stage, 'dist/server/app.cjs'), "exports.bootstrap=async()=>{throw new Error('TEST: backend indisponible');};");
  writeFileSync(join(stage, 'package.json'), '{"type":"module"}');
  await build({entryPoints:['api/index.ts'], outfile:join(stage,'api/index.js'), platform:'node', format:'esm', target:'node20', bundle:false, logLevel:'silent'});
  process.chdir(stage);
  const { default: handler } = await import(join(stage, 'api/index.js'));
  server = createServer(handler); await new Promise(r => server.listen(0,'127.0.0.1',r));
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const path of ['/', '/book', '/waitlist', '/galerie', '/infos', '/tarifs', '/faq', '/espace', '/admin', '/rdv/1', '/waitlist?token=private-test']) {
    const r = await fetch(base + path);
    check(r.status === 200 && r.headers.get('content-type').includes('text/html'), path + ' sans backend');
    check(/no-cache|no-store/.test(r.headers.get('cache-control')), 'HTML jamais figé : ' + path);
    if (/token=/.test(path)) check(r.headers.get('referrer-policy') === 'no-referrer', 'lien privé protégé');
  }
  for (const name of readdirSync('dist/client/assets').filter(n => /\.(js|css)$/.test(n))) {
    const r = await fetch(base + '/assets/' + name);
    check(r.status === 200 && !r.headers.get('content-type').includes('html') && /immutable/.test(r.headers.get('cache-control')), 'fichier valide : ' + name);
  }
  check((await fetch(base + '/gallery/zyass-devanture-google.webp')).status === 200, 'photo indépendante de la DB');
  const missing = await fetch(base + '/assets/book-inexistant.js');
  check(missing.status === 404 && !missing.headers.get('content-type').includes('html') && missing.headers.get('cache-control') === 'no-store', 'module absent : vrai 404, pas HTML 200 ni cache annuel');
  const head = await fetch(base + '/book', { method: 'HEAD' });
  check(head.status === 200 && (await head.text()) === '', 'HEAD correct');
  const traversal = await fetch(base + '/assets/..%2f..%2fserver/app.cjs');
  check(traversal.status === 404, 'aucune sortie du répertoire public');
  const api = await fetch(base + '/api/public/config');
  check(api.status === 503 && (await api.json()).error === 'server_unavailable', 'vraie indisponibilité API, pas faux succès');
  check((await fetch(base + '/book')).status === 200, 'navigation encore disponible après échec API');
  const vercel = JSON.parse(readFileSync(join(original,'vercel.json'), 'utf8'));
  check(!(vercel.headers ?? []).some(r => r.source.startsWith('/assets/')), 'pas de règle Vercel qui mettrait aussi les erreurs en cache immutable');
  console.log(`✓ ${count}/${count} contrôles statiques, backend volontairement en panne, zéro accès Supabase`);
} finally { if(server) await new Promise(r=>server.close(r)); process.chdir(original); rmSync(stage, {recursive:true,force:true}); }
