/** Adaptateur Vercel : ne jamais importer ../server/*.ts au runtime.
 * `npm run build:server` compile ce graphe dans dist/server/app.cjs.
 * vercel.json inclut dist/** dans la fonction, y compris le HTML pré-rendu.
 */
let appPromise: Promise<any> | undefined;
// @ts-ignore -- artefact autonome généré au build, aucun import TypeScript au runtime.
const staticPromise = import('../dist/server/static.cjs').then((m: any) => m.default ?? m);

function getApp() {
  if (!appPromise) {
    // @ts-ignore -- artefact généré par build:server, absent avant le premier build.
    appPromise = import('../dist/server/app.cjs')
      .then((module: any) => (module.default ?? module).bootstrap())
      .catch((error: unknown) => { appPromise = undefined; throw error; });
  }
  return appPromise!;
}

export default async function handler(req: any, res: any) {
  try {
    const first = (v: unknown) => String(Array.isArray(v) ? v[0] : v ?? '').split(',')[0].trim();
    const host = first(req.headers['x-forwarded-host'] || req.headers.host) || 'localhost';
    const proto = first(req.headers['x-forwarded-proto']) === 'http' ? 'http' : 'https';
    const url = new URL(req.url ?? '/', `${proto}://${host}`);
    const statics = await staticPromise;
    const file = statics.servePublicFile(url.pathname, req.method ?? 'GET', url.searchParams.has('token'));
    if (file) {
      res.statusCode = file.status;
      file.headers.forEach((value: string, key: string) => res.setHeader(key, value));
      res.end(Buffer.from(await file.arrayBuffer()));
      return;
    }
    const app = await getApp();
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers ?? {})) {
      if (Array.isArray(value)) value.forEach(x => headers.append(key, String(x)));
      else if (value !== undefined) headers.set(key, String(value));
    }
    let body: any;
    if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) {
      if (req.rawBody !== undefined) body = req.rawBody;
      else if (req.body !== undefined) {
        body = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body);
        if (!headers.has('content-type') && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) headers.set('content-type', 'application/json');
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (chunks.length) body = Buffer.concat(chunks);
      }
    }
    const response = await app.fetch(new Request(url, { method: req.method ?? 'GET', headers, body }));
    res.statusCode = response.status;
    response.headers.forEach((value: string, key: string) => {
      if (key.toLowerCase() !== 'set-cookie') res.setHeader(key, value);
    });
    // ServerResponse n'a pas res.append() (méthode Express). Utiliser l'API Node standard.
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error: any) {
    // Pas de chaîne de connexion, de clé ou de détails SQL dans la réponse publique.
    const message = String(error?.message ?? 'échec serveur').replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, '[DATABASE_URL masquée]');
    console.error('[vercel-runtime]', error?.code ?? error?.name ?? 'Error', message);
    if (!res.headersSent) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Retry-After', '30');
      res.end(JSON.stringify({ error: 'server_unavailable', message: 'Le service est temporairement indisponible. Réessaie dans un instant.' }));
    } else res.end();
  }
}
