import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Minimal .env loader (no dependency): only sets variables that are not already defined.
const root = process.env.APP_ROOT || process.cwd();
for (const f of ['.env', '.env.local']) {
  const p = resolve(root, f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim().replace(/^['"]|['"]$/g, '');
    if (process.env[m[1]] === undefined && v !== '') process.env[m[1]] = v;
  }
}

const bool = (v: string | undefined, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

const isProd = process.env.NODE_ENV === 'production' || bool(process.env.IS_PROD);

export const env = {
  isProd,
  port: int(process.env.PORT, 8787),
  appUrl: (process.env.APP_URL || `http://localhost:${int(process.env.PORT, 8787)}`).replace(/\/$/, ''),
  tz: process.env.TIMEZONE || 'Europe/Paris',
  // Le mode démo (comptes `demo-owner`, seed automatique, notifications stdout) ne peut PAS être
  // implicite en production : `NODE_ENV=production` seul doit l'éteindre. Sans cette règle, un
  // déploiement qui oublie DEMO_MODE=0 laisse un login owner/mot-de-passe-de-démo branché sur la vraie
  // base du salon — mesuré comme risque le 21/09, verrouillé par tests/env.test.ts.
  demo: process.env.DEMO_MODE === undefined ? !isProd : bool(process.env.DEMO_MODE),
  // Le salon servi quand la requête ne précise rien (pas de sous-domaine, pas de ?loc=). Un seul
  // déploiement peut héberger plusieurs salons : c'est le Host qui choisit, et ceci qui répond quand
  // rien ne choisit. À fixer sur l'environnement du projet (`DEMO_SLUG`) pour un déploiement mono-salon.
  demoSlug: process.env.DEMO_SLUG || 'zyass',
  trustProxy: bool(process.env.TRUST_PROXY, true),
  dataFile: process.env.DATA_FILE || './data/zyass.db',
  databaseUrl: process.env.DATABASE_URL || '',
  sessionSecret: process.env.SESSION_SECRET || 'dev-session-secret-change-me-0123456789',
  tokenSecret: process.env.TOKEN_SECRET || 'dev-token-secret-change-me-0123456789',
  cronSecret: process.env.CRON_SECRET || 'dev-cron-secret',
  /* `off` (ou `none`) = aucun paiement en ligne, rien ne part chez un PSP : le salon encaisse
     sur place. Ce n'est pas un habillage : les acomptes deviennent 0, l'achat de carte cadeau en
     ligne répond « au comptoir », et rien n'est jamais marqué payé par défaut. */
  payments: (['off', 'none'].includes((process.env.PAYMENTS_PROVIDER || '').toLowerCase())
    ? 'off'
    : (process.env.PAYMENTS_PROVIDER || (isProd ? 'off' : 'demo'))) as 'demo' | 'stripe' | 'off',
  /* Créer le premier compte salon sans terminal : BOOTSTRAP_OWNER_EMAIL + BOOTSTRAP_OWNER_PASSWORD.
     Lu au démarrage, agit une seule fois (s'il n'existe déjà aucun owner), puis à retirer. */
  ownerBootstrap: {
    email: (process.env.BOOTSTRAP_OWNER_EMAIL || '').trim().toLowerCase(),
    password: process.env.BOOTSTRAP_OWNER_PASSWORD || '',
    name: (process.env.BOOTSTRAP_OWNER_NAME || '').trim(),
  },
  stripeSecret: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhook: process.env.STRIPE_WEBHOOK_SECRET || '',
  emailProvider: (process.env.EMAIL_PROVIDER || 'stdout') as 'stdout' | 'resend' | 'brevo',
  emailFrom: process.env.EMAIL_FROM || 'Z.YASS Barber Shop <no-reply@example.com>',
  brevoKey: process.env.BREVO_API_KEY || '',
  emailFromName: process.env.EMAIL_FROM_NAME || 'Z.YASS Barber Shop',
  emailReplyTo: process.env.EMAIL_REPLY_TO || '',
  resendKey: process.env.RESEND_API_KEY || '',
  smsProvider: (process.env.SMS_PROVIDER || 'stdout') as 'stdout' | 'twilio',
  /* WhatsApp a son propre fournisseur : en France un barbier est joignable là, et le contrat
     d'envoi (Cloud API Meta, gabarit validé) n'a rien à voir avec Twilio. Sans configuration,
     on retombe sur Twilio si les clés SMS existent, sinon sur `stdout` (rien n'est perdu : la
     notification reste dans `notifications` et se rejoue). */
  waProvider: (process.env.WHATSAPP_PROVIDER || (process.env.SMS_PROVIDER === 'twilio' ? 'twilio' : 'stdout')) as 'stdout' | 'twilio' | 'meta',
  waToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
  waPhoneId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  waTemplate: process.env.WHATSAPP_TEMPLATE_NAME || '',
  waVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
  googleReviewUrl: process.env.GOOGLE_REVIEW_URL || '',
  analytics: process.env.GSC_ANALYTICS || 'none',
};

if (!env.databaseUrl && !env.isProd) {
  // SQLite local: ok
}
if (!env.databaseUrl && env.isProd && !env.demo) {
  throw new Error('DATABASE_URL (Postgres) est requis en production.');
}
if (env.sessionSecret.startsWith('dev-') && env.isProd) throw new Error('SESSION_SECRET sécurisé requis en production');
