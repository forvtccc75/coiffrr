/** Navigation sur les VRAIS chunks de production (pas Vite dev).
 * Fixtures mémoire : aucune réservation/activation dans Supabase. */
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
process.env.TEST_DB = 'memory'; process.env.DEMO_MODE = '0'; process.env.NODE_ENV = 'test';
process.env.PAYMENTS_PROVIDER = 'off';
mkdirSync('.shots', {recursive:true});
// L'import relatif du bundle doit rester ../dist/... comme dans l'entrée Vercel.
const adapter = resolve('api/.navigation-test.mjs');
await build({entryPoints:['api/index.ts'], outfile:adapter, platform:'node', format:'esm', target:'node20', bundle:false, logLevel:'silent'});
const { default: handler } = await import(adapter);
const server = createServer(handler); await new Promise(r => server.listen(0,'127.0.0.1',r));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({headless:true}); let count = 0;
const ok = label => { count++; console.log('✓ ' + label); };
try {
  const context = await browser.newContext({viewport:{width:1280,height:900}});
  const page = await context.newPage(); const errors = []; const failed = [];
  page.on('pageerror', e=>errors.push(e.message)); page.on('response', r=>{ if(r.status()>=400 && /\/assets\//.test(r.url())) failed.push(r.url()); });
  await page.goto(base, {waitUntil:'networkidle'});
  const links = await page.locator('main a[href^="/"]').evaluateAll(els=>[...new Set(els.map(e=>e.getAttribute('href')))]);
  for (const href of links) {
    await page.goto(base, {waitUntil:'networkidle'});
    await page.locator(`main a[href=${JSON.stringify(href)}]`).first().click();
    await expect(page).toHaveURL(base + href);
    await expect(page.locator('main h1, main h2').first()).toBeVisible();
    await expect(page.getByText('Cet écran n’a pas pu s’afficher')).toHaveCount(0);
    ok('accueil → ' + href);
  }
  await page.setViewportSize({width:320,height:568}); await page.goto(base, {waitUntil:'networkidle'});
  await page.locator('main .actions a').first().click();
  await expect(page.getByRole('heading',{name:'La réservation en ligne arrive bientôt.'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  ok('bouton principal mobile 320 px et écran réservation sans débordement');
  expect(errors).toEqual([]); expect(failed).toEqual([]); ok('aucune exception JS ni asset refusé en navigation normale');
  await context.close();

  // Un premier 503 sur un vrai import dynamique : reload unique, query/hash conservés.
  const retry = await browser.newContext(); const rp = await retry.newPage(); let failures = 0; let documents = 0;
  rp.on('request', r=>{if(r.isNavigationRequest() && r.frame()===rp.mainFrame()) documents++;});
  await retry.route('**/assets/book-*.js', route => ++failures === 1 ? route.fulfill({status:503,contentType:'application/json',body:'{"error":"test"}'}) : route.continue());
  await rp.goto(base + '/book?source=test#choisir');
  await expect(rp.getByRole('heading',{name:'La réservation en ligne arrive bientôt.'})).toBeVisible();
  expect(documents).toBe(2); expect(new URL(rp.url()).searchParams.get('source')).toBe('test'); expect(new URL(rp.url()).hash).toBe('#choisir');
  ok('module 503 temporaire : un rechargement récupère la route sans perdre query/hash');
  await retry.close();

  // Erreur persistante : pas de boucle ; Réessayer repart de zéro après rétablissement.
  const persistent = await browser.newContext(); const pp = await persistent.newPage(); let blocked = true; let navigations = 0;
  pp.on('request', r=>{if(r.isNavigationRequest() && r.frame()===pp.mainFrame()) navigations++;});
  await persistent.route('**/assets/book-*.js', route => blocked ? route.fulfill({status:404,contentType:'text/plain',body:'introuvable'}) : route.continue());
  await pp.goto(base + '/book');
  await expect(pp.getByText('Cet écran n’a pas pu s’afficher')).toBeVisible();
  await pp.waitForTimeout(1200); expect(navigations).toBe(2);
  await expect(pp.getByRole('link',{name:'Appeler le salon',exact:true})).toBeVisible();
  ok('module absent : arrêt après un seul rechargement automatique, contact accessible');
  blocked = false;
  await pp.getByRole('button',{name:'Réessayer',exact:true}).click();
  await expect(pp.getByRole('heading',{name:'La réservation en ligne arrive bientôt.'})).toBeVisible();
  expect(navigations).toBe(3); ok('Réessayer récupère vraiment un import auparavant rejeté');
  await pp.screenshot({path:'.shots/booking-apres-recuperation.png',fullPage:true});
  await persistent.close();

  // Backend indisponible : interface et liens disponibles, pas de succès métier inventé.
  const offline = await browser.newContext(); const op = await offline.newPage();
  await offline.route('**/api/**', r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"test","message":"Planning indisponible"}'}));
  await op.goto(base); await op.getByRole('link',{name:'Réserver un créneau',exact:true}).first().click();
  await expect(op.getByRole('heading',{name:'Les créneaux ne sont pas accessibles.'})).toBeVisible();
  await expect(op.getByRole('link',{name:/Appeler/}).first()).toBeVisible();
  ok('panne API : bouton actif, erreur honnête et appel au salon, pas de page cassée');
  await offline.close();
  console.log(`${count}/${count} contrôles Chromium sur les fichiers compilés. Aucun accès Supabase.`);
} finally { await browser.close(); server.closeAllConnections(); await new Promise(r=>server.close(r)); rmSync(adapter,{force:true}); }
