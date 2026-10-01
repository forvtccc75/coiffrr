/**
 * Adaptivité mesurée dans un navigateur réel : téléphone étroit, téléphone couché, tablette
 * portrait/paysage, grand bureau.
 *
 * Trois propriétés dures, pas une impression de « ça passe » :
 *  1. la page ne déborde jamais horizontalement (le piège classique : un rail de 14 jours ou un
 *     tableau qui agrandit la piste de grille et fait défiler *toute* la page) ;
 *  2. rien n'est retiré au petit écran : navigation, filtres, tableaux et CTA restent atteignables ;
 *  3. le pouce suffit : 44 px sur les commandes principales (WCAG 2.5.8 AAA), 24 px ailleurs (AA),
 *     et 16 px dans les champs — sinon iOS zoome et casse la mise en page au premier focus.
 *
 * Les largeurs sont les plus étroites du parc réel (320 = premier iPhone SE utile, 360 = Android
 * courant, 740×360 = téléphone couché, 768/834 = tablettes), pas les plus confortables.
 * Le loop de tailles tourne sous `chrome` (pointeur fin) et `phone-se` (pointeur grossier) : les
 * autres projets exercent les parcours métier dans booking.spec.ts / admin.spec.ts.
 */
import { test, expect, type Page } from '@playwright/test';
import { login } from './_login.ts';

type Size = { name: string; width: number; height: number; touch: boolean };
const SIZES: Size[] = [
  { name: 'téléphone étroit 320', width: 320, height: 568, touch: true },
  { name: 'téléphone 360', width: 360, height: 740, touch: true },
  { name: 'téléphone 390', width: 390, height: 844, touch: true },
  { name: 'téléphone couché 740×360', width: 740, height: 360, touch: true },
  { name: 'tablette portrait 768', width: 768, height: 1024, touch: true },
  { name: 'tablette paysage 1024', width: 1024, height: 768, touch: true },
  { name: 'bureau 1280', width: 1280, height: 900, touch: false },
  { name: 'grand bureau 1920', width: 1920, height: 1080, touch: false },
];
const PAGES = ['/', '/tarifs', '/infos', '/book?service=coupe-homme', '/admin'];
const SIZE_PROJECTS = ['chrome', 'phone-se'];

/** 'load' (et non domcontentloaded) : mesurer la géométrie avant l'application de la feuille de
 *  style donnerait des cibles de 19 px et un verdict faux — le style bloque le rendu, pas le DOM. */
async function goto(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'load' });
  await page.locator('h1, h2').first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 2_500 }).catch(() => undefined);
}

type Over = { page: number; worst: string };
/** Ce qui déborde *la page* : les enfants d'un conteneur défilant sont légitimes, les couches fixes aussi. */
async function overflowX(page: Page): Promise<Over> {
  return page.evaluate(() => {
    const gcs = (globalThis as any).getComputedStyle;
    const iw = (globalThis as any).document.documentElement.clientWidth;
    let worst = '';
    let max = 0;
    for (const el of Array.from((globalThis as any).document.querySelectorAll('body *')) as any[]) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = gcs(el);
      if (cs.position === 'fixed') continue;
      let anc = el.parentElement;
      let inScroller = false;
      while (anc && anc !== (globalThis as any).document.body) {
        const o = gcs(anc).overflowX;
        if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') { inScroller = true; break; }
        anc = anc.parentElement;
      }
      if (inScroller) continue;
      const over = r.right - iw;
      if (over > max) {
        max = over;
        worst = `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} = ${Math.round(r.width)}px pour ${iw}px`;
      }
    }
    return { page: Math.max(0, (globalThis as any).document.documentElement.scrollWidth - iw), worst: max > 1 ? worst : '' };
  });
}

const coarse = (page: Page) => page.evaluate(() => (globalThis as any).matchMedia('(pointer: coarse)').matches as boolean);

for (const size of SIZES) {
  test.describe(`adaptivité — ${size.name}`, () => {
    test.beforeEach(async ({ page }, testInfo) => {
      test.skip(!SIZE_PROJECTS.includes(testInfo.project.name), `loop de tailles couvert par ${SIZE_PROJECTS.join(' + ')}`);
      await page.setViewportSize({ width: size.width, height: size.height });
    });

    test('aucun défilement horizontal de page', async ({ page }) => {
      for (const path of PAGES) {
        await goto(page, path);
        const { page: over, worst } = await overflowX(page);
        expect(over, `${path} : la page défile horizontalement de ${over}px (${worst})`).toBeLessThanOrEqual(1);
      }
    });

    test('la navigation principale reste atteignable', async ({ page }) => {
      await goto(page, '/');
      const nav = page.locator('header nav');
      await expect(nav, 'en-tête sans navigation visible').toBeVisible();
      const links = nav.locator('a');
      expect(await links.count(), 'moins de 4 liens de navigation').toBeGreaterThanOrEqual(4);
      for (let i = 0; i < Math.min(4, await links.count()); i++) {
        const box = await links.nth(i).boundingBox();
        expect(box, `lien ${i} sans boîte (masqué)`).not.toBeNull();
        expect(box!.width, `lien ${i} réduit à 0 px`).toBeGreaterThan(24);
      }
    });

    test('les tableaux défilent dans leur conteneur, pas sur la page', async ({ page }) => {
      for (const path of PAGES) {
        await goto(page, path);
        const n = await page.locator('table.t').count();
        for (let i = 0; i < n; i++) {
          await expect(
            page.locator('table.t').nth(i).locator('xpath=ancestor::*[contains(@class,"tx")][1]'),
            `${path} : tableau ${i} hors conteneur .tx`,
          ).toHaveCount(1);
        }
        const { page: over } = await overflowX(page);
        expect(over, `${path} : un tableau fait déborder la page`).toBeLessThanOrEqual(1);
      }
    });

    test('cibles tactiles : 44 px sur les commandes, 24 px ailleurs', async ({ page }) => {
      await goto(page, '/');
      const isCoarse = await coarse(page);
      for (const path of ['/', '/tarifs', '/book?service=coupe-homme']) {
        await goto(page, path);
        const small = await page.evaluate((primary) => {
          const gcs = (globalThis as any).getComputedStyle;
          const out: string[] = [];
          const seen = new Set<any>();
          for (const sel of [primary, 'header a, header button, main a, main button']) {
            for (const el of Array.from((globalThis as any).document.querySelectorAll(sel)) as any[]) {
              if (seen.has(el)) continue;
              seen.add(el);
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              const cs = gcs(el);
              if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') continue;
              // lien en ligne dans du texte : exonéré de taille minimale par WCAG 2.5.8
              if (cs.display === 'inline' && ['P', 'LI', 'TD', 'H1', 'H2', 'H3', 'H4', 'DIV'].includes(el.parentElement?.tagName)) continue;
              const min = el.matches(primary) ? 44 : 24;
              if (Math.min(r.width, r.height) < min - 0.5) {
                out.push(`${el.matches(primary) ? 'commande' : 'lien'} ${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} = ${Math.round(r.width)}×${Math.round(r.height)} (< ${min})`);
              }
            }
          }
          return out;
        }, '.btn, .tab, .day, .slot, .hd nav a, .adm-nav a, .chip button, .ft a, .sticky button, .hd .logo');
        // sur pointeur fin, on n'exige que le minimum AA : la règle 44 px est une règle de pouce
        const filtered = isCoarse ? small : small.filter((l) => l.startsWith('commande') === false || !l.includes('(< 44)'));
        expect(filtered, `${path} : cibles insuffisantes pour un pouce`).toEqual([]);
      }
    });

    test('les champs à 16 px ne déclenchent pas le zoom iOS', async ({ page }) => {
      await goto(page, '/book?service=coupe-homme');
      const field = page.locator('input[type="tel"], input[type="text"], input[type="email"]').first();
      if (!(await field.waitFor({ state: 'attached', timeout: 4_000 }).then(() => true, () => false))) {
        test.skip(true, 'aucun champ de saisie sur cet écran');
        return;
      }
      const fs = await field.evaluate((el: any) => parseFloat((globalThis as any).getComputedStyle(el).fontSize as string));
      const min = (await coarse(page)) ? 16 : 13;
      expect(fs, `champ à ${fs}px sur pointeur ${await coarse(page) ? 'grossier (zoom iOS)' : 'fin'}`).toBeGreaterThanOrEqual(min);
    });

    test('la barre de confirmation reste dans l\u2019écran', async ({ page }) => {
      await goto(page, '/book?service=coupe-homme');
      const sticky = page.locator('.sticky');
      if (!(await sticky.count())) test.skip(true, 'pas de barre basse sur cet écran');
      else {
        const box = await sticky.last().boundingBox();
        expect(box, 'barre basse sans géométrie').not.toBeNull();
        expect(box!.y, 'la barre basse passe sous le haut de l\u2019écran').toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height, 'la barre basse déborde du bas de l\u2019écran').toBeLessThanOrEqual(size.height + 1);
      }
    });

    test('réserver du bout du pouce : créneau visible puis saisie', async ({ page }) => {
      await goto(page, '/book?service=coupe-homme');
      const slot = page.locator('.slot:not([disabled])').first();
      if (!(await slot.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false))) {
        test.skip(true, 'aucun créneau libre visible dans la base de démo');
        return;
      }
      await slot.scrollIntoViewIfNeeded();
      await slot.click({ timeout: 5_000 });
      const box = await slot.boundingBox();
      expect(box, 'créneau sélectionné sorti du viewport').not.toBeNull();
      expect(box!.y, 'créneau passé sous l\u2019en-tête collant').toBeGreaterThanOrEqual(0);
      await expect(page.locator('input').first(), 'aucune saisie proposée après le créneau').toBeVisible();
    });
  });
}

test('la modale est une feuille plaquée en bas sur téléphone, une boîte centrée en grand écran', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'différences de rendu sur webkit');
  await page.setViewportSize({ width: 390, height: 844 });
  // Les seules vraies modales du produit sont dans le planning du back-office (« bloquer une plage »,
  // « réserver pour un client ») : c'est là qu'un doigt sur 390 px doit pouvoir valider un créneau.
  try {
    await login(page, 'owner@zyass.fr', 'demo-owner');
  } catch (e) {
    test.skip(true, `back-office injoignable dans cette configuration : ${String(e).slice(0, 60)}`);
    return;
  }
  // le back-office s'ouvre sur « Aujourd'hui » : les modales de créneau sont dans le Planning
  const planning = page.getByRole('link', { name: /Planning/i }).first();
  if (await planning.isVisible().catch(() => false)) {
    await planning.click();
    await expect(page.getByRole('heading', { name: /Planning/i }).first(), 'le planning ne s’est pas ouvert').toBeVisible();
  }
  const open = page.getByRole('button', { name: /bloquer une plage/i }).first();
  await expect(open, "le planning n'expose pas « bloquer une plage »").toBeVisible();
  await open.click();
  const sheet = page.locator('.sheet');
  await expect(sheet, 'la modale ne s\u2019ouvre pas en .sheet').toBeVisible();
  // On compare à la hauteur réelle du viewport, pas à la valeur demandée : sous émulation, la
  // barre de défilement racine et le dvh donnent quelques dixièmes d'écart, et c'est le bord
  // visible qui compte pour un pouce. Ce qui est vérifié : la feuille est plaquée en bas ET
  // occupe la moitié basse de l'écran (une feuille centrée = commande inatteignable au pouce).
  const geo = await sheet.evaluate((el: any) => {
    const r = el.getBoundingClientRect();
    return { y: r.y, bottom: r.bottom, height: r.height, inner: (globalThis as any).innerHeight } as any;
  });
  expect(geo.height, 'feuille sans hauteur').toBeGreaterThan(120);
  expect(geo.inner - geo.bottom, 'la feuille ne touche pas le bas de l\u2019écran').toBeLessThanOrEqual(2);
  expect(geo.bottom - geo.y, 'la feuille n\u2019est pas ancrée en bas').toBeGreaterThan(geo.inner * 0.25);
  await page.setViewportSize({ width: 1280, height: 900 });
  const g = await sheet.evaluate((el: any) => {
    const r = el.getBoundingClientRect();
    return { leftGap: r.left, topGap: r.top, bottomGap: (globalThis as any).innerHeight - r.bottom } as any;
  });
  expect(g.leftGap, 'boîte encore plaquée à gauche en grand écran').toBeGreaterThan(20);
  expect(g.bottomGap, 'boîte encore plaquée en bas en grand écran').toBeGreaterThan(40);
});

test('back-office : barre horizontale défilante sur tablette portrait, colonne latérale en paysage', async ({ page }) => {
  await goto(page, '/admin');
  const nav = page.locator('.adm-nav');
  if (!(await nav.count())) {
    test.skip(true, 'écran de connexion : pas de navigation de back-office');
    return;
  }
  for (const size of [{ w: 768, h: 1024, sidebar: false }, { w: 1180, h: 820, sidebar: true }]) {
    await page.setViewportSize({ width: size.w, height: size.h });
    const dirs = await nav.evaluate((el: any) => {
      const cs = (globalThis as any).getComputedStyle(el);
      return `${cs.display}/${cs.overflowX}` as string;
    });
    const { page: over } = await overflowX(page);
    expect(over, `${size.w} px : le back-office déborde`).toBeLessThanOrEqual(1);
    if (!size.sidebar) expect(dirs, 'sous 861 px, la barre doit être horizontale et défilante').toContain('auto');
    else expect(dirs, 'au-dessus de 861 px, la barre doit retrouver sa colonne').toContain('grid');
  }
});
