/** En-têtes purs, utilisables sans ouvrir une connexion à la base. */
export function securityHeaders(origin?: string | null) {
  const csp = [
    "default-src 'self'",
    // Pas de 'unsafe-inline' pour les scripts : le build ne produit aucun script inline exécutable
    // (le JSON-LD pré-rendu est un bloc `application/ld+json`, une donnée, pas du code). Garder
    // cette autorisation serait ouvrir grand la porte au XSS injecté pour rien. Si un besoin
    // légitime apparaît (bootstrap inline), préférer un nonce par requête à 'unsafe-inline'.
    "script-src 'self'",
    // Les styles en ligne sont ceux de React (`style={{…}}`) : sans cette autorisation, la mise en
    // page entière saute. D'où l'asymétrie avec script-src ci-dessus.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
    'Content-Security-Policy': csp,
    'Cross-Origin-Opener-Policy': 'same-origin',
    ...(origin ? { Vary: 'Origin' } : {}),
  };
}

