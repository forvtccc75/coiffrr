import { useEffect, useState } from 'react';
// type seul (effacé au build) : pas d'import runtime du dossier shared/ côté navigateur.
import type { FunnelKind } from '../../../shared/funnel';

/**
 * Client HTTP minimaliste. Une seule origine (même domaine) → cookies SameSite=Lax,
 * aucun token dans le localStorage (donc pas de vol par XSS stocké).
 */
export class ApiError extends Error {
  status: number;
  code: string;
  data: any;
  constructor(status: number, payload: any) {
    super(payload?.message ?? 'Une erreur est survenue.');
    this.status = status;
    this.code = payload?.error ?? 'erreur';
    this.data = payload?.data ?? null;
  }
}

export async function api<T = any>(path: string, init: { method?: string; body?: any; raw?: boolean } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  const json = text ? safeJson(text) : null;
  if (!res.ok) throw new ApiError(res.status, json ?? { message: text.slice(0, 160) });
  return (init.raw ? text : json) as T;
}

function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/* ── config salon : une seule requête, partagée, mise en cache 60 s ───────── */
export type Cfg = any;
let cfg: Cfg | null = null;
let cfgP: Promise<Cfg> | null = null;
let cfgErr: unknown = null;
let cfgAt = 0;
const cfgListeners = new Set<() => void>();
export function loadCfg(force = false): Promise<Cfg> {
  if (cfgP) return cfgP;
  if (cfg && !force && Date.now() - cfgAt < 60000) return Promise.resolve(cfg);
  cfgP = api<Cfg>('/api/public/config').then(v => { cfg = v; cfgErr = null; cfgAt = Date.now(); return v; })
    .catch(e => { cfgErr = e; throw e; })
    .finally(() => { cfgP = null; cfgListeners.forEach(fn => fn()); });
  return cfgP;
}
export function useConfig() {
  const [state, setState] = useState<{ cfg: Cfg | null; error: unknown }>({ cfg, error: cfgErr });
  useEffect(() => {
    const sync = () => setState({ cfg, error: cfgErr });
    const refresh = () => { if (document.visibilityState === 'visible') void loadCfg().catch(() => undefined); };
    cfgListeners.add(sync); sync(); void loadCfg().catch(() => undefined);
    document.addEventListener('visibilitychange', refresh);
    return () => { cfgListeners.delete(sync); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return { ...state, reload: () => loadCfg(true) };
}

/** disponibilité fraîche (after 20s server cache) — used before any write */
export const availability = (q: Record<string, any>) => api('/api/public/availability?' + qs(q));
export const nextSlot = (service: string) => api('/api/public/next?' + qs({ service }));
export const book = (body: any) => api('/api/public/booking', { method: 'POST', body });
export const joinWaitlist = (body: any) => api('/api/public/waitlist', { method: 'POST', body });
export const waitlistStatus = (token: string) => api('/api/public/waitlist/status?' + qs({ token }));
export const claimOffer = (token: string) => api('/api/public/waitlist/claim', { method: 'POST', body: { token } });
export const declineOffer = (token: string) => api('/api/public/waitlist/decline', { method: 'POST', body: { token } });
export const apptView = (token: string) => api('/api/public/appointment?' + qs({ token }));
export const apptAction = (path: string, body: any) => api(`/api/public/${path}`, { method: 'POST', body });
export const reviewView = (token: string) => api('/api/public/reviews?' + qs({ token }));
export const submitReview = (body: any) => api('/api/public/reviews', { method: 'POST', body });
export const sendCode = (target: string) => api('/api/public/auth/code', { method: 'POST', body: { target } });
export const verifyCode = (target: string, code: string) => api('/api/public/auth/code/verify', { method: 'POST', body: { target, code } });
/** Session du visiteur. Normalisé ici : toute réponse sans utilisateur vaut « anonyme », quitte à
    parler à une version plus ancienne du serveur (la page ne doit jamais devenir blanche). */
export const me = async () => {
  const j: any = await api('/api/public/me');
  const user = j?.user ?? null;
  return { user, anonymous: j?.anonymous ?? !user };
};
export const saveDraft = (body: any) => api('/api/public/draft', { method: 'POST', body });
export const getDraft = (token: string) => api('/api/public/draft?' + qs({ token }));

export const clientApi = {
  summary: () => api('/api/client/summary'),
  appointments: () => api('/api/client/appointments'),
  rebook: (body: any) => api('/api/client/rebook', { method: 'POST', body }),
  profile: (body: any) => api('/api/client/profile', { method: 'POST', body }),
  redeem: (body: any) => api('/api/client/rewards/redeem', { method: 'POST', body }),
  giftCards: () => api('/api/client/gift-cards'),
  buyGiftCard: (body: any) => api('/api/public/gift-cards', { method: 'POST', body }),
  export: () => api('/api/client/export'),
  del: (body: any) => api('/api/client/delete', { method: 'POST', body }),
};

export const adminApi = {
  login: (email: string, password: string) => api('/api/public/auth/password', { method: 'POST', body: { email, password, scope: 'admin' } }),
  logout: () => api('/api/public/auth/logout', { method: 'POST', body: {} }),
  get: (path: string, q: Record<string, any> = {}) => api(`/api/admin/${path}${Object.keys(q).length ? '?' + qs(q) : ''}`),
  post: (path: string, body: any = {}) => api(`/api/admin/${path}`, { method: 'POST', body }),
};

export function qs(o: Record<string, any>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  return p.toString();
}

/* ── formatage ───────────────────────────────────────────────────────────── */
export const eur = (cents: number | null | undefined) =>
  cents == null ? '—' : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: Number.isInteger(cents / 100) ? 0 : 2 }).format(cents / 100);

export const when = (ts: number) =>
  new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(ts));

export const dayLabel = (ts: number) => new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' }).format(new Date(ts));

export const time = (ts: number) => new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts));

export const ago = (ts: number) => {
  const d = Math.round((Date.now() - ts) / 86_400_000);
  return d === 0 ? "aujourd'hui" : d === 1 ? 'hier' : d < 30 ? `il y a ${d} jours` : new Intl.DateTimeFormat('fr-FR', { month: 'short', year: '2-digit' }).format(new Date(ts));
};

export const min = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ' ' + String(m % 60).padStart(2, '0') : ''}`);

/* ── tracking d'entonnoir (analytics 80/20 : on mesure ce qui décide) ─────── */
export function visitorId() {
  if (typeof localStorage === 'undefined') return 'ssr-visitor';
  let v = localStorage.getItem('zyass_vid');
  if (!v) {
    v = 'v' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    localStorage.setItem('zyass_vid', v);
  }
  return v;
}

export function track(kind: FunnelKind, path = typeof location === 'undefined' ? '/' : location.pathname, meta: any = {}) {
  if (typeof navigator === 'undefined') return; // pré-rendu : personne n'écoute
  if (/bot|crawl|preview/i.test(navigator.userAgent)) return;
  const attribution = readAttribution();
  const body = JSON.stringify({ visitorId: visitorId(), kind, path, meta, attribution });
  if (navigator.sendBeacon && kind !== 'booking_start') navigator.sendBeacon('/api/public/track', new Blob([body], { type: 'application/json' }));
  else
    fetch('/api/public/track', { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true, credentials: 'same-origin' }).catch(
      () => undefined,
    );
}

export function readAttribution() {
  if (typeof location === 'undefined') return {};
  const p = new URLSearchParams(location.search);
  const out: Record<string, string> = {};
  for (const k of ['source', 'campaign', 'medium', 'landing', 'referrer']) if (p.get(k)) out[k] = p.get(k)!.slice(0, 80);
  try {
    const stored = JSON.parse(localStorage.getItem('zyass_attr') ?? '{}');
    Object.assign(out, { ...stored, ...out });
    if (Object.keys(out).length) localStorage.setItem('zyass_attr', JSON.stringify(out));
  } catch {
    /* ignore */
  }
  return out;
}

export function parseUtm() {
  if (typeof location === 'undefined' || typeof localStorage === 'undefined') return {};
  const p = new URLSearchParams(location.search);
  const attr: Record<string, string> = {};
  if (p.get('utm_source')) attr.source = p.get('utm_source')!.slice(0, 40);
  if (p.get('utm_campaign')) attr.campaign = p.get('utm_campaign')!.slice(0, 80);
  if (p.get('utm_medium')) attr.medium = p.get('utm_medium')!.slice(0, 40);
  for (const k of ['source', 'campaign', 'medium']) if (p.get(k)) attr[k] = p.get(k)!.slice(0, 80);
  if (p.get('igshid')) attr.source = attr.source ?? 'instagram';
  if (Object.keys(attr).length) {
    attr.landing = location.pathname.slice(0, 120);
    localStorage.setItem('zyass_attr', JSON.stringify(attr));
  }
  return attr;
}
