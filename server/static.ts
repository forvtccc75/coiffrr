/** Livraison des fichiers compilés SANS env.ts, DB, migration ou initialisation du salon.
 * Chargé séparément par l'adaptateur Vercel AVANT le backend. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { securityHeaders } from '../shared/http-security.ts';
const DIST = resolve(process.cwd(), 'dist/client');
const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
};
const PUBLIC = new Set(['/', '/book', '/tarifs', '/galerie', '/salon', '/infos', '/faq', '/cartes-cadeaux', '/guides', '/waitlist', '/accessibilite', '/mentions-legales', '/donnees-personnelles', '/sitemap-view']);
const PRIVATE = /^\/(admin(?:\/|$)|espace$|rdv\/|avis\/|waitlist\/(?:reserver|refuser)$)/;
const missing = () => new Response('Fichier introuvable', { status: 404, headers: { ...securityHeaders(), 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
export function readBuildFile(path: string, method = 'GET', privatePage = false): Response {
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return missing(); }
  const file = resolve(DIST, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
  if (decoded.includes('\\') || !file.startsWith(DIST + '/') || !MIME[extname(file)] || !existsSync(file) || !statSync(file).isFile()) return missing();
  const html = extname(file) === '.html';
  const hashed = /^\/assets\/[^/]+-[\w-]{8,}\.(?:js|mjs|css)$/.test(decoded);
  return new Response(method === 'HEAD' ? null : readFileSync(file), { headers: {
    ...securityHeaders(), 'Content-Type': MIME[extname(file)],
    'Cache-Control': privatePage ? 'private, no-store' : html ? 'no-cache, max-age=0, must-revalidate' : hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
    ...(html ? { 'CDN-Cache-Control': 'no-store', 'Vercel-CDN-Cache-Control': 'no-store' } : {}),
    ...(privatePage ? { 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Referrer-Policy': 'no-referrer' } : {}),
  } });
}
export function servePublicFile(path: string, method = 'GET', privateQuery = false): Response | null {
  if (!['GET', 'HEAD'].includes(method) || path.startsWith('/api/') || path === '/api') return null;
  if (/^\/(?:assets|brand|gallery|uploads)\//.test(path) || MIME[extname(path)]) return readBuildFile(path, method);
  if (PUBLIC.has(path) || PRIVATE.test(path)) {
    const page = path === '/' || PRIVATE.test(path) ? '/index.html' : path + '.html';
    const available = existsSync(resolve(DIST, '.' + page));
    return readBuildFile(available ? page : '/index.html', method, PRIVATE.test(path) || privateQuery);
  }
  return null;
}
