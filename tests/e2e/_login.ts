/** Connexion tolérante à la cadence : le serveur protège le mot de passe (rate limit partagé),
 *  un contexte d'essai qui se trompe de fenêtre d'attente ne doit pas rendre un faux négatif.
 *  Partagée par les specs qui ont besoin du back-office (admin, adaptivité de la modale). */
export async function login(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/admin');
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.getByLabel(/e-?mail/i).fill(email);
    await page.getByLabel(/mot de passe/i).fill(password);
    await page.getByRole('button', { name: /Entrer|Se connecter|Connexion/i }).click();
    const ok = await page.getByRole('link', { name: /Aujourd.hui/ }).first().waitFor({ state: 'visible', timeout: 12_000 }).then(() => true, () => false);
    if (ok) return;
    await page.waitForTimeout(4_000 * (attempt + 1));
  }
  throw new Error('connexion au back-office refusée après 4 tentatives (identifiants ou cadence)');
}
