import { env } from '../lib/env.ts';

/**
 * Numéro de téléphone → forme canonique `336…` (11 chiffres) pour que la recherche de
 * client soit la même quel que soit le format saisi (+33, 0033, 06…, copier-coller d'iMessage).
 * L'ancien bug (« +33 6 44… » perdait le 6) créait un doublon de fiche client et envoyait les
 * SMS au mauvais numéro : la normalisation est testée dans tests/inputs.test.ts.
 */
export const normalizePhone = (v: string | null | undefined) => {
  if (!v) return '';
  let d = String(v).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2); // 00 33 6 … → 33 6 …
  if (/^330\d{9}$/.test(d)) d = d.slice(2); // « +33 06 44 … » (le 0 national en trop)
  if (/^0\d{9}$/.test(d)) d = '33' + d.slice(1); // 06 44 04 83 85 → 33644048385
  if (/^33\d{9,}$/.test(d)) d = d.slice(0, 11); // chiffres ajoutés par erreur
  return d;
};

export const displayPhone = (v: string | null) => {
  if (!v) return '';
  const d = normalizePhone(v);
  if (d.length === 11 && d.startsWith('33')) return ('0' + d.slice(2)).replace(/(\d{2})(?=\d)/g, '$1 ');
  return '+' + d;
};

export const normalizeEmail = (v: string | null | undefined) => (v || '').trim().toLowerCase();

export const initials = (first?: string | null, last?: string | null) =>
  `${(first || '?')[0] ?? '?'}${(last || '').slice(0, 1)}`.toUpperCase();

export function cents(v: number | null | undefined, currency = 'EUR') {
  if (v == null) return '—';
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, minimumFractionDigits: v % 100 ? 2 : 0 }).format(v / 100);
}

/** Sanitize léger pour les champs texte libres stockés puis réaffichés (défense en profondeur contre le XSS). */
export function cleanText(v: unknown, max = 2000): string {
  return String(v ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    // filet de sécurité : aucun champ texte libre ne doit pouvoir transporter de balise.
    // le rendu client échappe déjà tout — on ne compte jamais sur une seule barrière.
    .replace(/<\s*\/?(script|style|iframe|object|embed|link|meta|svg|img|video|audio|form|body|input|button)[^>]*>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/(javascript|data|vbscript):/gi, '')
    .replace(/\s{2,}/g, ' ')
    .slice(0, max)
    .trim();
}

export function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export function appLink(path: string) {
  return `${env.appUrl}${path}`;
}

/** petit parseur d'URL de deep-linking (utm, source, service, staff…) */
export function parseAttribution(sp: URLSearchParams) {
  const get = (...keys: string[]) => keys.map((k) => sp.get(k)).find((v) => v) ?? null;
  return {
    source: get('source', 'utm_source'),
    medium: get('medium', 'utm_medium'),
    campaign: get('campaign', 'utm_campaign'),
    content: get('content', 'utm_content'),
    landing: get('landing') ?? get('l'),
    device: get('device'),
    referrer: get('ref'),
    gclid: get('gclid'),
    serviceKey: get('service', 'prestation'),
    staffSlug: get('barbier', 'staff'),
    date: get('date', 'le'),
    slot: get('heure'),
    mode: get('mode'),
  };
}

export function deviceFromUA(ua = '') {
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|Android|Instagram|TikTok/i.test(ua)) return 'mobile';
  return 'desktop';
}

export function channelFromUA(ua = ''): { source: string; label: string } | null {
  if (/instagram/i.test(ua)) return { source: 'instagram', label: 'Instagram' };
  if (/tiktok/i.test(ua)) return { source: 'tiktok', label: 'TikTok' };
  if (/fbsan|facebook|fbia|FBAN/i.test(ua)) return { source: 'facebook', label: 'Facebook' };
  if (/Snapchat/i.test(ua)) return { source: 'snapchat', label: 'Snapchat' };
  return null;
}
