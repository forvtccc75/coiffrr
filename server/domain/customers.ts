import { db, j, sj } from '../db/index.ts';
import { DAY, dateKey, humanDaysAgo, startOfDayMs, todayDay } from '../lib/time.ts';
import { cleanText, normalizeEmail, normalizePhone } from '../lib/inputs.ts';
import type { Ctx } from './context.ts';
import type { Attribution } from './booking.ts';

/**
 * CRM — une fiche par client, nourrie à chaque interaction.
 * Segments et scores calculés à la lecture (aucune donnée sensible n'est utilisée).
 */

export async function audit(locId: number | null, actorType: string, actorId: number | null | undefined, action: string, entity: string, entityId: number | null, meta: any = {}, ip?: string, ua?: string) {
  try {
    await db().insert('audit_logs', { location_id: locId, actor_type: actorType, actor_id: actorId ?? null, action, entity, entity_id: entityId ?? null, ip: ip ?? null, user_agent: ua ? cleanText(ua, 180) : null, meta_json: sj(meta), ts: Date.now() });
  } catch (e) {
    console.error('[audit]', (e as Error).message);
  }
}

export async function flagRisk(locId: number, customerId: number | null, kind: string, severity: 'low' | 'medium' | 'high', detail: any) {
  if (!customerId) return;
  const existing = await db().one<any>(`SELECT id FROM risk_flags WHERE customer_id = :c AND kind = :k AND status = 'open' LIMIT 1`, { c: customerId, k: kind });
  if (existing) return;
  await db().insert('risk_flags', { location_id: locId, customer_id: customerId, kind, severity, detail_json: sj(detail), status: 'open', ts: Date.now() });
}

export interface UpsertInput {
  phone: string;
  email?: string | null;
  firstName: string;
  lastName?: string | null;
  note?: string | null;
  birthDay?: string | null;
  attribution?: Attribution | null;
  consentMarketing?: { email?: boolean; sms?: boolean };
  referrerCode?: string | null;
  userId?: number | null;
}

export async function upsertCustomer(ctx: Ctx, inp: UpsertInput) {
  const q = db();
  const phoneNorm = normalizePhone(inp.phone);
  const emailNorm = inp.email ? normalizeEmail(inp.email) : null;
  const existing =
    (phoneNorm ? await q.one<any>(`SELECT * FROM customers WHERE location_id = :l AND phone_norm = :p AND deleted_ts IS NULL`, { l: ctx.locId, p: phoneNorm }) : null) ??
    (emailNorm ? await q.one<any>(`SELECT * FROM customers WHERE location_id = :l AND email_norm = :e AND deleted_ts IS NULL`, { l: ctx.locId, e: emailNorm }) : null);

  if (existing) {
    const patch: any = { updated_ts: Date.now() };
    if (!existing.email && emailNorm) Object.assign(patch, { email: inp.email, email_norm: emailNorm });
    if (inp.birthDay && !existing.birth_day) patch.birth_day = inp.birthDay;
    if (inp.note && !existing.notes) patch.notes = cleanText(inp.note, 500);
    if (inp.consentMarketing?.email) Object.assign(patch, { consent_marketing_email: 1, consent_terms_ts: Date.now() });
    if (inp.consentMarketing?.sms) patch.consent_marketing_sms = 1;
    // dernière source attribuée uniquement si le client arrive d'un canal payant/social (première attribution conservée sinon)
    const paidish = ['instagram', 'tiktok', 'google_ads', 'qr', 'referral'];
    if (inp.attribution?.source && paidish.includes(inp.attribution.source) && !existing.source) Object.assign(patch, { source: inp.attribution.source, medium: inp.attribution.medium, campaign: inp.attribution.campaign, landing: inp.attribution.landing, device: inp.attribution.device, referrer: inp.attribution.referrer });
    if (Object.keys(patch).length) await q.update('customers', existing.id, patch);
    if (inp.consentMarketing?.email && !existing.consent_marketing_email) await logConsent(ctx, existing.id, 'marketing_email', true, inp.attribution?.landing ?? 'booking', emailNorm);
    if (inp.consentMarketing?.sms && !existing.consent_marketing_sms) await logConsent(ctx, existing.id, 'marketing_sms', true, inp.attribution?.landing ?? 'booking', phoneNorm);
    return { customer: { ...existing, ...patch }, isNew: false as const };
  }

  const id = await q.insert('customers', {
    location_id: ctx.locId,
    user_id: inp.userId ?? null,
    first_name: cleanText(inp.firstName, 60) || 'Client',
    last_name: cleanText(inp.lastName || '', 60) || null,
    phone: inp.phone,
    phone_norm: phoneNorm || null,
    email: inp.email ?? null,
    email_norm: emailNorm,
    birth_day: inp.birthDay ?? null,
    notes: inp.note ? cleanText(inp.note, 500) : null,
    preferred_service_id: null,
    preferred_channel: inp.consentMarketing?.sms ? 'sms' : 'email',
    consent_marketing_email: inp.consentMarketing?.email ? 1 : 0,
    consent_marketing_sms: inp.consentMarketing?.sms ? 1 : 0,
    consent_terms_ts: Date.now(),
    source: inp.attribution?.source ?? 'direct',
    medium: inp.attribution?.medium ?? null,
    campaign: inp.attribution?.campaign ?? null,
    landing: inp.attribution?.landing ?? null,
    device: inp.attribution?.device ?? null,
    referrer: inp.attribution?.referrer ?? null,
    tags: sj([]),
    referral_code: null,
    created_ts: Date.now(),
    updated_ts: Date.now(),
  });
  const code = `ZY-${await shortCode()}`;
  await q.update('customers', id, { referral_code: code });
  if (inp.consentMarketing?.email) await logConsent(ctx, id, 'marketing_email', true, 'booking', emailNorm);
  if (inp.consentMarketing?.sms) await logConsent(ctx, id, 'marketing_sms', true, 'booking', phoneNorm);
  await logConsent(ctx, id, 'terms', true, 'booking', phoneNorm);

  if (inp.referrerCode) await attributeReferral(ctx, id, inp.referrerCode);
  const created = await q.one<any>(`SELECT * FROM customers WHERE id = :i`, { i: id });
  return { customer: created, isNew: true as const };
}

async function shortCode() {
  const { humanCode } = await import('../lib/secrets.ts');
  return humanCode(5);
}

export async function logConsent(ctx: Ctx, customerId: number, purpose: string, granted: boolean, source: string | null, target: string | null, ip?: string, ua?: string) {
  await db().insert('consents', {
    location_id: ctx.locId,
    customer_id: customerId,
    purpose,
    channel: purpose.includes('email') ? 'email' : purpose.includes('sms') ? 'sms' : purpose.includes('whatsapp') ? 'whatsapp' : null,
    granted: granted ? 1 : 0,
    source,
    ip: ip ?? null,
    user_agent: ua ? cleanText(ua, 180) : null,
    ts: Date.now(),
    revoked_ts: granted ? null : Date.now(),
  });
}

/** Attribue un parrainage (le code est celui du parrain), sans jamais créer de récompense avant le 1er RDV honoré. */
export async function attributeReferral(ctx: Ctx, refereeId: number, code: string) {
  const q = db();
  const referrer = await q.one<any>(`SELECT * FROM customers WHERE location_id = :l AND upper(referral_code) = :c`, { l: ctx.locId, c: code.toUpperCase().trim() });
  if (!referrer || referrer.id === refereeId) return null;
  const dup = await q.one(`SELECT id FROM referrals WHERE location_id = :l AND referee_id = :r`, { l: ctx.locId, r: refereeId });
  if (dup) return null;
  // garde-fou anti-abus : même téléphone/email/empreinte que le parrain => rejet silencieux
  const referee = await q.one<any>(`SELECT * FROM customers WHERE id = :i`, { i: refereeId });
  const sameIdentity = referee?.phone_norm && referrer.phone_norm === referee.phone_norm;
  const id = await q.insert('referrals', {
    location_id: ctx.locId,
    referrer_id: referrer.id,
    referee_id: refereeId,
    code: code.toUpperCase().trim(),
    channel: 'link',
    status: sameIdentity ? 'rejected' : 'invited',
    fraud_flag: sameIdentity ? 1 : 0,
    reward_referrer_cents: 500,
    reward_referee_cents: 500,
    created_ts: Date.now(),
  });
  if (!sameIdentity) await q.update('customers', refereeId, { referred_by: referrer.id });
  else await flagRisk(ctx.locId, refereeId, 'referral_abuse', 'low', { referral_id: id, why: 'même identité que le parrain' });
  return id;
}

/** Segments calculés sur les habitudes réelles de visite. */
export function segmentOf(c: { visits_count: number; last_visit_ts: number | null; noshow_count: number; spent_cents: number; created_ts: number }, avgHabit: number | null, now = Date.now()) {
  const last = c.last_visit_ts;
  const days = last ? Math.floor((now - last) / DAY) : null;
  const habit = avgHabit ?? 28;
  if (!last) return c.visits_count > 0 ? 'nouveau' : 'nouveau';
  if (c.visits_count >= 8 && (days ?? 0) <= habit * 1.6) return 'vip';
  if (c.noshow_count >= 2) return 'no_show';
  if (days != null && days > habit * 2.2) return 'churn_risque';
  if (days != null && days > habit * 3.5) return 'inactif';
  if (days != null && days >= habit * 0.85) return 'a_relancer';
  if (c.visits_count >= 4) return 'fidele';
  return 'actif';
}

export const SEGMENT_LABEL: Record<string, string> = {
  nouveau: 'Nouveau',
  actif: 'Actif',
  fidele: 'Fidèle',
  vip: 'VIP',
  a_relancer: 'À relancer',
  churn_risque: 'Risque de départ',
  inactif: 'Inactif',
  no_show: 'No-show',
};

export async function refreshSegment(customerId: number) {
  const q = db();
  const c = await q.one<any>(`SELECT * FROM customers WHERE id = :i`, { i: customerId });
  if (!c) return null;
  const gap = await q.num(`SELECT AVG(days) FROM (SELECT (a.start_ts - LAG(a.start_ts) OVER (ORDER BY a.start_ts)) / ${DAY} AS days FROM appointments a WHERE a.customer_id = :c AND a.status = 'completed') x`, { c: customerId }).catch(() => 0);
  const habit = Number.isFinite(gap) && gap > 3 ? Math.round(gap) : c.avg_days_between ?? 28;
  const seg = segmentOf({ visits_count: c.visits_count, last_visit_ts: c.last_visit_ts, noshow_count: c.noshow_count, spent_cents: c.spent_cents, created_ts: c.created_ts }, habit);
  // score de churn simple : retard sur l'habitude + no-shows + annulations
  const daysSince = c.last_visit_ts ? (Date.now() - c.last_visit_ts) / DAY : 999;
  const churn = Math.round(Math.min(100, Math.max(0, ((daysSince - habit) / habit) * 55 + c.noshow_count * 12 + c.cancelled_count * 6 + (c.visits_count < 2 ? 15 : 0))));
  await q.update('customers', customerId, { segment: seg, avg_days_between: habit, risk_score: churn });
  return { segment: seg, habit, churn };
}

export async function customerCard(ctx: Ctx, customerId: number) {
  const q = db();
  const c = await q.one<any>(`SELECT * FROM customers WHERE id = :i AND location_id = :l`, { i: customerId, l: ctx.locId });
  if (!c) return null;
  const appts = await q.all<any>(
    `SELECT a.*, s.name AS service_name, st.name AS staff_name
     FROM appointments a JOIN services s ON s.id = a.service_id JOIN staff st ON st.id = a.staff_id
     WHERE a.customer_id = :i ORDER BY a.start_ts DESC LIMIT 60`,
    { i: customerId },
  );
  const rewards = await q.all<any>(`SELECT * FROM loyalty_ledger WHERE customer_id = :i ORDER BY ts DESC LIMIT 30`, { i: customerId });
  const reviews = await q.all<any>(`SELECT * FROM reviews WHERE customer_id = :i ORDER BY created_ts DESC LIMIT 5`, { i: customerId });
  const consents = await q.all<any>(`SELECT * FROM consents WHERE customer_id = :i ORDER BY ts DESC LIMIT 20`, { i: customerId });
  const flags = await q.all<any>(`SELECT * FROM risk_flags WHERE customer_id = :i AND status='open' ORDER BY ts DESC`, { i: customerId });
  const ref = await q.one<any>(`SELECT COUNT(*) AS c FROM referrals WHERE referee_id = :i AND status='converted'`, { i: customerId });
  const loyalty = await q.one<any>(`SELECT * FROM loyalty_rewards WHERE location_id = :l ORDER BY id LIMIT 1`, { l: ctx.locId });
  const habit = c.avg_days_between ?? 28;
  const dueIn = c.last_visit_ts ? Math.round(habit - (Date.now() - c.last_visit_ts) / DAY) : null;
  return {
    ...c,
    tags: j<string[]>(c.tags, []),
    visits: appts,
    ledger: rewards,
    reviews,
    consents,
    riskFlags: flags,
    referralsConverted: Number(ref?.c ?? 0),
    loyalty: {
      points: c.loyalty_points,
      visits: c.loyalty_visits,
      perVisit: loyalty?.points_per_visit ?? 25,
      threshold: loyalty?.threshold_visits ?? 5,
      rewardName: loyalty?.name ?? null,
      progress: Math.min(1, (c.loyalty_visits ?? 0) / (loyalty?.threshold_visits ?? 5)),
    },
    habit,
    dueInDays: dueIn,
    dueLabel: dueIn == null ? null : dueIn > 0 ? `Reviendra probablement dans ${dueIn} j` : `En retard de ${-dueIn} j`,
    lastVisitLabel: c.last_visit_ts ? humanDaysAgo(c.last_visit_ts) : 'Jamais venu',
  };
}

/** Recherche instantanée (nom, téléphone, email, tag, note). */
export async function searchCustomers(ctx: Ctx, term: string, limit = 20) {
  const q = db();
  const t = term.trim();
  if (!t) return [];
  const digits = t.replace(/\D/g, '');
  const like = `%${t.toLowerCase()}%`;
  const rows = await q.all<any>(
    `SELECT id, first_name, last_name, phone, email, segment, visits_count, spent_cents, last_visit_ts, tags, preferred_staff_id, loyalty_points
     FROM customers
     WHERE location_id = :l AND deleted_ts IS NULL
       AND (lower(first_name) LIKE :like OR lower(last_name) LIKE :like OR (lower(first_name) || ' ' || lower(last_name)) LIKE :like
            OR lower(email) LIKE :like OR replace(coalesce(phone,''),' ','') LIKE :dig OR lower(coalesce(notes,'')) LIKE :like)
     ORDER BY last_visit_ts DESC LIMIT :lim`,
    { l: ctx.locId, like, dig: `%${digits}%`, lim: limit },
  );
  return rows.map((r: any) => ({ ...r, tags: j<string[]>(r.tags, []) }));
}

export async function upcomingFor(ctx: Ctx, customerId: number) {
  return db().all<any>(
    `SELECT a.*, s.name AS service_name, st.name AS staff_name FROM appointments a
     JOIN services s ON s.id = a.service_id JOIN staff st ON st.id = a.staff_id
     WHERE a.customer_id = :i AND a.start_ts >= :n AND a.status IN ('booked','confirmed','pending_payment','waiting_client') ORDER BY a.start_ts LIMIT 5`,
    { i: customerId, n: Date.now() },
  );
}

export { normalizeEmail, normalizePhone };
