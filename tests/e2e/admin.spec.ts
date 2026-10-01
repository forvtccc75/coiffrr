import { expect, test } from '@playwright/test';
import { login } from './_login.ts';

test('back-office : connexion, vue du jour, file de récupération', async ({ page }) => {
  await login(page, 'owner@zyass.fr', 'demo-owner');
  // le shell du back-office : nav « Aujourd'hui » active + panneau du jour (titre = jour de la semaine)
  await expect(page.locator('h1, h2, h3').filter({ hasText: /lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|Espace salon|Planning/i }).first()).toBeVisible();
  await expect(page.locator('table, .card, .tile').first()).toBeVisible();
  await page.getByRole('link', { name: /Files|Waitlist|Récupération/i }).first().click();
  await expect(page.locator('table, .card, .tile').first()).toBeVisible();
});

test('un barbier ne voit pas les réglages du salon', async ({ page }) => {
  await login(page, 'mehdi@zyass.fr', 'demo-staff');
  // l'entrée n'est pas offerte à un rôle sans droit…
  await expect(page.getByRole('link', { name: /Réglages/i })).toHaveCount(0);
  // …et forcer l'URL renvoie le refus du serveur, pas un écran de réglages vide.
  await page.goto('/admin/settings');
  await expect(page.locator('body')).toContainText(/droits|insuffisant|non autorisé/i);
  await expect(page.getByRole('button', { name: /Horaires|Médias/i })).toHaveCount(0);
});
