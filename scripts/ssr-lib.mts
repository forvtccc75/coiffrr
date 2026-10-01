/**
 * Plomberie SSR commune : pré-rendu statique (`scripts/prerender.mts`) et tests de rendu
 * (`tests/render.test.ts`) doivent rendre exactement le même arbre, avec la vraie API dans le
 * même process. Deux implémentations séparées finissent toujours par tester une maquette.
 *
 * Contrainte volontaire : aucun créneau, aucun solde, aucun état comptable n'est figé ici —
 * seules les données de configuration (prix, horaires, équipe) entrent dans le HTML statique,
 * sinon la page afficherait une disponibilité fausse (règle « zéro fausse rareté »).
 */

let booted: { cfg: any; app: any } | null = null;

/** Démarre l'API en mémoire, route le `fetch` du client dessus, charge la config du salon. */
export async function bootSsr() {
  if (booted) return booted;
  process.env.TZ = process.env.TZ || 'Europe/Paris';
  const { bootstrap } = await import('../server/app.ts');
  const app = await bootstrap();
  (globalThis as any).fetch = async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;
    const headers = new Headers(init.headers ?? {});
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    return app.request(path, { ...init, headers });
  };
  const { loadCfg } = await import('../client/src/lib/api.ts');
  await loadCfg(true).catch(() => null);
  const cfg: any = await loadCfg().catch(() => null);
  booted = { cfg, app };
  return booted;
}

/** Rend tout l'arbre (lazy inclus) : on attend onAllReady puis on accumule le flux. */
export async function renderFull(el: any, timeoutMs = 10_000): Promise<string> {
  const { renderToPipeableStream } = await import('react-dom/server');
  const { Writable } = await import('node:stream');
  return new Promise((res, rej) => {
    let buf = '';
    let err: any = null;
    let done = false;
    const sink = new Writable({
      write(chunk: any, _enc: any, cb: any) {
        buf += chunk.toString('utf8');
        cb();
      },
    });
    const fail = (e: any) => {
      if (done) return;
      done = true;
      rej(e ?? new Error('rendu impossible'));
    };
    const { pipe } = (renderToPipeableStream as any)(el, {
      onAllReady() {
        pipe(sink);
      },
      onError(e: any) {
        err = e;
      },
      onShellError: fail,
    });
    sink.on('finish', () => {
      if (done) return;
      done = true;
      res(buf);
    });
    sink.on('error', fail);
    setTimeout(() => {
      if (buf.length > 400) {
        done = true;
        res(buf); /* shell + ce qui était prêt : mieux que rien */
      } else fail(err ?? new Error('timeout de rendu'));
    }, timeoutMs);
  });
}

/** Une route du client, rendue côté serveur, renvoyée en HTML (sans <html>/<head>). */
export async function renderPath(path: string, timeoutMs = 10_000): Promise<string> {
  await bootSsr();
  const { createElement } = await import('react');
  const { StaticRouter } = await import('react-router-dom/server');
  const { Toasts } = await import('../client/src/lib/ui.tsx');
  const { default: Router } = await import('../client/src/router.tsx');
  return renderFull(createElement(Toasts, null, createElement(StaticRouter as any, { location: path }, createElement(Router))), timeoutMs);
}

/** Textes visibles uniquement : sans balises, pour des assertions qui ne dépendent pas du markup. */
export function textOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;|'/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
