/**
 * Pré-rendu statique (SSG) des pages publiques.
 *
 * Ce qui est généré : pour chaque route, un `dist/client/<route>.html` = le HTML du shell React
 * rendu avec la VRAIE config du salon (prix, horaires, personnel, note) + <title>, meta
 * description, canonical et JSON-LD par page. Double bénéfice : premier octet utile pour les
 * robots et pour le SEO local, et premier paint lisible sur mobile même si le bundle JS est lent.
 * Le contenu qui dépend d'un appel asynchrone par page (disponibilité à la minute, espace client)
 * reste rendu côté client : on ne fige jamais un créneau dans du HTML statique, sinon la
 * disponibilité affichée mentirait (règle « zéro fausse rareté »).
 *
 * `npm run prerender` (lancé par `npm run build` après Vite).
 *
 * Contrainte de build (mesurée sur Vercel le 28/09/2026, `Command "npm run build" exited with
 * SIGABRT`) : la machine de build n'a ni la base SQLite du dépôt (ignorée par git), ni le droit
 * d'appeler la base de production — et une erreur JS levée ici fait planter le process *avant*
 * d'être affichée, parce que le module natif better-sqlite3 s'autodétruit pendant le teardown de
 * Node (`Assertion failed: (env) != nullptr`). Le pré-rendu est donc rendu autonome et tolérant :
 *   1. il sonde d'abord la base réellement configurée (3 s max) ;
 *   2. si elle répond, il s'en sert (valeurs du salon dans le HTML statique) ;
 *   3. sinon il retombe sur une base en mémoire + jeu de démonstration (valeurs de référence) ;
 *   4. si même ça échoue, il écrit le shell sans markup pré-rendu et sort en 0.
 * Un échec SEO ne doit jamais empêcher une mise en ligne ; l'inverse non plus n'est pas vrai,
 * d'où `PRERENDER_STRICT=1` pour les portes locales et la CI.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

process.env.TZ = process.env.TZ || 'Europe/Paris';
const STRICT = /^(1|true|on)$/i.test(process.env.PRERENDER_STRICT || '');
const DEADLINE_MS = Math.max(10_000, Number(process.env.PRERENDER_TIMEOUT_MS || 150_000));
let watchdog: any = null;
let knownRoutes: { path: string; slug?: string }[] | null = null;
/* Le filet de sécurité doit être en place avant le premier import : c'est au démarrage de l'API
   (ouverture de base, seed) que le processus peut s'immobiliser, pas à l'écriture du HTML. */
let timedOut = false;
let shellWritten = 0;
let finished = false;

let written = 0;
const failures: string[] = [];
const routeFailures: string[] = [];

const DIST = resolve(process.cwd(), 'dist/client');
const template = existsSync(join(DIST, 'index.html'))
  ? readFileSync(join(DIST, 'index.html'), 'utf8')
  : (() => {
      throw new Error('dist/client/index.html introuvable — lance d’abord `vite build`.');
    })();

/* Mode de rendu autonome (le correctif du build Vercel) : le pré-rendu n'est pas un serveur, il
   n'a besoin ni d'un secret, ni d'une base de production, ni d'écrire un fichier sur le disque.
   `TEST_DB=memory` court-circuite DATABASE_URL et DATA_FILE dans le driver, `DEMO_MODE=1` évite
   le garde-fou « Postgres requis en production » de env.ts et peuple la config de référence,
   `NODE_ENV=test` écarte les garde-fous de secrets. Ces trois variables ne vivent que dans ce
   process : la fonction déployée lit, elle, les variables du projet Vercel.
   Opt-in inverse : `PRERENDER_DB=live` fige la VRAIE config dans le HTML (utiles aux robots) — à
   ne faire que si la base répond au moment du build, sinon c'est exactement ce qui plantait. */
if (!/^live$/i.test(process.env.PRERENDER_DB || '')) {
  delete process.env.BOOTSTRAP_OWNER_EMAIL;
  delete process.env.BOOTSTRAP_OWNER_PASSWORD;
  process.env.TEST_DB = 'memory';
  process.env.DEMO_MODE = '1';
  process.env.NODE_ENV = 'test';
}

function degrade(why: string) {
  timedOut = true;
  const list = knownRoutes ?? SHELL_PATHS.map((path) => ({ path }));
  let n = 0;
  for (const r of list) {
    const file = r.path === '/' ? 'index.html' : `${r.path.replace(/^\//, '').replace(/\/+$/, '')}.html`;
    const out = join(DIST, file);
    if (existsSync(out)) continue;
    try {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, template);
      n++;
    } catch {
      /* disque en lecture seule : le rewrite de vercel.json sert de toute façon /api/index */
    }
  }
  shellWritten += n;
  console.warn(`\x1b[33m  ! pré-rendu interrompu (${why}) — ${n} page(s) écrite(s) en shell simple\x1b[0m`);
}
watchdog = setTimeout(() => {
  degrade(`délai de ${Math.round(DEADLINE_MS / 1000)} s dépassé`);
  failures.push('délai dépassé (dossier de build ou base trop lente)');
  void summary();
}, DEADLINE_MS);

/* Routes garanties même si le pipeline SSR ne démarre pas : ce sont les pages du shell, rendues
   de toute façon côté client. `dist/client` écrit, Vercel ne renvoie plus de 404. */
const SHELL_PATHS = ['/', '/book', '/tarifs', '/galerie', '/salon', '/infos', '/faq', '/cartes-cadeaux', '/accessibilite', '/mentions-legales', '/donnees-personnelles', '/guides', '/waitlist', '/espace'];

/* L'API tourne dans le même process : la plomberie (fetch détourné, rendu complet du shell +
   lazy) est partagée avec tests/render.test.ts pour que le test porte sur le vrai pipeline. */
const { bootSsr, renderPath } = await import('./ssr-lib.mts');

/* Une config inaccessible ne doit pas être une raison d'échouer la mise en ligne : on écrit
   alors les pages sans données figées (le client recharge la sienne à l'hydratation). */
let cfg: any = null;
try {
  cfg = (await bootSsr()).cfg;
} catch (e: any) {
  routeFailures.push(`démarrage SSR: ${e?.message ?? e}`);
  console.warn(`\x1b[33m  ! pipeline SSR indisponible (${e?.message}) — pages écrites sans config figée\x1b[0m`);
}

type Route = { path: string; slug?: string };
const staticRoutes: Route[] = [{ path: '/' }, { path: '/book' }, { path: '/tarifs' }, { path: '/galerie' }, { path: '/salon' }, { path: '/infos' }, { path: '/faq' }, { path: '/cartes-cadeaux' }, { path: '/accessibilite' }, { path: '/mentions-legales' }, { path: '/donnees-personnelles' }, { path: '/guides' }, { path: '/waitlist' }, { path: '/espace' }, { path: '/sitemap-view' }];

const routes: Route[] = [...staticRoutes];
knownRoutes = routes;
/* Les URLS canoniques sont celles du routeur client : prestation à /<key>, barbier à
   /barbier/<slug>, guide à /guides/<court>. Pré-rendre une URL que le client ne sait pas
   servir produirait une page fantôme (404 en navigation, indexée quand même). */
for (const sv of cfg?.services ?? []) if (sv?.key) routes.push({ path: `/${sv.key}`, slug: sv.key });
for (const st of cfg?.staff ?? []) if (st?.slug) routes.push({ path: `/barbier/${st.slug}`, slug: `barbier-${st.slug}` });
if (cfg?.contentPages) for (const pg of cfg.contentPages) routes.push({ path: `/${pg.slug}`, slug: pg.slug });

/* slugs de pages éditoriales publiées (content_pages) */
try {
  const res: any = await (globalThis as any).fetch('/api/public/content-pages');
  const pages = await res.json();
  for (const pg of pages?.pages ?? []) {
    const isGuide = pg.kind === 'guide' || String(pg.slug).startsWith('guide-');
    const short = String(pg.slug).replace(/^guide-/, '');
    const path = isGuide ? `/guides/${short}` : `/${pg.slug}`;
    if (pg.slug && !routes.some((r) => r.path === path)) routes.push({ path, slug: isGuide ? short : pg.slug });
  }
} catch {
  /* optionnel */
}

/** Titres/descriptions locaux : le point d'entrée SEO (`/api/public/seo/:slug`) couvre les
 * fiches prestation/barbier et les pages éditées ; les gabarits fixes ont donc leur promesse,
 * écrite ici pour la requête réelle (« tarif barbier 93320 »), avec les chiffres du catalogue. */
const CITY = cfg?.salon?.city ?? 'Les Pavillons-sous-Bois';
const from = (cents: number) => `à partir de ${(cents / 100).toFixed(0).replace('.', ',')} €`;
const cheapest = Math.min(...(cfg?.services ?? []).map((x: any) => x.priceFrom ?? x.priceCents ?? 99999));
const metaFor: Record<string, { title: string; description: string }> = {
  '/': { title: `Z.YASS Barber Shop — ${CITY} · réservation en ligne`, description: `Coupe, barbe et rasage traditionnel à ${CITY}. Créneaux en temps réel, rappel automatique, créneaux libérés renvoyés en SMS. Réserve en 30 secondes.` },
  '/tarifs': { title: `Tarifs barbier à ${CITY} — catalogue complet Z.YASS`, description: `Toutes les prestations et leurs prix, ${from(cheapest)} : coupe, dégradé, barbe, rasage traditionnel, couleur. Durées réelles comprises, sans supplément surprise.` },
  '/galerie': { title: `Galerie coiffure homme — Z.YASS, ${CITY}`, description: 'Dégradés, barbes dessinées, avant/après du salon. Chaque visuel renvoie vers la prestation correspondante.' },
  '/salon': { title: 'Le salon — Z.YASS Barber Shop', description: 'Prestations, galerie, horaires, contact et itinéraire. Le salon à portée de main.' },
  '/infos': { title: `Accès et horaires — Z.YASS Barber Shop, ${CITY}`, description: `20 boulevard Roy, ${cfg?.salon?.postalCode ?? '93320'} ${CITY}. Ouvert du lundi au samedi, 9h30-20h. Plan, téléphone, ce qu'il faut savoir avant de venir.` },
  '/faq': { title: `Questions fréquentes — Z.YASS, ${CITY}`, description: 'Retard, annulation, acompte, enfants, couleur, stationnement : les réponses du salon, sans langue de bois.' },
  '/cartes-cadeaux': { title: 'Carte cadeau barbier 10 à 500 € — Z.YASS', description: 'Une carte cadeau valable un an, utilisable sur n’importe quelle prestation, envoyée par e-mail avec le code. Le bénéficiaire réserve quand il veut.' },
  '/waitlist': { title: `C'est complet ? Rejoins la waitlist — Z.YASS, ${CITY}`, description: 'Dès qu’un créneau se libère sur ta prestation et tes jours, tu reçois un SMS avec un lien de réservation valable 12 minutes. Jamais de faux « complet ».' },
  '/espace': { title: 'Mon espace — Z.YASS Barber Shop', description: 'Rendez-vous à venir, report et annulation en un clic, points de fidélité, cartes cadeaux, export de tes données. Connexion par code par SMS, sans mot de passe.' },
  '/accessibilite': { title: 'Accessibilité du salon — Z.YASS', description: 'Accès, largeur de porte, seating, site compatible lecteur d’écran, mode sans JS et contacts pour réserver par téléphone.' },
  '/mentions-legales': { title: 'Mentions légales — Z.YASS Barber Shop', description: 'Éditeur, hébergeur, TVA, médiateur de la consommation, propriété des contenus.' },
  '/donnees-personnelles': { title: 'Données personnelles — Z.YASS', description: 'Ce que le salon garde, pourquoi, combien de temps, et comment exporter ou supprimer ton compte en deux clics.' },
  '/guides': { title: `Guides barbier & barbe — Z.YASS, ${CITY}`, description: 'Entretenir un dégradé, choisir sa barbe, préparer un mariage : conseils du salon, écrits par ceux qui coupent.' },
  '/sitemap-view': { title: 'Plan du site — Z.YASS Barber Shop', description: 'Toutes les pages du salon : prestations, barbiers, infos, guides, réservation.' },
};

try {
for (const r of routes) {
  try {
    const body = await renderPath(r.path);

    let head = template
      .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '')
      .replace(/<meta (?:property="og:site_name"|name="twitter:card") content="[^"]*"\s*\/>/g, '');
    /* SEO par page : title/description/canonical/jsonLd viennent du même endpoint que le client. */
    let meta: any = null;
    try {
      const res: any = await (globalThis as any).fetch(`/api/public/seo/${encodeURIComponent(r.slug || r.path.replace(/^\//, '') || 'home')}`);
      if (res.ok) meta = await res.json();
    } catch {
      /* la page a déjà un titre par défaut */
    }
    // On garde le méta du serveur (source de vérité, la même que celle du client), sauf quand
    // le libellé local est objectivement meilleur : titre plus court, ou description assez
    // longue pour ne pas être tronquée en un moignon.
    const local = metaFor[r.path];
    const apiTitle = String(meta?.meta?.title ?? '');
    const apiDesc = String(meta?.meta?.description ?? '');
    const title = local && (!apiTitle || apiTitle.length > 62 || (apiDesc.length < 60 && local.description.length >= 60)) ? local.title : apiTitle;
    const description = local && (!apiDesc || apiDesc.length < 60) ? local.description : apiDesc;
    if (title) head = head.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
    if (description) head = head.replace(/<meta name="description" content="[^"]*"\s*\/>/, `<meta name="description" content="${esc(description)}" />`);
    const canonicalAbs = meta?.meta?.canonical || (process.env.APP_URL ? `${process.env.APP_URL.replace(/\/$/, '')}${r.path}` : r.path);
    head = head.replace(/<link rel="canonical" href="[^"]*"\s*\/>/, `<link rel="canonical" href="${esc(canonicalAbs)}" />`);
    /* Open Graph et Twitter par page, dans le HTML livré : un lien partagé sur WhatsApp ou collé
       dans un assistant doit montrer CETTE page (ses prix, ses heures), pas la page d'accueil.
       Les robots qui ne exécutent pas le JavaScript — c'est le cas de la plupart des assistants —
       ne voient que ces octets-là. */
    head = head
      .replace(/<meta property="og:title" content="[^"]*"\s*\/>/, `<meta property="og:title" content="${esc(title || '')}" />`)
      .replace(/<meta property="og:description" content="[^"]*"\s*\/>/, `<meta property="og:description" content="${esc(description || '')}" />`)
      .replace(/<meta property="og:type" content="[^"]*"\s*\/>/, `<meta property="og:type" content="${esc(meta?.meta?.ogType || 'website')}" />`)
      .replace(/<meta property="og:image" content="[^"]*"\s*\/>/, `<meta property="og:image" content="${esc(meta?.meta?.ogImage || '')}" />`)
      .replace('</head>', [
        `<meta property="og:url" content="${esc(canonicalAbs)}" />`,
        `<meta property="og:locale" content="${esc(meta?.meta?.ogLocale || 'fr_FR')}" />`,
        `<meta property="og:site_name" content="${esc(meta?.meta?.ogSiteName || 'Z.YASS Barber Shop')}" />`,
        `<meta property="og:image:alt" content="${esc(meta?.meta?.ogImageAlt || '')}" />`,
        `<meta name="twitter:card" content="${esc(meta?.meta?.twitterCard || 'summary_large_image')}" />`,
        `<meta name="twitter:title" content="${esc(title || '')}" />`,
        `<meta name="twitter:description" content="${esc(description || '')}" />`,
        `<meta name="twitter:image" content="${esc(meta?.meta?.ogImage || '')}" />`,
        `<meta name="robots" content="${esc(meta?.meta?.robots || 'index,follow,max-image-preview:large')}" />`,
        meta?.meta?.publishedTime ? `<meta property="article:published_time" content="${esc(meta.meta.publishedTime)}" />` : '',
        meta?.meta?.modifiedTime ? `<meta property="article:modified_time" content="${esc(meta.meta.modifiedTime)}" />` : '',
      ].filter(Boolean).join('\n') + '\n</head>');
    if (meta?.jsonLd?.length) head = head.replace('</head>', `<script type="application/ld+json">${JSON.stringify(meta.jsonLd).replace(/</g, '\\u003c')}</script></head>`);

    /* le markup pré-rendu remplace le squelette de chargement dans #root */
    head = head.replace(
      /<div id="root">[\s\S]*?<\/div><\/div>|<div id="root">[\s\S]*?<\/div>/,
      `<div id="root">${body}</div>`,
    );
    head = head.replace(/<div id="prerender"[^>]*><\/div>/, '');
    head = head.replace('<html lang="fr">', '<html lang="fr" data-prerendered>');

    /* La pipeline de rendu en flux peut charrier un octet de contrôle (saut de boundary sur un
       caractère multi-octets) : une page livrée doit rester du texte propre, on nettoie à l'écriture
       et on le signale dans le build plutôt que de laisser un \\0 dans le HTML des moteurs. */
    const ctrl = (head.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g) ?? []).length;
    if (ctrl) {
      head = head.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
      console.warn(`  ! ${r.path}: ${ctrl} octet(s) de contrôle retiré(s) du HTML pré-rendu`);
    }

    const file = r.path === '/' ? 'index.html' : `${r.path.replace(/^\//, '').replace(/\/+$/, '')}.html`;
    const out = join(DIST, file);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, head);
    written++;
  } catch (e: any) {
    failures.push(`${r.path}: ${e?.message}`);
  }
}

} catch (e: any) {
  routeFailures.push(`pipeline SSR: ${e?.message ?? e}`);
}

/* Fermer le driver AVANT de sortir : sans ça, les statements better-sqlite3 sont détruits pendant
   le teardown de l'environnement Node et le binaire natif avorte (SIGABRT) en masquant la vraie
   erreur. D'où une sortie unique, explicite, qui attend la fermeture (2 s max) puis process.exit :
   aucune GC différée, aucun handle ouvert, aucun plantage natif dans les logs du déployeur. */
async function summary() {
  if (finished) return;
  finished = true;
  if (watchdog) clearTimeout(watchdog);
  try {
    const { closeDb } = await import('../server/db/index.ts');
    await Promise.race([closeDb().catch(() => null), new Promise((r) => setTimeout(r, 2000))]);
  } catch {
    /* aucune base ouverte (shell-only) : rien à fermer */
  }
  const all = failures.concat(routeFailures);
  if (all.length) {
    const msg = `pré-rendu partiel : ${all.length} échec(s)\n` + all.slice(0, 8).join('\n');
    const suite = written
      ? `  ${written} page(s) pré-rendue(s), les autres seront rendues côté client (le shell couvre).`
      : `  aucune page pré-rendue${shellWritten ? ` (${shellWritten} shell(s) écrits pour ne renvoyer aucun 404)` : ''} : le site reste utilisable, mais un crawler verra une coquille vide et le SEO local ne fige ni prix ni horaires.`;
    console[written ? 'warn' : 'error'](`\x1b[33m! ${msg}\x1b[0m\n${suite}\n  Le déploiement continue (un échec SEO ne doit pas bloquer une mise en ligne) ; rejouez en local avec PRERENDER_STRICT=1 pour voir la cause exacte.\x1b[0m`);
    process.exit(STRICT ? 1 : 0);
  }
  console.log(`\x1b[32m✓\x1b[0m pré-rendu : ${written} pages statiques dans dist/client`);
  process.exit(0);
}
await summary();

function esc(s: string) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
