import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/** Le HTML pré-rendu sert les robots ; ces mêmes métadonnées suivent la navigation SPA. */
export function RouteSeo() {
  const { pathname } = useLocation();
  useEffect(() => {
    const controller = new AbortController();
    const set = (attr: 'name' | 'property', name: string, content: string) => {
      const nodes = [...document.querySelectorAll<HTMLMetaElement>(`meta[${attr}="${name}"]`)];
      const el = nodes.shift() ?? document.createElement('meta');
      nodes.forEach(n => n.remove());
      el.setAttribute(attr, name); el.content = content; document.head.appendChild(el);
    };
    if (/^\/(admin|espace|rdv|avis)(\/|$)|^\/waitlist\/(reserver|refuser)/.test(pathname)) {
      set('name', 'robots', 'noindex,nofollow');
      document.title = pathname.startsWith('/admin') ? 'Administration — Z.YASS' : 'Espace privé — Z.YASS';
      return () => controller.abort();
    }
    const slug = pathname === '/' ? 'home' : pathname.startsWith('/barbier/') ? 'barbier-' + pathname.split('/')[2] : pathname.startsWith('/guides/') ? pathname.split('/')[2] : pathname.slice(1);
    fetch('/api/public/seo/' + encodeURIComponent(slug), { signal: controller.signal })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.meta || controller.signal.aborted) return;
        const m = data.meta;
        document.title = m.title;
        set('name', 'description', m.description);
        set('name', 'robots', m.robots);
        for (const [key, value] of Object.entries({ title: m.title, description: m.description, url: m.canonical, image: m.ogImage, type: m.ogType, locale: m.ogLocale })) set('property', 'og:' + key, String(value ?? ''));
        set('name', 'twitter:title', m.title); set('name', 'twitter:description', m.description);
        let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
        if (!canonical) { canonical = document.createElement('link'); canonical.rel = 'canonical'; document.head.appendChild(canonical); }
        canonical.href = m.canonical;
        document.querySelectorAll('script[type="application/ld+json"]').forEach(n => n.remove());
        const ld = document.createElement('script'); ld.type = 'application/ld+json'; ld.textContent = JSON.stringify(data.jsonLd); document.head.appendChild(ld);
      }).catch(() => { /* réseau indisponible : conserver le head pré-rendu */ });
    return () => controller.abort();
  }, [pathname]);
  return null;
}
