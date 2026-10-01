import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Ces deux contrôles existent parce qu'un défaut invisible en test unitaire a rendu le site
 * inutilisable : `renderToStaticMarkup` laisse le composant dans son état « chargement », donc
 * l'erreur levée APRÈS hydratation (session absente, chunk périmé) ne passait que dans le
 * navigateur. Mesuré le 28/09/2026 : `/espace` affichait 0 caractère et deux requêtes 401 en
 * console — une page noire sans issue pour le client.
 */

test("/espace : un visiteur sans session voit l'écran de connexion, pas le vide", async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e)));
  await page.goto('/espace');
  await expect(page.getByRole('heading', { name: /Mon espace/i })).toBeVisible();
  // le champ est là, étiqueté, et le formulaire est utilisable au clavier comme au pouce
  const champ = page.getByLabel(/Téléphone ou e-?mail/i);
  await expect(champ).toBeVisible();
  await champ.fill('0612345678');
  // « Recevoir mon code », pas « Envoyer le code » : le libellé est celui vu par le client, et
  //   c'est lui que l'accessibilité annonce. Le bouton est désactivé tant que le numéro n'est
  //   pas saisissable — d'où le remplissage ci-dessus avant de vérifier qu'il s'active.
  await expect(page.getByRole('button', { name: /Recevoir mon code/i })).toBeEnabled();
  // aucune donnée personnelle d'un tiers dans ce HTML (le visiteur n'est connecté à rien)
  await expect(page.locator('#root')).not.toContainText(/fréquentation|chiffre d'affaires/i);
  expect(errors, `erreurs JavaScript : ${errors.join(' | ')}`).toEqual([]);
});

test('un morceau de JS introuvable affiche la page de secours, jamais un fond noir', async ({ page }) => {
  // Cas réel : le visiteur a ouvert le site avant un déploiement, ses fichiers hachés ne existent plus.
  //   Les écrans sont chargés à la demande (React.lazy) : si l'import de la route échoue, c'est le
  //   filet de rendu qui doit parler. Le motif couvre les deux modes — `admin-<hash>.js` au build,
  //   `admin.tsx` sous Vite — et ne touche que les requêtes de scripts (les XHR /admin/* doivent passer).
  await page.route('**/*', (route) => {
    const req = route.request();
    const u = req.url();
    if (req.resourceType() === 'script' && /admin[-.]/.test(u)) return route.abort();
    return route.continue();
  });
  await page.goto('/admin');
  await expect(page.getByText(/Cet écran n.a pas pu s-afficher|Ce n.est pas toi, c.est nous/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /R.essayer/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /Réserver un créneau/i })).toBeVisible();
  // et le site reste vivant autour de la panne : la navigation reprend le dessus
  await page.getByRole('link', { name: /Réserver un créneau/i }).click();
  await expect(page).toHaveURL(/\/book/);
  await expect(page.getByRole('heading', { name: /Réserver/i })).toBeVisible();
});

test('sans JavaScript, la page pré-rendue reste lisible et complète', async ({ browser }) => {
  // Le reveal au scroll masque les sections par opacité : le garde-fou veut que ce masque ne
  // s'applique JAMAIS sans JavaScript (la classe `html.js-rv` est posée par le code). Ce contrôle est
  // la preuve que la vitrine reste imprimable, crawlable et lisible sur un réseau mort — et qu'aucune
  // animation n'a été payée au prix d'un contenu invisible.
  // On mesure l'artefact livré, pas le serveur de dev : `dist/client/index.html` est le HTML
  // pré-rendu que Vercel sert avant toute hydratation. Sans build, rien à mesurer — le contrôle
  // le dit au lieu de passer sur un shell vide de Vite qui ne pré-rend jamais.
  const file = path.join(process.cwd(), 'dist', 'client', 'index.html');
  test.skip(!fs.existsSync(file), 'aucun build dans dist/ : lancer `npm run build` avant ce contrôle');
  const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 }, locale: 'fr-FR' });
  const page = await ctx.newPage();
  await page.goto('file://' + file, { waitUntil: 'load' });
  const txt = (await page.locator('#root').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  expect(txt.length, 'le pré-rendu doit remplir la page, pas laisser une coquille').toBeGreaterThan(600);
  expect(txt).toMatch(/Réserver/i);
  const masques = await page.evaluate(() => {
    const g = globalThis as any;
    return Array.from(g.document.querySelectorAll('.rv')).filter((n: any) => Number(g.getComputedStyle(n).opacity) < 0.9).length;
  });
  expect(masques, 'des sections sont masquées alors que le JavaScript est éteint').toBe(0);
  await ctx.close();
});
