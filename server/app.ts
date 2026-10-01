import { Hono } from 'hono';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { env } from './lib/env.ts';
import { readBuildFile } from './static.ts';
import { ready, db } from './db/index.ts';
import { seedDemo } from './seed/index.ts';
import { securityHeaders } from './lib/security.ts';
import { observe } from './lib/observe.ts';
import { adminApi, clientApi, internalApi, masterApi, publicApi } from './routes.ts';
import { loadCtx, invalidateCtx } from './domain/context.ts';
import { fmtDate, fmtTime, startOfDayMs, todayDay } from './lib/time.ts';
import { waNumber } from './domain/notify.ts';
import { BookingError } from './domain/booking.ts';

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.ics': 'text/calendar; charset=utf-8',
};

const DIST = resolve(process.cwd(), 'dist/client');

export function createApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const t0 = Date.now();
    await next();
    const ms = Date.now() - t0;
    for (const [k, v] of Object.entries(securityHeaders(c.req.header('origin')))) c.header(k, v);
    c.header('X-Response-Ms', String(ms));
    if (/^\/(api(?:\/|$)|admin(?:\/|$)|espace(?:\/|$)|rdv\/|avis\/|waitlist\/(reserver|refuser))/.test(c.req.path)) {
      c.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
      c.header('Cache-Control', 'private, no-store');
      c.header('Referrer-Policy', 'no-referrer');
    }
    if (c.req.path.startsWith('/api') && ms > 1500) void observe('latency', c.req.path, ms, 'slow', {}, null).catch(() => undefined);
  });

  app.onError((e, c) => {
    // Les erreurs de validation (zod) sont des erreurs CLIENT : 422 + message lisible,
    // jamais un 500 qui ferait croire à une panne et polluerait la supervision.
    // Idem pour un corps illisible : `c.req.json()` lève un SyntaxError, et un robot, un
    // `sendBeacon` vidé ou un proxy capricieux ne doivent pas faire rougir la supervision.
    const parseur = e instanceof SyntaxError || /is not valid JSON|Malformed JSON|Unexpected end of JSON|Unexpected token/i.test(String((e as any)?.message ?? ''));
    if (parseur) {
      void observe('api_reject', c.req.path, null, '400', { code: 'corps_invalide' }, null).catch(() => undefined);
      return c.json({ error: 'corps_invalide', message: 'Le corps de la requête n’est pas du JSON exploitable.' }, 400);
    }
    const issues: any[] | undefined = Array.isArray((e as any)?.issues) ? (e as any).issues : undefined;
    if (issues?.length) {
      const label = (path: string) =>
        ({
          'customer.firstName': 'ton prénom',
          'customer.lastName': 'ton nom',
          'customer.phone': 'ton numéro de téléphone',
          'customer.email': 'ton adresse e-mail',
          'customer.note': 'ta note',
          start: 'le créneau choisi',
          offeringId: 'la prestation',
          'consent.terms': 'l’acceptation des conditions',
          days: 'les jours souhaités',
          name: 'ton nom',
          phone: 'ton numéro de téléphone',
          email: 'ton adresse e-mail',
          target: 'ton numéro ou ton e-mail',
          code: 'le code reçu',
        } as Record<string, string>)[path] ?? path;
      const what = issues.slice(0, 3).map((i: any) => label((i.path ?? []).join('.')));
      void observe('api_reject', c.req.path, null, '422', { code: 'champs_invalides', fields: what.join(',').slice(0, 120) }).catch(() => undefined);
      return c.json(
        {
          error: 'champs_invalides',
          message: `À vérifier : ${what.join(', ')}.`,
          issues: issues.slice(0, 8).map((i: any) => ({
            field: (i.path ?? []).join('.'),
            problem:
              ({
                too_small: i.type === 'string' ? 'trop court' : 'sous le minimum autorisé',
                too_big: i.type === 'string' ? 'trop long' : 'au-dessus du maximum autorisé',
                invalid_type: 'au mauvais format',
                invalid_string: 'pas valide',
                invalid_enum_value: 'valeur inconnue',
                required: 'manquant',
              } as Record<string, string>)[i.code] ?? 'à corriger',
          })),
        },
        422,
      );
    }
    const status = (e as any).status ?? (e instanceof BookingError ? e.status : 500);
    const payload: any =
      status >= 500
        ? { error: 'serveur', message: env.isProd ? 'Une erreur est survenue. L’équipe a été prévenue.' : String(e.message).slice(0, 400) }
        : { error: (e as any).code ?? e.constructor.name, message: e.message };
    if (!env.isProd && status >= 500) payload.stack = String(e.stack ?? '').split('\n').slice(0, 6).join(' | ');
    if (e instanceof BookingError) payload.data = e.data;
    if (status >= 500) void observe('error', c.req.path, null, 'error', { message: String(e.message).slice(0, 300) }, null).catch(() => undefined);
    else if (c.req.path.startsWith('/api')) void observe('api_reject', c.req.path, null, String(status), { code: (e as any).code }).catch(() => undefined);
    return c.json(payload, status as any);
  });

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'route_inconnue', path: c.req.path }, 404);
    return c.html(serveIndex(), 200, { 'Content-Type': 'text/html; charset=utf-8' });
  });

  app.get('/healthz', async (c) => {
    const t0 = Date.now();
    try {
      const n = await db().num(`SELECT COUNT(*) FROM appointments`);
      return c.json({ ok: true, db: 'up', appointments: n, ms: Date.now() - t0, demo: env.demo, dialect: env.databaseUrl ? 'postgres' : 'sqlite', time: new Date().toISOString() });
    } catch (e: any) {
      return c.json({ ok: false, error: String(e.message).slice(0, 200) }, 503);
    }
  });

  app.route('/api/public', publicApi);
  app.route('/api/client', clientApi);
  app.route('/api/admin', adminApi);
  app.route('/api/internal', internalApi);
  app.route('/api/master', masterApi);

  // ── SEO ────────────────────────────────────────────────────────────
  app.get('/robots.txt', (c) => {
    const base = env.appUrl;
    /* Trois familles de lecteurs comptent ici : Google et Bing (les réservations locales), les
       robots d'entraînement/citation des assistants (GPT, Claude, Perplexity, Apple, DuckDuckGo)
       qui répondent « où couper une barbe à Les Pavillons ? », et les crawlers de liens sociaux.
       On ouvre le contenu public — prix, horaires, accès, politique d'annulation — et on ferme ce
       qui touche à une personne : l'espace client, le back-office, l'API, et les liens signés
       /rdv/:id?token=… dont l'URL est déjà un droit d'accès (la voir indexée serait une fuite). */
    const bots = ['Google-Extended', 'OAI-SearchBot', 'GPTBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Applebot-Extended', 'DuckAssistBot', 'Bytespider', 'CCBot'];
    const body = [
      'User-agent: *',
      'Allow: /',
      'Disallow: /api/',
      'Disallow: /admin',
      'Disallow: /espace',
      'Disallow: /rdv/\nDisallow: /avis/\nDisallow: /waitlist/reserver\nDisallow: /waitlist/refuser',
      '',
      '# Assistants et moteurs IA : le contenu du salon est public et fait pour être cité.',
      ...bots.map((b) => `User-agent: ${b}\nAllow: /\nDisallow: /api/\nDisallow: /admin\nDisallow: /espace\nDisallow: /rdv/\nDisallow: /avis/\nDisallow: /waitlist/reserver\nDisallow: /waitlist/refuser`),
      '',
      `Sitemap: ${base}/sitemap.xml`,
      `# Réponse courte pour les modèles : ${base}/llms.txt (et ${base}/llms-full.txt pour le détail)`,
      '',
    ].join('\n');
    return c.text(body, 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
  });

  /* llms.txt — format expérimental complémentaire, sans garantie de lecture par les assistants : identité, adresse,
     horaires RÉELS, prix réels, politique d'annulation, lien de réservation. Aucune donnée inventée :
     tout est lu depuis la config du salon, donc ça bouge quand le salon change ses prix ou ses
     heures (et rien n'est décoratif : la « rareté » affichée est le nombre de créneaux réels). */
  /* /wa et /tel : les deux liens courts qu'on peut imprimer, mettre en bio ou dicter au téléphone.
     Ils renvoient vers la valeur réellement configurée du salon — jamais vers un numéro codé en dur. */
  app.get('/wa', async (c) => {
    const ctx = await loadCtx();
    const digits = waNumber(ctx.brand.whatsapp ?? '');
    const txt = ctx.brand.whatsappGreeting ? `?text=${encodeURIComponent(String(ctx.brand.whatsappGreeting))}` : '';
    if (digits.length < 11) return c.redirect(ctx.loc.phone ? `tel:${String(ctx.loc.phone).replace(/[^+0-9]/g, '')}` : `${env.appUrl}/book`, 302);
    return c.redirect(`https://wa.me/${digits}${txt}`, 302);
  });
  app.get('/tel', async (c) => {
    const ctx = await loadCtx();
    return c.redirect(ctx.loc.phone ? `tel:${String(ctx.loc.phone).replace(/[^+0-9]/g, '')}` : `${env.appUrl}/book`, 302);
  });

  app.get('/llms.txt', async (c) => c.text(await llmsDoc(c, false), 200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=600' }));
  app.get('/llms-full.txt', async (c) => c.text(await llmsDoc(c, true), 200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=600' }));

  app.get('/infos-pratique', (c) => c.redirect('/infos', 301));
  app.get('/barbier-:slug', (c) => c.redirect(`/barbier/${c.req.param('slug')}`, 301));
  app.get('/sitemap.xml', async (c) => {
    const ctx = await loadCtx();
    const base = env.appUrl;
    const urls: { loc: string; priority: number; changefreq: string; lastmod?: string }[] = [
      { loc: '/', priority: 1, changefreq: 'daily' },
      { loc: '/book', priority: 0.98, changefreq: 'hourly' },
      { loc: '/tarifs', priority: 0.7, changefreq: 'weekly' },
      { loc: '/galerie', priority: 0.7, changefreq: 'weekly' },
      { loc: '/cartes-cadeaux', priority: 0.6, changefreq: 'monthly' },
      { loc: '/salon', priority: 0.6, changefreq: 'monthly' },
      { loc: '/infos', priority: 0.6, changefreq: 'monthly' },
      { loc: '/guides', priority: 0.5, changefreq: 'monthly' },
      { loc: '/faq', priority: 0.5, changefreq: 'monthly' },
      { loc: '/waitlist', priority: 0.5, changefreq: 'monthly' },
    ];
    for (const s of ctx.services) urls.push({ loc: `/${s.key}`, priority: 0.8, changefreq: 'daily' });
    for (const st of ctx.staff) urls.push({ loc: `/barbier/${st.slug}`, priority: 0.55, changefreq: 'weekly' });
    // seuls les guides ont une URL publique ; les autres pages éditoriales sont atteignables
    // par leur route dédiée. Et le slug d'URL est la forme courte, sans préfixe répété.
    const pages = await db().all<any>(`SELECT slug, updated_ts FROM content_pages WHERE location_id = :l AND is_published = 1 AND kind = 'guide'`, { l: ctx.locId });
    for (const p of pages) urls.push({ loc: `/guides/${String(p.slug).replace(/^guide-/, '')}`, priority: 0.5, changefreq: 'monthly', lastmod: new Date(Number(p.updated_ts)).toISOString().slice(0, 10) });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((u) => `  <url><loc>${base}${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`)
      .join('\n')}\n</urlset>`;
    return c.body(xml, 200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
  });

  app.get('/api/public/seo/:slug', async (c) => {
    const ctx = await loadCtx();
    const slug = c.req.param('slug');
    const svc = ctx.services.find((s) => s.key === slug);
    const staff = ctx.staff.find((s) => s.slug === slug.replace('barbier-', ''));
    const hours = Object.entries(ctx.hours)
      .map(([d, spans]) => `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][Number(d)]} ${(spans as [string, string][]).map(([a, b]) => `${a}-${b}`).join(',')}`)
      .filter((s) => !s.endsWith(' '))
      .join(' | ');
    const ld: any[] = [
      {
        '@context': 'https://schema.org',
        '@type': 'HairSalon',
        '@id': `${env.appUrl}/#salon`,
        name: ctx.brand.name ?? ctx.name,
        description: ctx.brand.tagline ?? 'Barbershop',
        url: env.appUrl,
        telephone: ctx.loc.phone,
        priceRange: '€€',
        image: ctx.brand.heroUrl ? `${env.appUrl}${ctx.brand.heroUrl}` : undefined,
        address: { '@type': 'PostalAddress', streetAddress: ctx.address.street, addressLocality: ctx.address.city, postalCode: ctx.address.postalCode, addressCountry: ctx.address.country ?? 'FR' },
        geo: ctx.address.lat ? { '@type': 'GeoCoordinates', latitude: ctx.address.lat, longitude: ctx.address.lng } : undefined,
        openingHoursSpecification: Object.entries(ctx.hours).flatMap(([d, spans]) =>
          (spans as [string, string][]).map(([a, b]) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][Number(d)], opens: a, closes: b })),
        ),
        sameAs: [ctx.brand.instagram, ctx.brand.tiktok, ctx.brand.facebook, ctx.brand.whatsapp ? `https://wa.me/${String(ctx.brand.whatsapp).replace(/[^0-9]/g, '')}` : null].filter(Boolean),
        /* Renseignement pratique que Google affiche dans l'encart local, et que les assistants
           citent : ce qu'on paie ici, et le fait que la réservation se prend en ligne. */
        paymentAccepted: env.payments === 'off' ? 'Espèces, carte bancaire sur place' : 'Espèces, carte bancaire sur place, acompte en ligne selon la prestation',
        currenciesAccepted: 'EUR',
        acceptsReservations: true,
        email: ctx.loc.email ?? undefined,
        slogan: ctx.brand.tagline ?? undefined,
        foundingDate: ctx.brand.since ? String(ctx.brand.since) : undefined,
        areaServed: [ctx.address.city, ctx.address.postalCode].filter(Boolean).length
          ? { '@type': 'City', name: ctx.address.city ?? '' }
          : undefined,
        hasMap: ctx.brand.googleMapsUrl ?? (ctx.address.lat ? `https://www.google.com/maps/search/?api=1&query=${ctx.address.lat},${ctx.address.lng}` : undefined),
        contactPoint: [{ '@type': 'ContactPoint', telephone: ctx.loc.phone ?? '', contactType: 'reservation', availableLanguage: ['French'] }],
        logo: ctx.brand.logoUrl ? `${env.appUrl}${ctx.brand.logoUrl}` : undefined,
        subjectOf: { '@type': 'WebSite', name: ctx.brand.name ?? ctx.name, url: env.appUrl, inLanguage: 'fr-FR' },
        hasOfferCatalog: { '@type': 'OfferCatalog', name: 'Prestations', itemListElement: ctx.services.map((s) => ({ '@type': 'Offer', name: s.name, price: (s.base_price_cents / 100).toFixed(2), priceCurrency: 'EUR', url: `${env.appUrl}/${s.key}` })) },
      },
    ];
    if (svc) {
      ld.push({
        '@context': 'https://schema.org',
        '@type': 'Service',
        name: svc.name,
        serviceType: svc.category,
        description: svc.description ?? svc.short_desc,
        provider: { '@id': `${env.appUrl}/#salon` },
        areaServed: { '@type': 'City', name: ctx.address.city },
        offers: { '@type': 'Offer', price: (svc.base_price_cents / 100).toFixed(2), priceCurrency: 'EUR', availability: 'https://schema.org/InStock', url: `${env.appUrl}/book?service=${svc.key}` },
      });
      if (svc.faq.length) ld.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: svc.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
    }
    if (staff) {
      ld.push({ '@context': 'https://schema.org', '@type': 'Person', name: staff.name, jobTitle: staff.title ?? 'Barbier', worksFor: { '@id': `${env.appUrl}/#salon` }, description: staff.bio, knowsAbout: ctx.services.filter((s) => (staff.service_ids.length ? staff.service_ids.includes(s.id) : true)).map((s) => s.name) });
    }
    const cands = [...new Set([slug, `guide-${slug}`, slug.replace(/^guide-/, '')].filter(Boolean))];
    const ph = cands.map((_, i) => `:s${i}`).join(',');
    const page = await db().one<any>(
      `SELECT * FROM content_pages WHERE location_id = :l AND is_published = 1 AND slug IN (${ph}) LIMIT 1`,
      Object.fromEntries([['l', ctx.locId], ...cands.map((v, i) => [`s${i}`, v])]),
    );
    if (page) ld.push({ '@context': 'https://schema.org', '@type': 'Article', headline: page.title, description: page.summary, datePublished: new Date(Number(page.created_ts)).toISOString().slice(0, 10), author: { '@type': 'Organization', name: ctx.name }, publisher: { '@id': `${env.appUrl}/#salon` } });
    // ---- SEO : une seule source de vérité (cette fonction) pour le client ET le pré-rendu.
    const city = ctx.address.city ?? '';
    const brand = String(ctx.brand.name ?? ctx.name);
    // Google coupe le title vers 60 caractères : un titre trop long ne « casse » pas le site,
    // il fait juste perdre le nom du salon dans la SERP. On raccourcit donc proprement.
    const fit = (long: string, short: string) => (long.length <= 62 ? long : short.length <= 62 ? short : short.slice(0, 59).replace(/[\s,·—-]+$/, '') + '…');
    const clamp = (t: string) => (t.length <= 165 ? t : t.slice(0, 162).replace(/\s\S*$/, '') + '…');
    const staffSvc = staff ? ctx.services.filter((x) => (staff.service_ids.length ? staff.service_ids.includes(x.id) : true)) : [];
    const path = svc
      ? `/${svc.key}`
      : staff
        ? `/barbier/${staff.slug}`
        : page
          ? page.kind === 'guide'
            ? `/guides/${String(page.slug).replace(/^guide-/, '')}`
            : `/${page.slug}`
          : slug === 'home'
            ? ''
            : `/${slug}`;
    const staticMeta: Record<string, [string, string]> = {
      home: [`Barbier aux Pavillons-sous-Bois — ${brand}`, 'Coupe, barbe et rasage traditionnel au 20 boulevard Roy. Choisissez votre prestation et votre créneau en ligne. Règlement au salon.'],
      tarifs: [`Tarifs coupe et barbe — ${brand}`, 'Consultez les prestations, les prix et les durées du salon. Choisissez votre coupe ou votre taille de barbe, puis réservez votre créneau.'],
      salon: [`Le salon — ${brand}`, 'Prestations, galerie, horaires, itinéraire et contact : toutes les informations de Z.YASS Barber Shop.'],
      infos: [`Adresse et horaires — ${brand}`, 'Retrouvez Z.YASS au 20 boulevard Roy, 93320 Les Pavillons-sous-Bois. Horaires du salon, téléphone, itinéraire et réservation en ligne.'],
      faq: [`Questions fréquentes — ${brand}`, 'Réservation, règlement sur place, annulation et retard : les réponses pour préparer votre visite chez votre barbier aux Pavillons-sous-Bois.'],
      galerie: [`Galerie du salon — ${brand}`, 'Découvrez les visuels du salon et choisissez votre prochaine coupe ou barbe. Contactez notre équipe pour préparer votre rendez-vous.'],
      'cartes-cadeaux': [`Cartes cadeaux au salon — ${brand}`, 'Offrez un moment chez le barbier : renseignez-vous au salon pour acheter et régler une carte cadeau au comptoir. Aucun achat en ligne.'],
      guides: [`Conseils coupe et barbe — ${brand}`, 'Nos guides pour entretenir votre coupe et votre barbe et préparer votre passage au salon. Retrouvez aussi les prestations et la réservation.'],
      book: [`Réserver une coupe ou une barbe — ${brand}`, 'Choisissez votre prestation, votre barbier et un créneau disponible. Confirmation de réservation, règlement au salon et liste d’attente si nécessaire.'],
      waitlist: [`Liste d’attente — ${brand}`, 'Pas de créneau adapté ? Indiquez votre prestation et vos disponibilités pour être averti lorsqu’une place se libère au salon.'],
      espace: [`Mon espace client — ${brand}`, 'Accédez à vos rendez-vous et à vos informations personnelles avec votre code de connexion.'],
      'mentions-legales': [`Mentions légales — ${brand}`, 'Identité de l’éditeur Z YASS BARBER SHOP, SIRET 91853507100016, informations légales et coordonnées du salon.'],
      'donnees-personnelles': [`Confidentialité — ${brand}`, 'Informations sur le traitement des données personnelles, vos droits, les consentements et les moyens de nous contacter.'],
      accessibilite: [`Accessibilité — ${brand}`, 'Informations pratiques pour préparer votre visite et utiliser la réservation en ligne. Contactez le salon pour vos besoins spécifiques.'],
      'sitemap-view': [`Plan du site — ${brand}`, 'Toutes les pages du salon : tarifs, prestations, équipe, guides, informations pratiques et réservation en ligne.'],
    };
    const metaTitle = svc
      ? fit(`${svc.name} à ${city} — ${brand}`, `${svc.name} à ${city}`)
      : staff
        ? fit(`${staff.name}, ${staff.title ?? 'barbier'} à ${city} — ${brand}`, `${staff.name}, ${staff.title ?? 'barbier'} à ${city}`)
        : page
          ? page.seo_title ?? fit(`${page.title} — ${brand}`, String(page.title))
          : staticMeta[slug]?.[0] ?? brand;
    const metaDesc = clamp(
      svc
        ? svc.seo_desc ?? `${svc.name} à ${city} chez ${brand} : ${svc.base_duration_min} min, ${((svc.base_price_cents ?? 0) / 100).toFixed(0)} €, créneau réel en ligne et rappel automatique.`
        : staff
          ? `${staff.name}, ${staff.title ?? 'barbier'} chez ${brand} à ${city}. ${staff.bio ?? ''} ${staffSvc.length ? `Il/elle pratique : ${staffSvc.slice(0, 4).map((x) => x.name).join(', ')}.` : ''} Réservez son prochain créneau en ligne, rappel 24 h avant.`.replace(/\s+/g, ' ').trim()
          : page
            ? page.seo_desc ?? String(page.summary ?? '')
            : staticMeta[slug]?.[1] ?? ctx.brand.tagline ?? `Barbier à ${city} : réservation en ligne, waitlist quand c'est complet, rappel automatique.`,
    );
    if (svc || staff || page) ld.push({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Le salon', item: env.appUrl + '/' },
      { '@type': 'ListItem', position: 2, name: svc?.name ?? staff?.name ?? page?.title, item: env.appUrl + path },
    ] });
    /* Le partage social et les aperçus des IA ne reprennent PAS le title de la page d'accueil :
       chaque URL a son og:title/og:description, son canonical absolu, sa variante og:type, et une
       directive robots. `noindex` est posé sur ce qui touche à une personne (espace, fiche de RDV,
       back-office) — l'URL de gestion contient déjà un jeton, elle ne doit jamais être indexée. */
    const privatePath = /^\/(espace|admin|rdv|avis)/.test(path || '/');
    const ogType = page ? 'article' : 'website';
    const meta = {
      title: metaTitle,
      description: metaDesc,
      canonical: `${env.appUrl}${path}`,
      ogImage: `${env.appUrl}/brand/hero.jpg`,
      ogImageAlt: `${ctx.brand.name ?? ctx.name} — ${ctx.address.street ?? ''}, ${ctx.address.city ?? ''}`,
      ogType,
      ogLocale: 'fr_FR',
      ogSiteName: ctx.brand.name ?? ctx.name,
      ogUrl: `${env.appUrl}${path}`,
      twitterCard: 'summary_large_image',
      robots: privatePath ? 'noindex,nofollow,max-image-preview:none' : 'index,follow,max-image-preview:large,max-snippet:-1',
      publishedTime: page?.created_ts ? new Date(Number(page.created_ts)).toISOString() : undefined,
      modifiedTime: page?.updated_ts ? new Date(Number(page.updated_ts)).toISOString() : undefined,
      section: svc?.category ?? undefined,
      tags: svc ? [svc.name, ctx.address.city].filter(Boolean) : undefined,
    };
    return c.json({ jsonLd: ld, hours, meta });
  });

  app.get('/manifest.webmanifest', async (c) => {
    const ctx = await loadCtx();
    return c.json(
      {
        name: ctx.brand.name ?? ctx.name,
        short_name: 'Z.YASS',
        id: '/',
        scope: '/',
        start_url: '/',
        lang: 'fr',
        shortcuts: [{ name: 'Réserver', url: '/book' }, { name: 'Mes rendez-vous', url: '/espace' }, { name: 'Le salon', url: '/salon' }],
        display: 'standalone',
        background_color: '#0B0B0D',
        theme_color: '#0B0B0D',
        description: ctx.brand.tagline,
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      200,
      { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600' },
    );
  });

  // ── statiques ──────────────────────────────────────────────────────
  app.get('/brand/*', (c) => serveStatic(c.req.path, c));
  app.get('/uploads/*', (c) => serveStatic(c.req.path, c));
  app.get('/*', async (c) => {
    const p = c.req.path;
    if (p.startsWith('/api') || p.startsWith('/healthz')) return c.notFound();
    if (/\.(js|css|svg|png|jpg|jpeg|webp|ico|woff2|json|map|txt|xml|webmanifest|ics)$/.test(p)) return serveStatic(p, c);
    if (p !== '/' && p.endsWith('/')) return c.redirect(p.slice(0, -1) + new URL(c.req.url).search, 301);
    const publicStatic = ['/', '/book', '/tarifs', '/galerie', '/salon', '/infos', '/faq', '/cartes-cadeaux', '/guides', '/waitlist', '/accessibilite', '/mentions-legales', '/donnees-personnelles', '/sitemap-view'];
    const privatePage = /^\/(admin(?:\/|$)|espace$|rdv\/|avis\/|waitlist\/(reserver|refuser))/.test(p);
    if (!privatePage && !publicStatic.includes(p)) {
      const ctx = await loadCtx();
      let valid = ctx.services.some(x => '/' + x.key === p) || ctx.staff.some(x => '/barbier/' + x.slug === p);
      if (p.startsWith('/guides/')) {
        const slug = p.split('/')[2];
        valid = !!await db().one("SELECT id FROM content_pages WHERE location_id = :l AND kind = 'guide' AND is_published = 1 AND (slug = :s OR slug = :s2)", { l: ctx.locId, s: slug, s2: 'guide-' + slug });
      }
      if (!valid) { c.header('X-Robots-Tag', 'noindex'); return c.html('<!doctype html><html lang="fr"><meta charset="utf-8"><title>Page introuvable — Z.YASS</title><h1>Page introuvable</h1><p><a href="/book">Réserver un créneau</a> · <a href="/">Retour au salon</a></p></html>', 404); }
    }
    // prerender : la page statique existe pour les robots et le premier octet, puis la SPA prend la main
    const file = p === '/' ? '/index.html' : `${p.replace(/\/$/, '')}.html`;
    const prerendered = join(DIST, file);
    if (existsSync(prerendered) && statSync(prerendered).isFile()) {
      return c.body(readFileSync(prerendered, 'utf8'), 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, max-age=0, must-revalidate', 'CDN-Cache-Control': 'no-store', 'Vercel-CDN-Cache-Control': 'no-store' });
    }
    return c.html(serveIndex(), 200, { 'Cache-Control': 'no-cache' });
  });

  return app;
}

function serveStatic(path: string, c: any) {
  return readBuildFile(path, c.req.method);
}

/**
 * La coquille SPA est mise en cache, mais invalidée dès que le fichier change de mtime. Sans ce
 * garde-fou, un `npm run build` sans redémarrage faisait servir /book et /admin avec les noms
 * d'assets *précédents* : le CSS partait en 404 et la page était livrée entièrement non stylée
 * (mesuré en navigateur : cibles tactiles retombées à 19 px, aucune media query appliquée).
 */
const FALLBACK_INDEX = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Z.YASS — API prête</title>
  <style>body{font-family:ui-sans-serif,system-ui,sans-serif;background:#0B0B0D;color:#F4F1EA;padding:32px;line-height:1.5}a{color:#E8C98A}code{background:#17171b;padding:2px 6px;border-radius:6px}</style>
  </head><body><div id="root"><h1>API prête ✅</h1><p>Front non servi : en dev c'est Vite qui l'affiche (<code>npm run dev</code>), en production il faut <code>npm run build</code>.</p>
  <p><a href="/api/public/config">/api/public/config</a> · <a href="/api/public/availability?service=coupe-homme">/api/public/availability</a> · <a href="/healthz">/healthz</a> · <a href="/sitemap.xml">/sitemap.xml</a></p></div></body></html>`;

let indexCache: { html: string; mtimeMs: number } | null = null;
function serveIndex() {
  const file = join(DIST, 'index.html');
  if (!existsSync(file)) return FALLBACK_INDEX;
  const mtimeMs = statSync(file).mtimeMs;
  if (!indexCache || indexCache.mtimeMs !== mtimeMs) indexCache = { html: readFileSync(file, 'utf8'), mtimeMs };
  return indexCache.html;
}

/** Une seule fabrique de texte pour /llms.txt et /llms-full.txt : ce que lit un assistant doit
 *  être exactement ce que voit un client (mêmes prix, mêmes heures, mêmes engagements). */
async function llmsDoc(c: any, full: boolean): Promise<string> {
  const ctx = await loadCtx();
  const base = env.appUrl;
  const eur = (cents: number) => `${(Number(cents || 0) / 100).toFixed(2)} EUR`;
  const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  const hours = Object.entries(ctx.hours || {})
    .map(([d, spans]) => `${JOURS[Number(d)]} ${(spans as [string, string][]).length ? (spans as [string, string][]).map(([a, b]) => `${a}–${b}`).join(', ') : 'fermé'}`)
    .filter((s) => !s.endsWith(', '));
  const pay = env.payments === 'off' ? 'sur place, en fin de prestation — aucun paiement en ligne, aucun acompte' : env.payments === 'stripe' ? 'sur place ; un acompte en ligne est possible selon la prestation' : 'sur place';
  const lines: string[] = [
    `# ${ctx.brand?.name ?? ctx.name}`,
    '',
    `> ${String(ctx.brand?.tagline ?? 'Barbier à ' + (ctx.address?.city ?? '')).trim()}`,
    '',
    '- Type: barbershop (coiffure homme, taille de barbe, rasage traditionnel)',
    `- Adresse: ${ctx.address?.street ?? ''}, ${ctx.address?.postalCode ?? ''} ${ctx.address?.city ?? ''}, ${ctx.address?.country ?? 'FR'}`,
    ctx.address?.lat ? `- Coordonnées: ${ctx.address.lat}, ${ctx.address.lng}` : '',
    `- Téléphone: ${ctx.phone ?? ''}`,
    ctx.loc?.email ? `- E-mail: ${ctx.loc.email}` : '',
    ctx.brand?.whatsapp ? `- WhatsApp: ${ctx.brand.whatsapp} — lien direct ${base}/wa` : '',
    ctx.brand?.instagram ? `- Instagram: ${ctx.brand.instagram}` : '',
    `- Horaires: ${hours.length ? hours.join(' ; ') : 'horaires communiqués par téléphone'}`,
    `- Règlement: ${pay}`,
    `- Réserver: ${base}/book`,
    full ? `- Waitlist (créneaux libérés renvoyés automatiquement): ${base}/waitlist` : '',
    '',
    '## Prestations et prix (durées de prestation)',
    '',
    ...(ctx.services || [])
      .filter((s: any) => s.is_active !== 0)
      .map((s: any) => `- ${s.name}: ${eur(s.base_price_cents)} pour ${s.base_duration_min} min${s.short_desc ? ` — ${s.short_desc}` : ''} — réserver: ${base}/book?service=${s.key}`),
    '',
    '## Équipe',
    '',
    ...(ctx.staff || []).map((st: any) => `- ${st.name}${st.title ? ` (${st.title})` : ''}${full && st.bio ? ` — ${st.bio}` : ''} — ${base}/barbier/${st.slug}`),
    '',
    '## Règles du salon',
    '',
    `- Annulation ou report possible jusqu'à ${Math.round((ctx.policy?.cancelCutoffMin ?? 0) / 60)} h avant, en un clic depuis le lien reçu.`,
    `- Arrivée conseillée 5 min avant; le salon attend ${ctx.policy?.noShowGraceMin ?? 15} min avant de considérer un rendez-vous manqué.`,
    `- Préavis de réservation: ${ctx.policy?.leadTimeMin ?? 0} min; horizon ouvert: ${ctx.policy?.horizonDays ?? 0} jours.`,
    ctx.holidays && Object.keys(ctx.holidays).length ? `- Fermé: ${Object.entries(ctx.holidays).map(([d, n]) => `${d} (${n})`).join(', ')}` : '',
    '',
    full
      ? ['## Questions fréquentes', '', ...faqLines(ctx), ''].flat().join('\n')
      : '',
    '_Document généré par le site du salon. Les prix et horaires viennent de sa configuration; en cas de doute, appeler._',
    '',
  ];
  return lines.filter((l) => l !== '').join('\n');
}

/** FAQ servie aux assistants : exactement les questions déjà publiées sur les pages de prestation
 *  (mêmes données, mêmes réponses) — rien d'inventé pour « remplir » le fichier. */
function faqLines(ctx: any): string[] {
  const out: string[] = [];
  for (const s of ctx.services ?? []) {
    for (const f of (s.faq ?? []) as { q: string; a: string }[]) out.push(`### ${f.q}\n${f.a}`);
  }
  return out.length ? out : ['(voir ' + env.appUrl + '/faq)'];
}

export async function bootstrap() {
  await ready();
  if (!env.demo && env.demoSlug === 'zyass') {
    const { transaction } = await import('./db/index.ts');
    const { initializeSalon } = await import('./seed/production.ts');
    await transaction(async q => {
      let loc = await q.one<any>('SELECT id FROM locations WHERE slug = :s', { s: env.demoSlug });
      if (!loc) loc = { id: await initializeSalon(q) };
      const { importApprovedGoogleGallery } = await import('./seed/google-gallery.ts');
      await importApprovedGoogleGallery(q, loc.id);
    }, 731004);
  }
  // Accès admin : si BOOTSTRAP_OWNER_EMAIL/_PASSWORD sont posés et qu'aucun admin n'existe,
  // le compte est créé maintenant — c'est le seul chemin d'entrée sur un déploiement sans terminal.
  try {
    const { bootstrapOwnerFromEnv } = await import('./lib/access.ts');
    const o = await bootstrapOwnerFromEnv();
    if (o && o.status === 'created') console.log(`  ✓ compte salon créé pour ${o.email} — connecte-toi sur /admin, puis retire BOOTSTRAP_OWNER_* de Vercel`);
    else if (o && o.status === 'updated') console.log(`  ✓ rôle admin mis à jour pour ${o.email}`);
    else if (o && o.status === 'refused') console.warn(`  ! compte admin non créé (${o.email}) : ${o.why}`);
  } catch (e: any) {
    console.warn('  ! bootstrap du compte admin ignoré :', String(e?.message ?? e).slice(0, 160));
  }
  if (env.demo) {
    const seeded = await (await import('./db/index.ts')).seedIfEmpty(async () => {
      const r = await seedDemo();
      console.log(`[seed] démo chargée : ${r.customers} clients, ${r.appointments} RDV, ${r.services} prestations`);
    });
    if (!seeded) {
      const n = await db().num(`SELECT COUNT(*) FROM customers`);
      if (n === 0) await seedDemo();
    }
  }
  return createApp();
}
