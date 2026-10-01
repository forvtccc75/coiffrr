/** Test destructif UNIQUEMENT du carnet SQLite en mémoire lancé en mode setup isolé.
 * TEST_DB=memory DEMO_MODE=0 BOOTSTRAP_OWNER_EMAIL=setup@example.test
 * BOOTSTRAP_OWNER_PASSWORD=isolated-browser-test-2026 PAYMENTS_PROVIDER=off npm run dev
 */
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
mkdirSync('.shots', { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'fr-FR' });
const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
let passed = 0; const ok = text => { passed++; console.log(`✓ ${text}`); };
try {
  const health = await (await page.request.get('http://127.0.0.1:8787/healthz')).json();
  if (health.dialect !== 'sqlite' || health.demo) throw new Error('Refus : il faut la base SQLite isolée NON-démo.');
  await page.goto('http://127.0.0.1:5173/book');
  await expect(page.getByRole('heading', { name: 'La réservation en ligne arrive bientôt.' })).toBeVisible(); ok('catalogue vide : message honnête et contact');
  await page.route('**/api/public/config', r => r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"test erreur"}' }));
  await page.reload(); await expect(page.getByRole('heading', { name: 'Les créneaux ne sont pas accessibles.' })).toBeVisible(); ok('erreur API : pas de chargement infini');
  await page.unroute('**/api/public/config'); await page.getByRole('button', { name: 'Réessayer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'La réservation en ligne arrive bientôt.' })).toBeVisible(); ok('réessayer recharge la configuration partagée');
  await page.setViewportSize({ width: 320, height: 568 }); await page.screenshot({ path: '.shots/booking-preparation-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy(); ok('réservation vide en 320 px : pas de débordement');
  await page.goto('http://127.0.0.1:5173/infos');
  await expect(page.getByRole('row').filter({ hasText: 'Lundi' })).toContainText('09:30–20:00'); await expect(page.getByRole('row').filter({ hasText: 'Dimanche' })).toContainText('Fermé');
  expect(await page.locator('a[href*="14672622159112713981"]').count()).toBeGreaterThan(0); ok('horaires lundi/dimanche et lien Google exact');
  await page.setViewportSize({ width: 1280, height: 900 }); await page.goto('http://127.0.0.1:5173/admin');
  await page.getByLabel('E-mail', { exact: true }).fill('setup@example.test'); await page.getByLabel('Mot de passe', { exact: true }).fill('isolated-browser-test-2026'); await page.getByRole('button', { name: 'Entrer', exact: true }).click();
  await page.getByRole('link', { name: 'Réglages', exact: true }).click(); await page.getByRole('button', { name: 'Préparer les modèles privés' }).click();
  await expect(page.getByLabel('Nom de la prestation', { exact: true })).toHaveCount(5); ok('admin : 4 modèles privés + formulaire d’ajout');
  let form = page.locator('form').filter({ has: page.getByLabel('Nom de la prestation', { exact: true }) }).first();
  await form.getByLabel('Prix (€)', { exact: true }).fill('23'); await form.getByLabel('Description courte').fill('Prestation de validation dans une base isolée.'); await form.getByLabel('Publier cette prestation — prix et durée validés').check(); await form.getByRole('button', { name: 'Enregistrer la prestation' }).click();
  await expect(page.getByText('Prestation publiée.', { exact: true })).toBeVisible(); ok('édition du vrai prix et activation d’une prestation dans la base test');
  await page.getByRole('button', { name: 'Équipe', exact: true }).click();
  await expect(page.getByLabel('Nom public du barbier')).toHaveCount(4);
  form = page.locator('form').filter({ has: page.getByLabel('Nom public du barbier') }).first();
  await form.getByLabel('Nom public du barbier').fill('Barbier test isolé'); await form.getByLabel('Activer ce vrai barbier pour les réservations').check(); await form.getByRole('button', { name: 'Enregistrer le barbier' }).click();
  await expect(page.getByText('Barbier activé.', { exact: true })).toBeVisible(); ok('profils inactifs visibles et éditables');
  await page.screenshot({ path: '.shots/admin-equipe.png', fullPage: true });
  const cfg = await (await page.request.get('http://127.0.0.1:5173/api/public/config')).json(); expect(cfg.services).toHaveLength(1); expect(cfg.staff).toHaveLength(1); ok('seuls les modèles explicitement activés deviennent publics');
  await page.goto('http://127.0.0.1:5173/book'); await expect(page.getByText('Choisis ta prestation', { exact: false })).toBeVisible().catch(async () => { await expect(page.getByText('Coupe homme', { exact: true }).first()).toBeVisible(); });
  expect(await page.getByText('La réservation en ligne arrive bientôt.', { exact: true }).count()).toBe(0); ok('réservation ouverte après validation catalogue + équipe');
  const avail = await (await page.request.get('http://127.0.0.1:5173/api/public/availability?service=' + cfg.services[0].key + '&days=7')).json(); expect(avail.days.some(d => d.slots.length)).toBeTruthy(); ok('créneaux réels calculés après activation');
  await page.locator('button.svc').first().click();
  await page.locator('button.day').filter({ hasText: /créx/ }).first().click();
  await expect(page.locator('button.slot').first()).toBeVisible(); await page.locator('button.slot').first().click();
  await page.getByRole('button', { name: 'Continuer', exact: true }).first().click();
  await page.getByLabel('Prénom', { exact: true }).fill('Testisolé'); await page.getByLabel('Téléphone', { exact: true }).fill('0677779988');
  await page.getByLabel('E-mail (facultatif)', { exact: true }).fill('parcours@example.test');
  await page.getByRole('checkbox', { name: /J'accepte que le salon me contacte/ }).check();
  await page.getByRole('button', { name: /Confirmer —/ }).click();
  await expect(page.getByRole('heading', { name: "C'est booké ✔" })).toBeVisible();
  await page.screenshot({ path: '.shots/booking-confirmation-isolee.png', fullPage: true }); ok('réservation complète en navigateur : prestation, créneau, coordonnées, confirmation sans paiement en ligne');
  const logo = await page.request.get('http://127.0.0.1:5173/brand/logo.png'); expect(logo.status()).toBe(200); expect((await page.request.get('http://127.0.0.1:5173/favicon.ico')).status()).toBe(200); ok('logo et favicon servis');
  expect(errors).toEqual([]); ok('aucune exception JavaScript');
  console.log(`${passed}/${passed} contrôles navigateur Chromium. Aucune écriture dans Supabase.`);
} finally { await browser.close(); }
