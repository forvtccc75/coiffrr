import { test, expect } from '@playwright/test';

test('les métadonnées suivent une navigation sans rechargement', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation').getByRole('link', { name: 'Tarifs', exact: true }).click();
  await expect(page).toHaveTitle(/Tarifs coupe et barbe/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/tarifs$/);
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', /\/tarifs$/);
  await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(1);
});

test('page barbier sur son URL canonique : profil visible et titre spécifique', async ({ page, request }) => {
  const cfg = await (await request.get('/api/public/config')).json();
  test.skip(!cfg.staff?.length, 'salon non configuré');
  const st = cfg.staff[0];
  await page.goto('/barbier/' + st.slug);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(st.name);
  await expect(page).toHaveTitle(new RegExp(st.name));
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp('/barbier/' + st.slug + '$'));
});

test('espace personnel non indexable dans le navigateur', async ({ page }) => {
  await page.goto('/espace');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
});

test('sans paiement en ligne, la carte cadeau propose le comptoir, pas un checkout', async ({ page, request }) => {
  const cfg = await (await request.get('/api/public/config')).json();
  test.skip(cfg.payments?.online !== false, 'configuration sans paiement en ligne requise');
  await page.goto('/cartes-cadeaux');
  await expect(page.getByRole('heading', { name: 'À retirer et régler au salon' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Appeler le salon' })).toBeVisible();
  await expect(page.locator('form')).toHaveCount(0);
});
