/**
 * Tests d'adaptivité : mobile-first, tablette, grand bureau, pouce, encoche, tableaux.
 *
 * Un site « responsive » n'est pas un site qui « tient » : c'est un site qui ne *retire* rien à
 * un petit écran. Les règles ci-dessous sont donc surtout des interdictions — masquer la navigation
 * sous un seuil, poser une largeur fixe qui déborde un 360 px, laisser un tableau forcer le défilement
 * horizontal de toute la page, oublier l'encoche en bas d'iPhone. Elles sont lues à la source
 * (client/src/styles.css, client/index.html) ET sur le HTML réellement rendu, pour que le défaut se
 * voie avant la mise en ligne, sans navigateur.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderPath } from '../scripts/ssr-lib.mts';

const css = readFileSync(resolve(import.meta.dirname, '../client/src/styles.css'), 'utf8');
const shell = readFileSync(resolve(import.meta.dirname, '../client/index.html'), 'utf8');
const ui = readFileSync(resolve(import.meta.dirname, '../client/src/lib/ui.tsx'), 'utf8');

/** Le « socle » = tout ce qui s'applique avant la première media query : c'est la version mobile. */
function baseLayer(all: string): string {
  const i = all.indexOf('@media');
  return i < 0 ? all : all.slice(0, i);
}
/** Corps d'une media query (accolres appariées, CSS non minifiée). */
function mediaBodies(all: string, cond: RegExp): string[] {
  const out: string[] = [];
  const re = /@(?:media|container)[^\n]*\n?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(all))) {
    const head = all.slice(m.index, m.index + m[0].length);
    if (!cond.test(head)) continue;
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < all.length && depth > 0) {
      const c = all[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    out.push(all.slice(start, i - 1));
  }
  return out;
}

test('le meta viewport couvre l\u2019encoche et n\u2019interdit jamais le zoom', () => {
  const vp = /name="viewport" content="([^"]*)"/.exec(shell)?.[1] ?? '';
  assert.match(vp, /width=device-width/, 'width=device-width absent : le mobile affiche une page 980px réduite');
  assert.match(vp, /initial-scale=1/, 'initial-scale=1 absent');
  assert.match(vp, /viewport-fit=cover/, 'viewport-fit=cover absent : env(safe-area-inset-*) ne sert à rien');
  assert.doesNotMatch(vp, /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/, 'le zoom est bloqué (violation d\u2019accessibilité)');
});

test('la navigation mobile est remplacée par quatre onglets, jamais supprimée', () => {
  const base = baseLayer(css);
  const chrome = readFileSync(resolve('client/src/lib/app-chrome.tsx'), 'utf8');
  for (const label of ['Accueil', 'Réserver', 'Mes RDV', 'Le salon']) assert.ok(chrome.includes(label));
  assert.match(css, /\.app-tabs\s*\{[^}]*display:\s*grid/);
  assert.doesNotMatch(base, /\.hd nav[^{]*\{[^}]*display:\s*none/, 'la navigation principale est masquée dès le plus petit écran');
  assert.doesNotMatch(base, /\.adm-nav[^{]*\{[^}]*display:\s*none/, 'la navigation du back-office est masquée dès le plus petit écran');
  // et aucune media query « max-width » ne doit la rattraper en la cachant
  for (const body of mediaBodies(css, /\(max-width:/)) {
    assert.doesNotMatch(body.replace(/\.app-keyboard[^{}]*\{[^}]*\}/g, ''), /(nav|tabs)[^{]*\{[^}]*display:\s*none/, 'la navigation est masquée hors contexte clavier');
  }
});

test('mobile-first : les paliers sont écrits en min-width, les max-width restent cosmétiques', () => {
  const minCount = (css.match(/@media[^\n]*\(min-width:/g) ?? []).length;
  const maxCount = (css.match(/@media[^\n]*\(max-width:/g) ?? []).length;
  assert.ok(minCount >= 6, `seulement ${minCount} paliers en min-width (la base doit être le petit écran)`);
  // un max-width n'est toléré que pour réduire la voilure typographique, jamais pour retirer un bloc
  for (const body of mediaBodies(css, /\(max-width:/)) {
    assert.ok(!/grid-template-columns:\s*1fr/.test(body), 'des grilles ne se replient qu\u2019en max-width : elles devraient l\u2019être par défaut');
  }
  assert.ok(maxCount <= minCount, `${maxCount} règles max-width contre ${minCount} min-width : écriture desktop-first`);
});

test('les grilles ne peuvent pas déborder un écran de 320 px', () => {
  for (const m of css.matchAll(/minmax\(([^)]*)\)/g)) {
    const inner = m[1];
    const px = /(\d{3,})px/.exec(inner);
    if (!px) continue;
    if (/min\([^)]*100%/.test(inner)) continue; // piste bornée à 100 % du conteneur : jamais de débordement
    assert.ok(Number(px[1]) <= 200, `minmax(${inner}) : piste de ${px[1]}px non bornée, plus large qu\u2019un téléphone en padding (débordement horizontal)`);
  }
  assert.ok(!/(^|\}|\n)\s*\.(wrap|main|card|hero)[^{]*\{[^}]*[^-\w]width:\s*\d{3,}px/.test(css), 'un conteneur de mise en page a une largeur fixe en pixels');
});

test('hauteur d\u2019écran : chaque 100vh a son repli 100dvh (barre d\u2019URL mobile)', () => {
  const vh = [...css.matchAll(/height:\s*100vh\s*(;|\})/g)];
  const dvh = [...css.matchAll(/height:\s*100dvh/g)];
  assert.ok(dvh.length >= 2, `${dvh.length} usages de 100dvh : la page ne s\u2019adapte pas à la barre d\u2019URL`);
  for (const m of vh) {
    const after = css.slice(m.index, m.index + 90);
    assert.match(after, /100dvh/, '100vh sans repli dvh juste après');
  }
  const boot = /#boot[^}]*\}/.exec(shell)?.[0] ?? '';
  assert.match(boot, /100vh[^}]*100dvh/, 'le plein écran de chargement doit aussi passer en dvh');
});

test('pouce : cibles tactiles 44 px et 16 px dans les champs (sinon iOS zoome)', () => {
  const coarse = mediaBodies(css, /\(pointer:\s*coarse\)/).join('\n');
  assert.ok(coarse.length > 20, 'aucun bloc @media (pointer: coarse)');
  assert.match(coarse, /min-height:\s*44px/, 'aucune cible tactile portée à 44px en pointer:coarse');
  assert.ok(!/min-height:\s*4[0-3]px/.test(coarse), 'une cible tactile reste sous 44px dans le bloc coarse');
  assert.match(coarse, /font-size:\s*16px/, 'les champs ne passent pas à 16px : focus = zoom iOS');
  for (const sel of ['.tab', '.hd nav a', '.adm-nav a', '.ft a', '.slot', '.btn']) {
    assert.ok(coarse.includes(sel), `${sel} absent du bloc tactile`);
  }
});

test('encoche et gestes : les barres fixes ménagent safe-area-inset', () => {
  for (const sel of ['.toasts', '.sticky', '.sheet', '.ft']) {
    const rule = new RegExp(`\\${sel}\\s*\\{[^}]*\\}`, 'm').exec(css)?.[0] ?? '';
    assert.ok(rule.length > 0, `${sel} introuvable`);
    if (/position:\s*(fixed|sticky)/.test(rule) || sel === '.sheet' || sel === '.ft') {
      assert.match(rule, /env\(\s*safe-area-inset-/, `${sel} ne prévoit pas l\u2019encoche`);
    }
  }
});

test('modale : feuille saisissable en bas sur mobile, centrée en grand, sans !important', () => {
  assert.match(css, /\.sheet\s*\{[^}]*max-height:\s*min\(\s*88dvh/, 'la feuille de saisie n\u2019est pas bornée en dvh');
  assert.match(css, /\.sheet\s*\{[^}]*border-radius:\s*20px 20px 0 0/, 'la modale mobile ne se présente pas en bottom sheet');
  assert.match(css, /@media[^\n]*min-width:\s*720px[^{]*\{[\s\S]{0,400}\.sheet/, 'aucun passage en boîte centrée à partir de 720px');
  const uiCode = ui.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(uiCode, /!important/, 'un style en ligne + !important dans ui.tsx : la géométrie doit être dans la CSS');
  assert.doesNotMatch(ui, /position:\s*'fixed'/, 'la couche de fond ne doit pas être stylée en ligne (inadaptée aux media queries)');
});

test('back-office : les panneaux se règlent sur leur colonne, pas sur la fenêtre', () => {
  assert.match(css, /\.adm-main\s*\{[^}]*container-type:\s*inline-size/, '.adm-main ne déclare pas de conteneur');
  const containers = mediaBodies(css, /@container/).join('\n');
  assert.ok(containers.length > 0, 'aucune règle @container : sur tablette avec barre latérale, les grilles du back-office ne se replient pas');
  assert.match(css, /@media[^\n]*min-width:\s*861px[\s\S]{0,300}\.adm\s*\{[^}]*208px/, 'la barre latérale de 208px doit arriver en min-width (mobile-first)');
});

test('chaque tableau est dans un conteneur défilable, atteignable au clavier', async () => {
  assert.match(css, /\.tx\s*\{[^}]*overflow-x:\s*auto/, '.tx ne défile pas horizontalement');
  assert.match(css, /\.tx\s*\{[^}]*overscroll-behavior-x:\s*contain/, '.tx propage son scroll au body (page qui bouge)');
  assert.match(css, /\.tx\s+table\.t\s*\{\s*min-width/, 'les tableaux n\u2019ont pas de largeur minimale lisible en petit');
  for (const f of ['client/src/admin/panels.tsx', 'client/src/admin/admin.tsx', 'client/src/pages/pages.tsx']) {
    const src = readFileSync(resolve(import.meta.dirname, '..', f), 'utf8');
    const tables = (src.match(/<table className="t/g) ?? []).length;
    const wraps = (src.match(/className="tx" tabIndex=\{0\} role="region"/g) ?? []).length;
    assert.equal(wraps, tables, `${f} : ${tables} tableaux, ${wraps} conteneurs accessibles`);
  }
  const h = await renderPath('/faq');
  if (/<table/.test(h)) assert.match(h, /class="tx"/, 'tableau rendu sans conteneur défilable');
});

test('le HTML livré expose la navigation complète, quel que soit l\u2019écran', async () => {
  for (const path of ['/', '/tarifs', '/galerie', '/infos', '/book?service=coupe-homme']) {
    const h = await renderPath(path);
    for (const link of ['/tarifs', '/galerie', '/infos']) {
      assert.ok(h.includes(`href="${link}"`), `${path} : lien ${link} absent du HTML (le mobile ne le recovera pas)`);
    }
    assert.ok(!/style="display:none"/.test(h), `${path} : élément masqué en style en ligne (inaccessible au tactile)`);
  }
});

test('typographie fluide et équilibre des lignes sur tous les écrans', () => {
  assert.match(css, /h1\s*\{[^}]*clamp\(/, 'h1 n\u2019est pas fluide');
  assert.match(css, /h2\s*\{[^}]*clamp\(/, 'h2 n\u2019est pas fluide');
  assert.match(css, /text-wrap:\s*balance/, 'les titres ne sont pas équilibrés (vedo sur tablette)');
  assert.match(css, /html\s*\{[^}]*-webkit-text-size-adjust:\s*100%/, 'text-size-adjust non neutralisé (iOS agrandit le texte en paysage)');
  assert.match(css, /scroll-padding-top/, 'aucun scroll-padding : les ancres passent sous l\u2019en-tête collant');
});

test('écrans particuliers prévus : paysage étroit, impression, contraste forcé', () => {
  assert.ok(mediaBodies(css, /orientation:\s*landscape/).length > 0, 'aucun ajustement téléphone couché');
  assert.ok(mediaBodies(css, /@media[^{]*print/).length > 0, 'aucune feuille d\u2019impression (imprimer un récap de RDV = 3 écrans)');
  assert.ok(mediaBodies(css, /forced-colors/).length > 0, 'aucun ajustement forced-colors');
  assert.ok(mediaBodies(css, /prefers-reduced-motion/).length > 0, 'aucun ajustement prefers-reduced-motion');
  assert.match(css, /@media[^\n]*min-width:\s*1440px/, 'aucun palier grand bureau (le texte ne doit pas courir sur 1800px)');
});
