/**
 * Auditeur de site : passe les pages pré-rendues au crible SEO, accessibilité, intégrité des liens
 * et poids réseau. `node scripts/audit-site.mjs [--base http://127.0.0.1:8787]`
 * Sort en code 1 si une règle est violée — c'est un garde-fou, pas un tableau de bord.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { gzipSync, brotliCompressSync } from 'node:zlib';

const DIST = resolve(process.cwd(), 'dist/client');

if (!existsSync(DIST)) {
  console.error('\x1b[31m✗ ' + DIST + " introuvable — lance d'abord `npm run build`\x1b[0m");
  process.exit(1);
}
const argv = process.argv.slice(2);
const baseIdx = argv.indexOf('--base');
const BASE = baseIdx >= 0 ? argv[baseIdx + 1].replace(/\/$/, '') : null;

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/client introuvable — lance `npm run build` avant l’audit.');
  process.exit(2);
}

const html = [];
walk(DIST);
function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.html')) html.push(p);
  }
}
html.sort();

const issues = [];
const warns = [];
const say = (bad, file, msg) => (bad ? issues : warns).push(`${file ? file.replace(DIST, '') + ' — ' : ''}${msg}`);

/* ── par page : SEO + a11y + références ─────────────────────────────────── */
const titles = new Map();
const routes = new Set();
const assets = new Set();
for (const file of html) {
  const name = relative(DIST, file);
  const src = readFileSync(file, 'utf8');
  const route = '/' + name.replace(/index\.html$/, '').replace(/\.html$/, '').replace(/\/$/, '');
  routes.add(route);

  const title = (src.match(/<title>([^<]*)<\/title>/) || [])[1] ?? '';
  if (title.length < 12) say(true, name, `titre trop court (${title.length})`);
  if (title.length > 70) say(true, name, `titre trop long (${title.length}) → tronqué dans Google`);
  const key = title.trim().toLowerCase();
  if (titles.has(key) && route !== '/') say(true, name, `titre dupliqué avec ${titles.get(key)}`);
  else titles.set(key, name);

  const desc = (src.match(/name="description" content="([^"]*)"/) || [])[1] ?? '';
  if (desc.length < 60) say(true, name, `meta description faible (${desc.length} car.)`);
  if (desc.length > 190) say(true, name, `meta description trop longue (${desc.length})`);
  const canonicals = [...src.matchAll(/rel="canonical" href="([^"]+)"/g)];
  if (canonicals.length !== 1) say(true, name, 'il faut exactement une canonical');
  else {
    try {
      const canonical = new URL(canonicals[0][1]);
      if (!/^https?:$/.test(canonical.protocol) || canonical.search || canonical.hash) say(true, name, 'canonical non HTTP(S) ou contenant query/fragment');
      const expected = name === 'index.html' ? '/' : '/' + name.replace(/\.html$/, '');
      if (canonical.pathname !== expected) say(true, name, `canonical incorrecte : ${canonical.pathname} au lieu de ${expected}`);
    } catch { say(true, name, 'canonical absente ou non absolue'); }
  }
  for (const field of ['og:title', 'og:description', 'og:url', 'og:image']) {
    if ((src.match(new RegExp(`property="${field}"`, 'g')) || []).length !== 1) say(true, name, `${field} absent ou dupliqué`);
  }
  const ldBlocks = [...src.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  if (ldBlocks.length !== 1) say(true, name, 'JSON-LD absent ou dupliqué');
  for (const ld of ldBlocks) { try { JSON.parse(ld[1]); } catch { say(true, name, 'JSON-LD non valide'); } }

  if (!/property="og:title"/.test(src)) say(true, name, 'og:title absent');
  if (!/property="og:image"/.test(src)) say(true, name, 'og:image absent');
  if (!/name="viewport"/.test(src)) say(true, name, 'viewport manquant (le mobile est 80 % du trafic)');
  if (!/data-prerendered/.test(src)) say(false, name, 'page non pré-rendue (les gabarits fixes devraient l’être)');

  const h1s = [...src.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)];
  const visibleH1 = h1s.filter((m) => m[1].replace(/<[^>]+>/g, '').trim().length > 0);
  if (visibleH1.length !== 1) say(true, name, `${visibleH1.length} <h1> visibles (il en faut exactement un)`);

  const imgs = [...src.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  for (const tag of imgs) {
    if (!/\balt="[^"]*"/.test(tag) && !/\balt=""/.test(tag)) say(true, name, `img sans alt : ${tag.slice(0, 70)}`);
    if (!/\bwidth=/.test(tag) || !/\bheight=/.test(tag)) say(false, name, 'img sans width/height (saut de mise en page)');
    const s = (tag.match(/src="([^"]+)"/) || [])[1];
    if (s && s.startsWith('/') && !s.startsWith('//')) assets.add(s.split('?')[0]);
  }

  if (/onclick=|onerror=|onload=/.test(src.replace(/<script[\s\S]*?<\/script>/g, ''))) say(true, name, 'gestionnaire en ligne dans le markup (XSS)');
  if (/tabindex="[1-9]/.test(src)) say(true, name, 'tabindex positif (ordre de tabulation cassé)');
  if (!/class="skip"/.test(src)) say(true, name, 'lien d’évitement absent');
  if (!/id="main"/.test(src)) say(true, name, 'contenant principal #main absent');
  if (/class="[^"]*\btext-center\b/.test(src) && /<h[12]/.test(src)) say(false, name, 'titres centrés (lisibilité)');

  const jsonLd = [...src.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  for (const block of jsonLd) {
    try {
      const data = JSON.parse(block[1]);
      const list = Array.isArray(data) ? data : [data];
      if (!list.length) say(true, name, 'JSON-LD vide');
      for (const d of list) if (!d['@context'] || !d['@type']) say(true, name, `JSON-LD sans @context/@type : ${JSON.stringify(d).slice(0, 60)}`);
      const txt = JSON.stringify(data);
      for (const fake of ['4,9', '4.9/5', '1 200 avis', '1200 avis', 'complet', 'plus que 2']) {
        if (txt.includes(fake) && /aggregateRating/i.test(txt)) say(false, name, `note agrégée Suspense à vérifier (« ${fake} ») : doit venir d’un avis réel`);
      }
    } catch (e) {
      say(true, name, `JSON-LD illisible : ${e.message.slice(0, 60)}`);
    }
  }
}

/* ── textes interdits sur le site public (règles produit) ────────────────── */
const banned = [
  [/\bcomplet\b(?!e?s? (de|à))/i, 'mot « complet » employé seul'],
  [/déjà +\d+ (personnes|clients) (regardent|consultent)/i, 'compteur social fabrijé'],
  [/offre (se termine|expire) (dans|en) 0?0?d/i, 'fausse urgence'],
  [/\bgaranti à 100 ?%\b/i, 'promesse invérifiable'],
  [/note (moyenne )?(4|5)[,.]?\d?\/5 · \d{3,} avis/i, 'avis agrégés faux'],
];
for (const file of html) {
  const src = readFileSync(file, 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const text = src.replace(/<[^>]+>/g, ' ');
  for (const [re, why] of banned) {
    const m = text.match(re);
    if (m && !/complet|complète/.test('')) {
      // « complet » n'est interdit que s'il est employé comme refus sec ; on garde le contexte
      const ctx = text.slice(Math.max(0, (m.index ?? 0) - 90), (m.index ?? 0) + 90).replace(/\s+/g, ' ');
      if (/^(il est|jour|journée|Planning complet|complet\.)/i.test(ctx.trim()) && why.startsWith('mot')) say(true, relative(DIST, file), `${why} : « …${ctx}… »`);
      else if (!why.startsWith('mot')) say(true, relative(DIST, file), `${why} : « ${ctx} »`);
    }
  }
}

/* ── ressources référencées : existence locale ou HTTP ──────────────────── */
const missingAssets = [];
for (const a of assets) {
  const local = join(DIST, a);
  if (existsSync(local)) continue;
  if (BASE) {
    // vérifié à l'étape réseau ci-dessous
  } else missingAssets.push(a);
}

/* ── CSS : les garde-fous d'accessibilité doivent exister ────────────────── */
const cssFile = readdirSync(join(DIST, 'assets')).find((f) => f.endsWith('.css'));
const css = cssFile ? readFileSync(join(DIST, 'assets', cssFile), 'utf8') : '';
if (!/:focus-visible|:focus\b/.test(css)) say(true, null, 'CSS sans style :focus — navigation clavier invisible');
if (!/prefers-reduced-motion/.test(css)) say(true, null, 'CSS sans prefers-reduced-motion');
if (!/font-size|min-height/.test(css)) say(true, null, 'CSS suspecte (aucune règle de taille)');
const tapRule = /min-height:\s*(4[4-9]|5\d|6\d)px|min-width:\s*(4[4-9]|5\d)px/.test(css);
if (!tapRule) say(false, null, 'aucune règle explicite de cible tactile ≥44 px');
// les !important de la règle prefers-reduced-motion sont *requis* (respect des réglages système) : on ne les compte pas.
const cssSansMotion = css.replace(/@media[^{]*prefers-reduced-motion[^{]*\{[\s\S]*?\}\s*\}/g, '');
if (/!important/.test(cssSansMotion)) say(false, null, `${(cssSansMotion.match(/!important/g) || []).length} × !important (dette de cascade)`);

/* ── intégrité du HTML livré ─────────────────────────────────────────────── */
for (const f of html) {
  const src = readFileSync(f, 'utf8');
  const ctrl = src.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g);
  if (ctrl) say(true, f, `${ctrl.length} octet(s) de contrôle dans le HTML (la pipeline SSR en a émis ; les moteurs les nettoient mal)`);
  if (/style-C[^"]*\.css/.test(src) && !existsSync(join(DIST, 'assets', /assets\/(style-[^"]*\.css)/.exec(src)?.[1] ?? 'x'))) {
    say(true, f, 'feuille de style référencée absente de dist/assets (page livrée sans CSS)');
  }
}

/* ── adaptivité : mobile-first, tablette, grands écrans ──────────────────── */
{
  const cssAll = css.replace(/\s+/g, ' ');
  // 1. un viewport qui interdit le zoom est une violation d'accessibilité, pas un détail
  for (const f of html) {
    const src = readFileSync(f, 'utf8');
    const m = /name="viewport" content="([^"]*)"/.exec(src);
    if (!m) continue;
    if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/.test(m[1])) say(true, f, 'viewport bloque le zoom (accessibilité)');
    if (!/viewport-fit\s*=\s*cover/.test(m[1])) say(false, f, 'viewport sans viewport-fit=cover (les encoches mangent les barres fixes)');
  }
  // 2. Une navigation mobile peut remplacer le menu desktop, mais ne peut pas disparaître.
  // Accolades appariées : l'ancienne regex débordait jusqu'aux règles CSS suivantes.
  const mediaStart = /@media[^{}]*\(max-width:\s*(\d+)px\)[^{}]*\{/g;
  for (const match of cssAll.matchAll(mediaStart)) {
    let depth = 1, end = match.index + match[0].length;
    const start = end;
    while (end < cssAll.length && depth) { if (cssAll[end] === '{') depth++; if (cssAll[end] === '}') depth--; end++; }
    const body = cssAll.slice(start, end - 1);
    for (const rule of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/display:\s*none/.test(rule[2])) continue;
      const selector = rule[1];
      if (selector.includes('.app-keyboard')) continue; // clavier ouvert uniquement, contrôlé en navigateur
      if (/\.app-tabs|\.adm-nav|\.hd\s+nav/.test(selector)) say(true, null, `navigation masquée sous ${match[1]}px sans alternative`);
      if (/client-shell\s*>\s*\.hd/.test(selector)) {
        const replacement = /\.app-tabs\s*\{[^}]*display:\s*grid/.test(cssAll) && html.some(f => readFileSync(f, 'utf8').includes('Navigation de l’application'));
        if (!replacement) say(true, null, 'en-tête mobile retiré sans onglets de remplacement');
      }
    }
  }
  // 3. grille dont la piste minimale dépasse un petit écran : débordement horizontal garanti
  for (const m of cssAll.matchAll(/minmax\(\s*(\d{3,})px/g)) if (Number(m[1]) > 200 && !/min\(/.test(m[0])) say(false, null, `minmax(${m[1]}px) non borné — déborde sous ~${Number(m[1]) + 40}px`);
  // 4. 100vh seul = contenu coupé par la barre d'URL mobile
  const vhOnly = [...cssAll.matchAll(/(?:min-|max-)?height:\s*100vh(?!\s*;?\s*[^}]*100dvh)/g)];
  if (vhOnly.length) say(false, null, `${vhOnly.length} × 100vh sans repli 100dvh (barre d'URL mobile)`);
  // 5. les barres fixes doivent ménager l'encoche et le gesto de retour
  if (!/env\(\s*safe-area-inset-/.test(cssAll)) say(true, null, 'CSS sans env(safe-area-inset-*) : les barres fixes passent sous l\u2019encoche');
  // 6. pouce : cibles ≥44px et 16px dans les champs (sinon iOS zoome à la saisie)
  const coarse = /@media[^{]*\(pointer:\s*coarse\)[^{]*\{([\s\S]*?)(?=\}\s*@|\}$)/.exec(cssAll);
  if (!coarse) say(true, null, 'aucune règle @media (pointer: coarse) : rien n\u2019est adapté au tactile');
  else {
    if (!/min-height:\s*(4[4-9]|5\d)px/.test(coarse[1])) say(true, null, '@media (pointer: coarse) sans cible tactile ≥44px');
    if (!/font-size:\s*16px/.test(coarse[1])) say(true, null, '@media (pointer: coarse) sans input à 16px (iOS zoome à la saisie)');
  }
  // 7. les conteneurs doivent pouvoir raisonner sur leur propre largeur
  if (!/@container/.test(cssAll)) say(false, null, 'aucune @container query : les panneaux du back-office dépendent de la fenêtre, pas de leur colonne');
  if (!/@media[^{]*print/.test(cssAll)) say(false, null, 'aucune feuille @media print (imprimer un récap de RDV décore 3 écrans)');
  if (!/orientation:\s*landscape/.test(cssAll)) say(false, null, 'aucun ajustement pour téléphone couché (hauteur utile ~360px)');
  if (!/forced-colors/.test(cssAll)) say(false, null, 'aucun ajustement forced-colors (contraste forcé Windows)');
  // 8. une table hors conteneur défilable fait déborder toute la page sur téléphone
  for (const f of html) {
    const src = readFileSync(f, 'utf8');
    const tables = (src.match(/<table/g) || []).length;
    if (!tables) continue;
    const wrapped = (src.match(/class="tx"/g) || []).length;
    if (wrapped < tables) say(true, f, `${tables - wrapped} table(s) hors conteneur défilable .tx`);
  }
  // 9. largeur figée susceptible de déborder un écran 320px
  for (const m of cssAll.matchAll(/(?:^|\}|;)\s*([.#][\w-]+)[^{]*\{[^}]*?width:\s*(3[6-9]\d|4\d\d|\d{4,})px/g)) {
    if (/\.wrap|max-width|min-width/.test(m[0])) continue;
    say(false, null, `${m[1]} : largeur fixe ${m[2]}px (déborde un petit écran)`);
  }
}

/* ── poids réseau ────────────────────────────────────────────────────────── */
const sizes = [];
for (const f of readdirSync(join(DIST, 'assets'))) {
  const buf = readFileSync(join(DIST, 'assets', f));
  sizes.push({ f, raw: buf.length, gz: gzipSync(buf, { level: 9 }).length, br: brotliCompressSync(buf).length });
}
const js = sizes.filter((s) => s.f.endsWith('.js'));
const cssS = sizes.filter((s) => s.f.endsWith('.css'));
const totalBr = js.reduce((a, s) => a + s.br, 0) + cssS.reduce((a, s) => a + s.br, 0);
const htmlBytes = html.reduce((a, f) => a + readFileSync(f).length, 0);

/* ── réseau : statuts, en-têtes, liens internes (si --base) ──────────────── */
const net = { checked: 0, broken: [], slow: [], noCache: [] };
if (BASE) {
  const urls = new Set([...routes, ...assets]);
  for (const file of html) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:href|to)="(\/[^"#?]*)/g)) urls.add(m[1]);
  }
  const list = [...urls].filter((u) => !u.startsWith('/api/'));
  for (const u of list) {
    try {
      const t0 = Date.now();
      const res = await fetch(BASE + u, { redirect: 'manual' });
      net.checked++;
      const ms = Date.now() - t0;
      if (res.status >= 400) net.broken.push(`${u} → ${res.status}`);
      if (ms > 250 && u !== '/') net.slow.push(`${u} ${ms} ms`);
      const cc = res.headers.get('cache-control') ?? '';
      if (u.startsWith('/assets/') && !/immutable/.test(cc)) net.noCache.push(u + ' (asset sans cache long)');
      if (/^\/(brand|uploads)\//.test(u) && !/max-age/.test(cc)) net.noCache.push(u + ' (média sans cache)');
    } catch (e) {
      net.broken.push(`${u} → ${e.message.slice(0, 40)}`);
    }
  }
}
for (const a of missingAssets) net.broken.push(`${a} → introuvable dans dist/client`);
if (net.broken.length) for (const b of net.broken.slice(0, 12)) say(true, null, `lien/ressource : ${b}`);

/* ── rapport ─────────────────────────────────────────────────────────────── */
const kb = (n) => (n / 1024).toFixed(1) + ' ko';
console.log(`\n\x1b[1mAudit de site — ${html.length} pages\x1b[0m${BASE ? ` (réseau : ${BASE})` : ''}`);
console.log(`  HTML total            ${kb(htmlBytes)}   (moyenne ${kb(Math.round(htmlBytes / html.length))}/page)`);
console.log(`  JS  ${js.length} fichier(s)         ${kb(js.reduce((a, s) => a + s.raw, 0))} brut · ${kb(js.reduce((a, s) => a + s.br, 0))} brotli`);
console.log(`  CSS 1 fichier          ${kb(cssS.reduce((a, s) => a + s.raw, 0))} brut · ${kb(cssS.reduce((a, s) => a + s.br, 0))} brotli`);
console.log(`  Premier chargement     ${kb(totalBr)} de JS+CSS (hors images) · ${net.checked ? `${net.checked} URLs vérifiées` : 'réseau non testé'}`);
console.log(`  routes couvertes       ${[...routes].sort().join(' ')}`);

if (warns.length) {
  console.log(`\n\x1b[33mà surveiller (${warns.length})\x1b[0m`);
  for (const w of warns.slice(0, 10)) console.log('  · ' + w);
  if (warns.length > 10) console.log(`  … ${warns.length - 10} autres`);
}
if (issues.length) {
  console.log(`\n\x1b[31m✗ ${issues.length} problème(s) bloquants\x1b[0m`);
  for (const i of issues.slice(0, 30)) console.log('  ✗ ' + i);
  process.exit(1);
}
console.log('\n\x1b[32m✓ audit de site : aucune violation bloquante\x1b[0m\n');
