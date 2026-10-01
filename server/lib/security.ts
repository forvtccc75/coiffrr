import { db, sj } from '../db/index.ts';
import { env } from './env.ts';
import { hashPassword, rnd, verifyPassword } from './secrets.ts';
import { DAY } from './time.ts';
import { observe } from './observe.ts';

/**
 * Sécurité applicative : sessions opaque côté serveur, RBAC strict, anti-force-brute,
 * rate limiting partagé (table) pour survivre au serverless, et contrôle d'appartenance
 * systématique (anti-IDOR) : chaque lecture/écriture est filtrée par location_id.
 */

export const SESSION_COOKIE = 'zyass_session';
export const ROLES = ['owner', 'manager', 'staff', 'customer'] as const;
export type Role = (typeof ROLES)[number];
export const RANK: Record<Role, number> = { customer: 0, staff: 1, manager: 2, owner: 3 };

export interface SessionUser {
  userId: number;
  role: Role;
  locationId: number | null;
  staffId: number | null;
  name: string;
  email: string | null;
  customerId: number | null;
  sessionId: string;
}

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function cookie(name: string, value: string, opts: { maxAgeSec?: number; secure?: boolean } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${opts.maxAgeSec ?? 60 * 60 * 24 * 90}`];
  if (opts.secure ?? env.isProd) parts.push('Secure');
  return parts.join('; ');
}

export async function createSession(user: { id: number; role: Role; location_id: number | null; staff_id: number | null; name: string; email: string | null; customer_id?: number | null }, req: any) {
  const q = db();
  const id = rnd(24);
  await q.insert('sessions', {
    id,
    user_id: user.id,
    ip: clientIp(req),
    user_agent: (headersOf(req).get('user-agent') || '').slice(0, 200),
    created_ts: Date.now(),
    expires_ts: Date.now() + (user.role === 'customer' ? 90 : 30) * DAY,
    last_seen_ts: Date.now(),
  });
  return id;
}

export async function readSession(req: any): Promise<SessionUser | null> {
  const token = parseCookie(cookieHeader(req), SESSION_COOKIE);
  if (!token) return null;
  const q = db();
  const row = await q.one<any>(
    `SELECT s.id AS session_id, s.expires_ts, u.id, u.role_key, u.location_id, u.staff_id, u.name, u.email, u.is_active, c.id AS customer_id
     FROM sessions s JOIN users u ON u.id = s.user_id
     LEFT JOIN customers c ON c.user_id = u.id
     WHERE s.id = :t AND s.revoked_ts IS NULL`,
    { t: token },
  );
  if (!row) return null;
  if (row.expires_ts < Date.now()) return null;
  if (!row.is_active) return null;
  q.exec(`UPDATE sessions SET last_seen_ts = :n WHERE id = :i`, { n: Date.now(), i: row.session_id }).catch(() => undefined);
  return {
    userId: row.id,
    role: row.role_key as Role,
    locationId: row.location_id,
    staffId: row.staff_id,
    name: row.name,
    email: row.email,
    customerId: row.customer_id,
    sessionId: row.session_id,
  };
}

export async function destroySession(req: any) {
  const token = parseCookie(cookieHeader(req), SESSION_COOKIE);
  if (token) await db().exec(`UPDATE sessions SET revoked_ts = :n WHERE id = :t`, { n: Date.now(), t: token });
}

export async function checkPassword(email: string, password: string) {
  const u = await db().one<any>(`SELECT * FROM users WHERE lower(email) = :e AND is_active = 1`, { e: email.toLowerCase().trim() });
  if (!u) return null;
  if (u.locked_until && u.locked_until > Date.now()) throw Object.assign(new Error('Trop de tentatives. Réessaie plus tard.'), { status: 429 });
  const ok = verifyPassword(password, u.password_hash);
  if (!ok) {
    const n = (u.failed_attempts ?? 0) + 1;
    await db().update('users', u.id, { failed_attempts: n, locked_until: n >= 6 ? Date.now() + 15 * 60_000 : null });
    return null;
  }
  await db().update('users', u.id, { failed_attempts: 0, locked_until: null, last_login_ts: Date.now() });
  return u;
}

export async function setPasswordForUser(userId: number, password: string) {
  if (password.length < 8) throw Object.assign(new Error('Mot de passe trop court (8 caractères min).'), { status: 422 });
  await db().update('users', userId, { password_hash: hashPassword(password), failed_attempts: 0, locked_until: null });
}

export const needRole = (u: SessionUser | null, min: Role) => {
  if (!u) return false;
  return RANK[u.role] >= RANK[min];
};

/** Accepte indifféremment un Request, un HonoRequest (c.req) ou le Context : le front ne doit jamais tomber sur un .headers undefined. */
function headersOf(req: any): Headers {
  if (!req) return new Headers();
  if (req instanceof Headers) return req;
  return req.headers ?? req.raw?.headers ?? req.req?.headers ?? new Headers();
}

export function clientIp(req: any) {
  const h = headersOf(req);
  // Les en-têtes forwardés ne valent que si quelqu'un de confiance les a posés. Derrière Vercel (ou tout
  // proxy qui écrase X-Forwarded-For), c'est le cas et le rate limiting par IP tient. Sur un port exposé
  // nu, n'importe qui envoie un `X-Forwarded-For` différent à chaque requête et franchit les 429 : d'où
  // TRUST_PROXY=0, qui ignore les en-têtes et retombe sur 'local' (le proxy doit alors être configuré).
  if (!env.trustProxy) return 'local';
  const xf = h.get('x-forwarded-for');
  if (xf) return xf.split(',')[0].trim();
  return h.get('x-real-ip') ?? 'local';
}

export function cookieHeader(req: any) {
  return headersOf(req).get('cookie');
}

/**
 * Bucket à jetons persisté (donc valable même si 5 instances serverless tournent en parallèle).
 * En dessous du seuil : on laisse passer sans écriture (coût nul).
 */
export async function rateLimit(key: string, limit: number, windowSec: number) {
  const q = db();
  const now = Date.now();
  const id = `rl:${key}`;
  try {
    const row = await q.one<any>(`SELECT tokens, updated_ts FROM rate_buckets WHERE bucket_key = :k`, { k: id });
    const refill = (limit / windowSec) * ((now - (row?.updated_ts ?? now)) / 1000);
    let tokens = Math.min(limit, (row ? Number(row.tokens) : limit) + refill);
    const allowed = tokens >= 1;
    if (allowed) tokens -= 1;
    // upsert manuel : le trou de sécurité venait d'un UPDATE sur une colonne `id` inexistante
    await q.exec(
      `INSERT INTO rate_buckets (bucket_key, tokens, updated_ts) VALUES (:k1, :t1, :n1)
       ON CONFLICT(bucket_key) DO UPDATE SET tokens = :t2, updated_ts = :n2`,
      { k1: id, t1: tokens, n1: now, t2: tokens, n2: now },
    );
    return { allowed, remaining: Math.floor(tokens), retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((1 - tokens) / Math.max(0.0001, limit / windowSec))) };
  } catch (e: any) {
    // En cas de panne DB, on ne bloque pas le salon ; mais on le journalise (jamais silencieux).
    void observe('rate_limit_degrade', key, null, 'warn', { message: String(e?.message).slice(0, 160) }, null).catch(() => undefined);
    return { allowed: true, remaining: limit, retryAfterSec: 0 };
  }
}

/** Headers durs : XSS réflexe, sniffing, clicjacking, fuite d'infos, referrer. */
export { securityHeaders } from '../../shared/http-security.ts';

export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export { sj, hashPassword };
