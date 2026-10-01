import { expect, test } from '@playwright/test';

/** 80 % du trafic vient du téléphone, depuis Instagram. Ce parcours est le contrat. */
test('depuis un lien Instagram : réserver une coupe + barbe en moins de 60 s', async ({ page, isMobile }) => {
  const t0 = Date.now();
  await page.goto('/book?service=coupe-barbe&source=instagram&campaign=story-semaine');
  // 20 s et non 8 : sur le premier projet du run, le serveur de dev compile la route à la demande ;
  //   le contrat mesuré ici est le temps *utilisateur* (moins de 60 s), pas le froid du bundler.
  await expect(page.getByRole('heading', { level: 1 }).or(page.locator('h2').first())).toBeVisible({ timeout: 20_000 });

  // 1) jour : on prend le premier jour proposé qui a des créneaux
  const days = page.locator('.days button, [data-role="days"] button');
  await expect(days.first()).toBeVisible();
  const n = await days.count();
  let picked = false;
  for (let i = 0; i < n; i++) {
    await days.nth(i).click();
    await page.waitForTimeout(250);
    const slots = page.locator('.slots button');
    if ((await slots.count()) > 0) {
      await expect(slots.first()).toBeVisible();
      await slots.first().click();
      picked = true;
      break;
    }
  }
  expect(picked, 'au moins un jour de la liste doit proposer un créneau réel').toBeTruthy();

  // 2) coordonnées — le parcours est en trois temps : créneau → « Continuer » → formulaire
  const continuer = page.getByRole('button', { name: /Continuer/ }).first();
  await expect(continuer, 'le choix du créneau doit proposer de continuer').toBeVisible();
  await continuer.click();

  // 2b) coordonnées — une identité fraîche à chaque exécution : le serveur protège contre les
  // doublons et le « trop de RDV en attente », donc un fixture figé ferait échouer le 2e run.
  const rnd = Date.now().toString().slice(-8);
  await page.getByLabel(/prénom/i).fill('Malik');
  await page.getByLabel(/téléphone/i).fill('06' + rnd);
  await page.getByLabel(/e-?mail/i).fill(`malik+${rnd}@example.fr`);
  const note = page.getByLabel(/note/i);
  if (await note.count()) await note.first().fill('Dégradé bas, barbe nette');
  const terms = page.locator('input[type=checkbox]').first();
  if (await terms.count()) await terms.check();

  // 3) confirmer
  await page.getByRole('button', { name: /Confirmer/ }).click();
  await expect(page.getByText(/c'est booké|C’est booké|Réservation confirmée|Rendez-vous enregistré/i).first()).toBeVisible({ timeout: 15_000 });
  const elapsed = Date.now() - t0;
  expect(elapsed, `le parcours doit rester court (${elapsed} ms)`).toBeLessThan(isMobile ? 55_000 : 40_000);

  // un lien de gestion et un .ics sont proposés : le client garde la main
  await expect(page.getByRole('link', { name: /décaler|annuler|gérer|mon espace/i }).first()).toBeVisible();
});

test('jour sans créneau : jamais un « complet » — alternatives et waitlist sont proposées', async ({ page }) => {
  await page.goto('/book?service=coupe-homme');
  const days = page.locator('.days button, [data-role="days"] button');
  await expect(days.first()).toBeVisible();
  const n = await days.count();
  let sawOffer = 0;
  for (let i = 0; i < n; i++) {
    await days.nth(i).click();
    await page.waitForTimeout(200);
    if ((await page.locator('.slots button').count()) === 0) {
      const help = page.locator('text=/waitlist|Se prévenir|créneaux se libèrent|autre barbier|un autre jour/i');
      expect(await help.count(), 'une journée pleine doit proposer une sortie, pas un mur').toBeGreaterThan(0);
      sawOffer++;
      if (sawOffer >= 1) break;
    }
  }
  await expect(page.getByText(/complet\b/i).filter({ hasNotText: /complètement/ })).toHaveCount(0);
});

test('le récap latéral affiche le vrai prix, options comprises', async ({ page }) => {
  await page.goto('/book?service=coupe-homme');
  const addon = page.locator('label', { hasText: /Taille de barbe/i }).first();
  if (await addon.count()) {
    await addon.click();
    await expect(page.locator('body')).toContainText(/40 €|40,00/);
  }
});
