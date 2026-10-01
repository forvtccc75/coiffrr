/**
 * Politique TLS pour Postgres — un fichier pour elle, parce que l'ordre de priorité de `pg`
 * est contre-intuitif et que se tromper ici casse le déploiement chez l'hébergeur.
 *
 * Mesuré le 28/09/2026 contre le pooler Supabase `aws-0-eu-west-2.pooler.supabase.com:5432`
 * (pg 8.13.1, Node 20.20.2) :
 *   A. { connectionString: '…?sslmode=require' }                          → KO self-signed certificate in certificate chain
 *   B. { connectionString: '…?sslmode=require', ssl: {rU:false} }         → KO — même erreur
 *   C. { connectionString: '…' (sans sslmode), ssl: { rejectUnauthorized:false} } → OK en 965 ms
 * Donc : **le `sslmode` de l'URL gagne sur l'option `ssl`** (pg applique la chaîne de connexion en
 * dernier). Un exploitant qui colle l'URL telle que Supabase la propose — avec `?sslmode=require`,
 * comme le demandent la plupart des tutos — obtient un échec de TLS apparenté à un certificat
 * invalide, alors que le certificat de Supabase est simplement autosigné : la chaîne est valide
 * jusqu'à la racine émise par Supabase, absente du magasin système.
 *
 * Règle appliquée ici : on **retire** `sslmode` de l'URL et on l'exprime dans l'option `ssl`,
 * seule façon d'être sûr que notre intention passe. Modes compris :
 *   sslmode=disable      → pas de TLS (local, tunnel, tests)
 *   sslmode=verify-full  → TLS avec vérification de la chaîne et du nom d'hôte
 *   sslmode=no-verify    → TLS sans vérification de la chaîne
 *   sslmode=require / absent sur hôte distant → TLS sans vérification de la chaîne
 *   absent sur hôte local → pas de TLS
 * Un hôte distant sans `sslmode` finit donc chiffré (avant ce correctif, il partait en clair).
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

export type PgOptions = { connectionString: string; ssl?: false | { rejectUnauthorized: boolean } };

/** Les hébergeurs gérés publient une chaîne autosignée : TLS oui, validation de chaîne non. */
const MANAGED_HOSTS = /(supabase|neon\.tech|pooler|\brds\.amazonaws\.com|crunchydata|yandexcloud|render|elephantsql|timescale)/i;

export function pgConnectionOptions(connectionString: string): PgOptions {
  const raw = String(connectionString || '').trim();
  if (!raw) throw new Error('pgConnectionOptions: connectionString vide');
  let host = '';
  let query = '';
  try {
    const u = new URL(raw.replace(/^postgres:/i, 'postgresql:'));
    host = u.hostname.replace(/^\[|\]$/g, '');
    query = u.search;
  } catch {
    // chaîne au format mots-clés (`host=… sslmode=…`) : on la laisse telle quelle, on ne touche pas au ssl
    return { connectionString: raw, ssl: undefined };
  }
  const mode = (/[?&]sslmode=([^&]*)/i.exec(query)?.[1] || '').toLowerCase();
  const local = LOCAL_HOSTS.has(host);
  // `sslmode` est retiré de l'URL : sinon pg le rejoue par-dessus notre option.
  const clean = query ? raw.replace(/([?&])sslmode=[^&]*(&?)/, (m, p1, p2) => (p2 ? p1 : '')).replace(/[?&]$/, '') : raw;

  let ssl: PgOptions['ssl'];
  if (mode === 'disable') ssl = false;
  else if (mode === 'verify-full' || mode === 'verify-ca') ssl = { rejectUnauthorized: true };
  else if (mode === 'no-verify' || mode === 'require' || mode === 'prefer' || mode === 'allow') ssl = { rejectUnauthorized: false };
  else if (local) ssl = undefined;
  else ssl = { rejectUnauthorized: false };
  if (!local && ssl !== false && MANAGED_HOSTS.test(host) && mode !== 'verify-full' && mode !== 'verify-ca') {
    ssl = { rejectUnauthorized: false };
  }
  return { connectionString: clean, ssl };
}
