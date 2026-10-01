import { db, j, sj } from '../db/index.ts';
import { DAY, MIN, dateKey, todayDay } from '../lib/time.ts';
import { cents } from '../lib/inputs.ts';
import { humanCode } from '../lib/secrets.ts';
import type { Ctx } from './context.ts';
import { notify } from './notify.ts';
import { audit } from './customers.ts';
import { invalidateCtx } from './context.ts';
void invalidateCtx;

/** Fidélité, récompenses, parrainage, cartes cadeaux, abonnements, avis. */

export const LOYALTY_KEY = 'loyalty';

export async function loyaltyConfig(ctx: Ctx) {
  const row = await db().one<any>(`SELECT * FROM loyalty_rewards WHERE location_id = :l AND is_active = 1 ORDER BY id LIMIT 1`, { l: ctx.locId });
  return row ?? null;
}

export async function computeLoyalty(ctx: Ctx, customerId: number) {
  const q = db();
  const c = await q.one<any>(`SELECT loyalty_points, loyalty_visits FROM customers WHERE id = :i`, { i: customerId });
  const cfg = await loyaltyConfig(ctx);
  const visits = c?.loyalty_visits ?? 0;
  const points = c?.loyalty_points ?? 0;
  const threshold = cfg?.threshold_visits ?? 5;
  const unlocked = Math.floor(visits / Math.max(1, threshold));
  const spentThisCycle = visits % Math.max(1, threshold);
  const redemptions = await q.num(`SELECT COUNT(*) FROM loyalty_redemptions WHERE customer_id = :i AND status != 'cancelled'`, { i: customerId });
  return {
    enabled: ctx.features.loyalty,
    points,
    visits,
    perVisit: cfg?.points_per_visit ?? 25,
    threshold,
    rewardName: cfg?.name ?? null,
    progress: Math.min(1, spentThisCycle / threshold),
    visitsToNext: Math.max(0, threshold - spentThisCycle),
    rewardsAvailable: Math.max(0, unlocked - redemptions),
    nextReward: cfg ? `${cfg.name} — ${cfg.description ?? ''}` : null,
    history: await q.all<any>(`SELECT * FROM loyalty_ledger WHERE customer_id = :i ORDER BY ts DESC LIMIT 20`, { i: customerId }),
  };
}

export async function addLoyaltyVisit(ctx: Ctx, appt: any) {
  if (!ctx.features.loyalty) return null;
  const q = db();
  const cfg = await loyaltyConfig(ctx);
  const pts = cfg?.points_per_visit ?? 25;
  const dup = await q.one(`SELECT id FROM loyalty_ledger WHERE appointment_id = :a AND reason = 'visit'`, { a: appt.id });
  if (dup) return null;
  const bal = await q.num(`SELECT COALESCE(SUM(points),0) FROM loyalty_ledger WHERE customer_id = :c`, { c: appt.customer_id });
  await q.insert('loyalty_ledger', { location_id: ctx.locId, customer_id: appt.customer_id, points: pts, reason: 'visit', appointment_id: appt.id, balance_after: bal + pts, ts: Date.now() });
  const c = await q.one<any>(`SELECT loyalty_visits FROM customers WHERE id = :i`, { i: appt.customer_id });
  await q.update('customers', appt.customer_id, { loyalty_visits: (c?.loyalty_visits ?? 0) + 1, loyalty_points: bal + pts });
  if (cfg && ((c?.loyalty_visits ?? 0) + 1) % Math.max(1, cfg.threshold_visits) === 0) {
    await notify(ctx, 'loyalty_reward', { customerId: appt.customer_id, vars: { reward: cfg.name, message: `${cfg.name} débloquée` }, channels: ['web'] });
  }
  return pts;
}

export async function grantPoints(ctx: Ctx, customerId: number, points: number, reason: string, note?: string) {
  const q = db();
  const bal = await q.num(`SELECT COALESCE(SUM(points),0) FROM loyalty_ledger WHERE customer_id = :c`, { c: customerId });
  await q.insert('loyalty_ledger', { location_id: ctx.locId, customer_id: customerId, points, reason, note: note ?? null, balance_after: bal + points, ts: Date.now() });
  await q.update('customers', customerId, { loyalty_points: bal + points });
  return bal + points;
}

export async function redeemReward(ctx: Ctx, customerId: number, rewardId: number) {
  const q = db();
  const cfg = await q.one<any>(`SELECT * FROM loyalty_rewards WHERE id = :r AND location_id = :l`, { r: rewardId, l: ctx.locId });
  if (!cfg) throw new Error('Récompense inconnue');
  const loy = await computeLoyalty(ctx, customerId);
  if (loy.rewardsAvailable <= 0 && loy.points < cfg.points_cost) throw new Error('Pas assez de points/visites pour cette récompense.');
  if (cfg.points_cost > 0 && loy.points < cfg.points_cost) throw new Error(`Il te manque ${cfg.points_cost - loy.points} points.`);
  if (cfg.points_cost > 0) await grantPoints(ctx, customerId, -cfg.points_cost, 'reward_redeemed', cfg.name);
  const code = `PR-${humanCode(6)}`;
  await q.insert('loyalty_redemptions', { customer_id: customerId, reward_id: rewardId, code, status: 'issued', issued_ts: Date.now() });
  await notify(ctx, 'loyalty_reward', { customerId, vars: { reward: cfg.name, message: `Code ${code}` }, channels: ['web'] });
  await audit(ctx.locId, 'customer', customerId, 'loyalty.redeem', 'loyalty_rewards', rewardId, { code });
  return { code, reward: cfg.name, description: cfg.description };
}

export async function applyRedemptionAtBooking(ctx: Ctx, customerId: number, code: string) {
  const q = db();
  const r = await q.one<any>(`SELECT * FROM loyalty_redemptions WHERE code = :c AND customer_id = :i AND status = 'issued'`, { c: code.toUpperCase().trim(), i: customerId });
  if (!r) return null;
  const cfg = await q.one<any>(`SELECT * FROM loyalty_rewards WHERE id = :i`, { i: r.reward_id });
  return { redemptionId: r.id, discountCents: cfg?.kind === 'discount' ? Math.round((cfg.points_cost ? 10 : 15) * 100) : 0, freeService: cfg?.kind === 'free_service' ? cfg.name : null, label: cfg?.name };
}

/** Cadeau d'anniversaire : points + message (si opt-in), une fois par an. */
export async function maybeGiftBirthday(ctx: Ctx, customerId: number) {
  const q = db();
  const c = await q.one<any>(`SELECT * FROM customers WHERE id = :i`, { i: customerId });
  if (!c?.birth_day) return null;
  const today = todayDay();
  if (c.birth_day.slice(5) !== today.slice(5)) return null;
  const already = await q.one(`SELECT id FROM loyalty_ledger WHERE customer_id = :i AND reason = 'birthday' AND ts > :y`, { i: customerId, y: Date.now() - 364 * DAY });
  if (already) return null;
  const cfg = await loyaltyConfig(ctx);
  const pts = cfg?.birthday_bonus_points ?? 20;
  if (pts > 0) await grantPoints(ctx, customerId, pts, 'birthday', 'Bonus anniversaire');
  await notify(ctx, 'birthday', { customerId, vars: { reward: `${pts} points offerts` } });
  return { points: pts };
}

// ── parrainage ───────────────────────────────────────────────────────
export async function referralSummary(ctx: Ctx, customerId: number) {
  const q = db();
  const c = await q.one<any>(`SELECT referral_code, first_name FROM customers WHERE id = :i`, { i: customerId });
  const rows = await q.all<any>(`SELECT r.*, cu.first_name, cu.last_name FROM referrals r LEFT JOIN customers cu ON cu.id = r.referee_id WHERE r.referrer_id = :i ORDER BY r.created_ts DESC`, { i: customerId });
  const link = `${(await import('../lib/env.ts')).env.appUrl}/book?ref=${c?.referral_code ?? ''}`;
  return {
    enabled: ctx.features.referrals,
    code: c?.referral_code,
    link,
    whatsappText: `Salut, je t'envoie mon lien pour réserver chez ${ctx.name} (et -5 € pour nous deux à ton 1er RDV) : ${link}`,
    invited: rows.length,
    converted: rows.filter((r: any) => r.status === 'converted').length,
    earnedCents: rows.filter((r: any) => r.status === 'converted').reduce((a: number, r: any) => a + (r.reward_referrer_cents ?? 0), 0),
    rows,
  };
}

/** récompense versée après le 1er RDV honoré du filleul (anti-fraude : visite réelle obligatoire) */
export async function settleReferralOnFirstVisit(ctx: Ctx, refereeId: number) {
  const q = db();
  const rel = await q.one<any>(`SELECT * FROM referrals WHERE referee_id = :i AND status = 'invited'`, { i: refereeId });
  if (!rel || rel.fraud_flag) return null;
  await q.update('referrals', rel.id, { status: 'converted', first_visit_ts: Date.now(), granted_ts: Date.now() });
  const bonusPoints = Math.round((rel.reward_referrer_cents ?? 0) / 10);
  if (bonusPoints > 0) await grantPoints(ctx, rel.referrer_id, bonusPoints, 'referral_bonus', `Filleul #${refereeId}`);
  const p = await q.one<any>(`SELECT first_name FROM customers WHERE id = :i`, { i: rel.referrer_id });
  await notify(ctx, 'referral_success', { customerId: rel.referrer_id, vars: { parrain: p?.first_name ?? '', reward: `${((rel.reward_referrer_cents ?? 0) / 100).toFixed(0)} €` } });
  await audit(ctx.locId, 'system', null, 'referral.granted', 'referrals', rel.id, { referrer: rel.referrer_id, referee: refereeId });
  return { referralId: rel.id, bonusPoints };
}

export async function referralLeaderboard(ctx: Ctx, days = 90) {
  return db().all<any>(
    `SELECT c.id, c.first_name, c.last_name, COUNT(r.id) AS invites,
            SUM(CASE WHEN r.status='converted' THEN 1 ELSE 0 END) AS converted,
            SUM(CASE WHEN r.status='converted' THEN r.reward_referrer_cents ELSE 0 END) AS earned_cents
     FROM referrals r JOIN customers c ON c.id = r.referrer_id
     WHERE r.location_id = :l AND r.created_ts > :s
     GROUP BY c.id ORDER BY converted DESC, earned_cents DESC LIMIT 10`,
    { l: ctx.locId, s: Date.now() - days * DAY },
  );
}

// ── cartes cadeaux ───────────────────────────────────────────────────
export async function buyGiftCard(ctx: Ctx, o: { amountCents: number; buyerName: string; buyerEmail: string; recipientName?: string; message?: string; sendAt?: number; serviceId?: number | null; pay?: boolean }) {
  if (o.amountCents < 1000 || o.amountCents > 50000) throw new Error('Montant entre 10 € et 500 €');
  const q = db();
  const code = `ZY-${humanCode(4)}-${humanCode(4)}`;
  const id = await q.insert('gift_cards', {
    location_id: ctx.locId,
    code,
    amount_cents: o.amountCents,
    balance_cents: o.amountCents,
    buyer_name: o.buyerName,
    buyer_email: o.buyerEmail,
    recipient_name: o.recipientName ?? null,
    message: o.message ?? null,
    service_id: o.serviceId ?? null,
    status: o.pay === false ? 'active' : 'pending_payment',
    send_ts: o.sendAt ?? Date.now(),
    expiry_ts: Date.now() + 365 * DAY,
    created_ts: Date.now(),
  });
  if (o.pay !== false) {
    const { ensurePayment } = await import('./payments.ts');
    const p = await ensurePayment(ctx, { appointmentId: 0, customerId: 0, amountCents: o.amountCents, kind: 'gift_card', idem: `gc:${id}` });
    if (p.status === 'succeeded') await q.update('gift_cards', id, { status: 'active', payment_id: p.id });
    else await q.update('gift_cards', id, { status: 'failed' });
  }
  if (o.pay === false) {
    const paymentId = await q.insert('payments', { location_id: ctx.locId, gift_card_id: id, kind: 'gift_card', provider: 'on_site', amount_cents: o.amountCents, status: 'succeeded', idempotency_key: `gc-counter:${id}`, created_ts: Date.now(), updated_ts: Date.now() });
    await q.update('gift_cards', id, { payment_id: paymentId });
  }
  const gc = await q.one<any>(`SELECT * FROM gift_cards WHERE id = :i`, { i: id });
  if (gc?.status === 'active') {
    await notify(ctx, 'gift_card_received', { emailTo: o.buyerEmail, idem: `gift:${id}:email`, sendAfter: o.sendAt ?? Date.now(), vars: { message: o.message ?? 'Une carte cadeau pour toi', montant: cents(o.amountCents), code, link_book: `${(await import('../lib/env.ts')).env.appUrl}/book?gift=${code}` }, channels: o.buyerEmail ? ['email'] : ['web'] });
  }
  return gc;
}

export async function findGiftCard(ctx: Ctx, code: string) {
  return db().one<any>(`SELECT * FROM gift_cards WHERE location_id = :l AND upper(code) = :c`, { l: ctx.locId, c: code.toUpperCase().trim() });
}

// ── abonnements (option) ─────────────────────────────────────────────
export const MEMBERSHIP_PLANS = [
  { key: 'net', name: 'File nette', priceCents: 3900, visitsIncluded: 2, everyDays: 30, perks: ['2 coupes/mois', 'créneau prioritaire', 'produit offert à 3 mois'] },
  { key: 'royal', name: 'Royal', priceCents: 6900, visitsIncluded: 3, everyDays: 30, perks: ['3 coupes/mois', 'barbe incluse 1x/mois', 'waitlist prioritaire', 'annulation libre'] },
];

export async function memberStatus(ctx: Ctx, customerId: number) {
  if (!ctx.features.membership) return null;
  const m = await db().one<any>(`SELECT * FROM memberships WHERE customer_id = :i AND status = 'active' ORDER BY id DESC LIMIT 1`, { i: customerId });
  return m ? { ...m, plan: MEMBERSHIP_PLANS.find((p) => p.key === m.plan_key) } : null;
}

// ── avis ─────────────────────────────────────────────────────────────
export async function submitReview(ctx: Ctx, appointmentId: number, o: { rating?: number; comment?: string; consentPublish?: boolean; customerId?: number | null; token?: string }) {
  const q = db();
  const appt = await q.one<any>(`SELECT * FROM appointments WHERE id = :i AND location_id = :l`, { i: appointmentId, l: ctx.locId });
  if (!appt) throw new Error('Rendez-vous introuvable');
  if (o.customerId && appt.customer_id !== o.customerId) throw new Error('Lien invalide');
  const existing = await q.one<any>(`SELECT * FROM reviews WHERE appointment_id = :i`, { i: appointmentId });
  const rating = o.rating != null ? Math.max(1, Math.min(5, Math.round(o.rating))) : null;
  // Retour privé possible pour tous ; l'accès à Google ne doit jamais dépendre de la note.
  const positive = rating != null && rating >= 4;
  const status = rating == null ? 'feedback' : positive ? 'public_prompted' : 'private';
  const payload = {
    rating,
    comment: o.comment ?? null,
    status,
    visibility: positive && o.consentPublish ? 'public' : 'private',
    channel: positive ? 'google_prompt' : 'internal',
    consent_publish: o.consentPublish ? 1 : 0,
    updated_ts: Date.now(),
  };
  if (existing) await q.update('reviews', existing.id, payload);
  else await q.insert('reviews', { location_id: ctx.locId, appointment_id: appointmentId, customer_id: appt.customer_id, staff_id: appt.staff_id, service_id: appt.service_id, created_ts: Date.now(), ...payload });
  const review = existing ? await q.one<any>(`SELECT * FROM reviews WHERE id = :i`, { i: existing.id }) : await q.one<any>(`SELECT * FROM reviews WHERE appointment_id = :i`, { i: appointmentId });
  if (positive) await q.update('appointments', appointmentId, { review_status: 'positive' });
  else if (rating != null) {
    await q.update('appointments', appointmentId, { review_status: 'negative' });
    await q.update('appointments', appointmentId, { needs_action: 1 });
    await q.insert('pending_actions', { location_id: ctx.locId, kind: 'unhappy_client', payload_json: sj({ appointmentId, reviewId: review?.id, rating, comment: o.comment }), reason: 'Insatisfaction signalée — à traiter en privé', status: 'pending', created_ts: Date.now() });
  }
  await q.update('appointments', appointmentId, { review_status: rating == null ? 'feedback' : positive ? 'positive' : 'negative' });
  await audit(ctx.locId, 'customer', appt.customer_id, 'review.submit', 'appointment', appointmentId, { rating, positive });
  return { review, positive, googleUrl: ctx.brand.reviewUrl ?? null };
}

export async function replyToReview(ctx: Ctx, reviewId: number, text: string) {
  await db().update('reviews', reviewId, { reply_text: text, reply_ts: Date.now(), updated_ts: Date.now(), status: 'answered' });
  const r = await db().one<any>(`SELECT * FROM reviews WHERE id = :i`, { i: reviewId });
  if (r?.customer_id) await notify(ctx, 'review_thanks', { customerId: r.customer_id, vars: { message: text } });
  if (r?.appointment_id) await db().update('appointments', r.appointment_id, { needs_action: 0 });
  return true;
}

export async function publicReviews(ctx: Ctx, limit = 12) {
  return db().all<any>(
    `SELECT r.id, r.rating, r.comment, r.channel, r.public_url, r.created_ts, c.first_name, c.last_name, s.name AS service_name
     FROM reviews r LEFT JOIN customers c ON c.id = r.customer_id LEFT JOIN services s ON s.id = r.service_id
     WHERE r.location_id = :l AND r.visibility = 'public' AND r.status = 'public'
     ORDER BY r.created_ts DESC LIMIT :n`,
    { l: ctx.locId, n: limit },
  );
}

export async function reviewStats(ctx: Ctx) {
  const q = db();
  const rows = await q.all<any>(`SELECT rating, COUNT(*) AS n FROM reviews WHERE location_id = :l AND rating IS NOT NULL AND status IN ('public','private','public_prompted','answered') GROUP BY rating`, { l: ctx.locId });
  const byRating = Object.fromEntries(rows.map((r: any) => [r.rating, r.n]));
  const total = rows.reduce((a: number, r: any) => a + r.n, 0);
  const sum = rows.reduce((a: number, r: any) => a + r.rating * r.n, 0);
  return { count: total, avg: total ? Number((sum / total).toFixed(2)) : null, byRating, googleRating: ctx.brand.rating ?? null };
}

export { cents, MIN };
