import { createHmac, randomBytes, createPublicKey, timingSafeEqual, pbkdf2Sync, randomUUID } from 'node:crypto';
import { env } from './env.ts';

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O/1/I : lisible au téléphone

export const uid = () => randomUUID();
export const rnd = (n = 16) => randomBytes(n).toString('base64url');

/** jeton signé court, utilisable dans un lien SMS/email (confirmer, rescheduler, revendiquer un créneau waitlist) */
export function signToken(payload: Record<string, unknown>, ttlMs = 30 * 864e5): string {
  const body = { ...payload, exp: Date.now() + ttlMs, jti: rnd(6) };
  const data = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = createHmac('sha256', env.tokenSecret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyToken<T = Record<string, any>>(token: string): T | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = createHmac('sha256', env.tokenSecret).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (typeof obj.exp === 'number' && obj.exp < Date.now()) return null;
    return obj as T;
  } catch {
    return null;
  }
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const dk = pbkdf2Sync(pw, salt, 210_000, 32, 'sha256');
  return `pbkdf2$210000$${salt.toString('base64')}$${dk.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, iters, salt, hash] = (stored || '').split('$');
  if (alg !== 'pbkdf2' || !iters || !salt || !hash) return false;
  const dk = pbkdf2Sync(pw, Buffer.from(salt, 'base64'), Number(iters), Buffer.from(hash, 'base64').length, 'sha256');
  const a = dk;
  const b = Buffer.from(hash, 'base64');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function humanCode(len = 6): string {
  let s = '';
  const buf = randomBytes(len);
  for (let i = 0; i < len; i++) s += ALPHA[buf[i] % ALPHA.length];
  return s;
}

export function promoCode(prefix = 'ZY'): string {
  return `${prefix}-${humanCode(4)}-${humanCode(4)}`;
}

export function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export function hashPepper(v: string): string {
  return createHmac('sha256', env.tokenSecret).update(v.toLowerCase().trim()).digest('hex');
}
