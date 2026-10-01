/* Réseau uniquement : jamais de cache de disponibilité, de token, de réponse API ou d'ancien JS. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0b0b0d"><title>Connexion nécessaire — Z.YASS</title><style>body{background:#0b0b0d;color:#f4f1ea;font:16px/1.65 system-ui;padding:64px 24px;max-width:480px;margin:auto}small{color:#e8c98a;letter-spacing:.2em}h1{font:38px Georgia}a{display:block;background:#e8c98a;color:#17130d;padding:14px 20px;border-radius:15px;text-decoration:none;text-align:center;margin:16px 0}</style><small>Z.YASS BARBER SHOP</small><h1>On se retrouve dans un instant.</h1><p>Reconnecte-toi pour consulter les disponibilités ou gérer tes rendez-vous. Aucune réservation n’a été effectuée hors connexion.</p><a href="/">Réessayer</a><a href="tel:+33644048385">Appeler le salon</a></html>`, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })));
});
