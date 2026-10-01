/** Premier accès propriétaire : jamais de compte de démonstration en production.
 * Les variables de bootstrap ne servent qu'en l'absence d'un propriétaire, actif ou non.
 * Le verrou transactionnel protège les démarrages simultanés de plusieurs fonctions Vercel.
 */
import { hashPassword } from './secrets.ts';
import { env } from './env.ts';
import { ready, transaction } from '../db/index.ts';
import { initializeSalon } from '../seed/production.ts';

export const MIN_OWNER_PASSWORD = 12;
export type OwnerOutcome = { status: 'created' | 'updated' | 'skipped' | 'refused'; email: string; why?: string };

export async function ensureOwner(o: { email: string; password: string; name?: string; allowPasswordChange?: boolean }): Promise<OwnerOutcome> {
  const email = String(o.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) return { status: 'refused', email, why: 'adresse e-mail invalide' };
  if (o.password.length < MIN_OWNER_PASSWORD || o.password.length > 200)
    return { status: 'refused', email, why: 'mot de passe : 12 à 200 caractères' };
  await ready();
  return transaction(async (q): Promise<OwnerOutcome> => {
    let loc = await q.one<any>('SELECT id FROM locations WHERE slug = :s', { s: env.demoSlug });
    if (!loc) {
      if (env.demoSlug !== 'zyass') return { status: 'refused', email, why: 'salon non initialisé' };
      loc = { id: await initializeSalon(q) };
    }
    const existing = await q.one<any>('SELECT * FROM users WHERE lower(email) = :e', { e: email });
    const owner = await q.one<any>("SELECT id FROM users WHERE location_id = :l AND role_key = 'owner' LIMIT 1", { l: loc.id });
    if (!o.allowPasswordChange && owner) return { status: 'skipped', email, why: 'un propriétaire existe déjà ; aucun compte ni mot de passe modifié' };
    // On ne transforme jamais un compte client en propriétaire via une variable d'environnement.
    if (existing) {
      if (!o.allowPasswordChange || Number(existing.location_id) !== Number(loc.id) || existing.role_key !== 'owner')
        return { status: 'refused', email, why: 'adresse déjà utilisée ; choisir une adresse admin distincte' };
      await q.update('users', existing.id, { password_hash: hashPassword(o.password), is_active: 1, failed_attempts: 0, locked_until: null });
      await q.exec('UPDATE sessions SET revoked_ts = :n WHERE user_id = :u', { n: Date.now(), u: existing.id });
      return { status: 'updated', email };
    }
    if (o.allowPasswordChange) return { status: 'refused', email, why: 'compte propriétaire introuvable : --change ne crée pas de compte' };
    await q.insert('users', { location_id: loc.id, email, name: o.name || email.split('@')[0], role_key: 'owner', password_hash: hashPassword(o.password), staff_id: null, is_active: 1, created_ts: Date.now() });
    return { status: 'created', email };
  }, 731004);
}

export async function bootstrapOwnerFromEnv(): Promise<OwnerOutcome | null> {
  const { email, password, name } = env.ownerBootstrap;
  if (!email || !password) return null;
  return ensureOwner({ email, password, name });
}
