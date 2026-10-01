import { db, j, sj } from '../db/index.ts';
import { env } from '../lib/env.ts';
import { rnd } from '../lib/secrets.ts';
import { humanDur, MIN } from '../lib/time.ts';
import type { Ctx } from './context.ts';
import { audit } from './customers.ts';
import { observe } from '../lib/observe.ts';
import { serviceById, type ServiceRow } from './context.ts';
import { invalidateCtx } from '../lib/../domain/context.ts';
void invalidateCtx;

/**
 * Paiements. Fournisseur interchangeable : `demo` (aucune dépendance, flux complet simulé,
 * idéal pour la démo/les tests) ou `stripe` (PaymentIntent + acompte + webhook).
 * L'acompte n'est jamais demandé sans que les conditions soient affichées AVANT validation :
 * le calcul est le même côté lecture (public) et écriture (transaction).
 */

export interface DepositPlan {
  mode: 'none' | 'fixed' | 'percent' | 'full';
  amountCents: number;
  label: string;
  refundableUntilTs: number | null;
  policyText: string;
}

export const paymentsOff = () => env.payments === 'off';

export function depositFor(ctx: Ctx, o: { priceCents: number; service: ServiceRow; customer?: any; durationMin: number }) {
  if (paymentsOff() || !ctx.features.deposits) return 0;
  const p = ctx.policy.deposit;
  const mustBecauseHistory = (o.customer?.noshow_count ?? 0) >= ctx.policy.noShowDepositEscalation;
  const mustBecauseService = ctx.policy.requireDepositForServices.includes(o.service.key);
  const mustBecausePrice = o.priceCents >= p.aboveCents;
  if (p.mode === 'none' && !mustBecauseHistory && !mustBecauseService) return 0;
  if (!mustBecauseHistory && !mustBecauseService && !mustBecausePrice && p.mode === 'none') return 0;
  switch (mustBecauseHistory || mustBecauseService || mustBecausePrice ? p.mode : 'none') {
    case 'fixed':
      return Math.min(p.amountCents, o.priceCents);
    case 'full':
      return o.priceCents;
    case 'percent':
      return Math.max(p.amountCents, Math.round((o.priceCents * p.percent) / 100));
    default:
      return 0;
  }
}

export function depositPlan(ctx: Ctx, o: { priceCents: number; service: ServiceRow; customer?: any; durationMin: number }): DepositPlan {
  const amount = depositFor(ctx, o);
  const mode = amount === 0 ? 'none' : amount >= o.priceCents ? 'full' : ctx.policy.deposit.mode;
  const cutoff = ctx.policy.cancelCutoffMin;
  return {
    mode,
    amountCents: amount,
    label: amount === 0 ? 'Aucun acompte — tu règles sur place' : `Acompte de ${(amount / 100).toFixed(2).replace('.', ',')} € à la réservation, déduit du total`,
    refundableUntilTs: cutoff ? Date.now() + 0 : null,
    policyText:
      amount === 0
        ? `Annulation ou report possibles jusqu'à ${humanDur(cutoff * MIN)} avant, en un clic depuis le SMS. Passé ce délai, la prestation est due si tu ne viens pas.`
        : `Acompte de ${(amount / 100).toFixed(2).replace('.', ',')} € : il est déduit du prix et remboursé intégralement si tu annules plus de ${humanDur(cutoff * MIN)} avant. En dessous de ce délai, il est conservé (${ctx.policy.deposit.mode === 'full' ? 'soit le prix total' : 'no-show confirmé'}). Annuler libère le créneau pour les clients en attente.`,
  };
}

/** Levée quand le salon n'encaisse pas en ligne : les appelants la traduisent en message client.
 *  Un type à part évite de la confondre avec une panne de PSP (qui, elle, se rejoue). */
export class PayDisabledError extends Error {}

export interface PayResult {
  id: number;
  status: 'succeeded' | 'pending' | 'failed';
  provider: string;
  clientSecret: string | null;
  url: string | null;
  pending: boolean;
}

export async function ensurePayment(ctx: Ctx, o: { appointmentId: number; customerId: number; amountCents: number; kind: 'deposit' | 'full' | 'gift_card' | 'membership'; mode?: 'deposit' | 'full' | 'none'; idem?: string }): Promise<PayResult> {
  // Paiements désactivés : on ne fait PAS semblant de réussir. Aucun paiement en ligne n'est
  // créé, aucune carte cadeau n'est marquée payée, et l'appelant reçoit le motif.
  if (paymentsOff()) {
    await observe('payment', o.kind, 0, 'skipped', { provider: 'off', motif: 'reglement_sur_place' }, ctx.locId);
    throw new PayDisabledError('Paiement en ligne désactivé (PAYMENTS_PROVIDER=off) : règlement sur place.');
  }
  const q = db();
  const idem = o.idem ?? `appt:${o.appointmentId}:${o.kind}`;
  const existing = await q.one<any>(`SELECT * FROM payments WHERE idempotency_key = :k`, { k: idem });
  if (existing && (existing.status === 'succeeded' || existing.status === 'pending')) {
    return { id: existing.id, status: existing.status, provider: existing.provider, clientSecret: j<any>(existing.meta_json, {}).clientSecret ?? null, url: j<any>(existing.meta_json, {}).url ?? null, pending: existing.status === 'pending' };
  }
  const t0 = Date.now();
  const provider = env.payments === 'stripe' && env.stripeSecret ? 'stripe' : 'demo';
  if (provider === 'demo') {
    const id =
      existing?.id ??
      (await q.insert('payments', {
        location_id: ctx.locId,
        appointment_id: o.appointmentId,
        customer_id: o.customerId,
        kind: o.kind,
        provider,
        provider_ref: `demo_${rnd(10)}`,
        amount_cents: o.amountCents,
        status: 'succeeded',
        idempotency_key: idem,
        meta_json: sj({ simulated: true, note: 'Aucune carte n’est débitée en mode démo.' }),
        created_ts: Date.now(),
        updated_ts: Date.now(),
      }));
    if (existing) await q.update('payments', existing.id, { status: 'succeeded', updated_ts: Date.now() });
    await observe('payment', 'deposit', Date.now() - t0, 'ok', { provider, amount: o.amountCents }, ctx.locId);
    return { id, status: 'succeeded', provider, clientSecret: null, url: null, pending: false };
  }

  // Stripe réel : PaymentIntent côté serveur, jamais de carte dans notre base.
  try {
    const { default: Stripe } = await import('stripe' as string).catch(() => ({ default: null } as any));
    if (!Stripe) throw new Error('Le package `stripe` n’est pas installé : npm i stripe (ou PAYMENTS_PROVIDER=demo)');
    const stripe = new Stripe(env.stripeSecret, { typescript: true });
    const intent = await stripe.paymentIntents.create({
      amount: o.amountCents,
      currency: 'eur',
      description: `${ctx.name} — rendez-vous #${o.appointmentId}`,
      metadata: { appointment_id: String(o.appointmentId), location_id: String(ctx.locId), kind: o.kind },
      confirm: false,
      idempotency_key: idem,
    });
    const id = await q.insert('payments', {
      location_id: ctx.locId,
      appointment_id: o.appointmentId,
      customer_id: o.customerId,
      kind: o.kind,
      provider,
      provider_ref: intent.id,
      amount_cents: o.amountCents,
      status: 'pending',
      idempotency_key: idem,
      meta_json: sj({ clientSecret: intent.client_secret }),
      created_ts: Date.now(),
      updated_ts: Date.now(),
    });
    return { id, status: 'pending', provider, clientSecret: intent.client_secret ?? null, url: null, pending: true };
  } catch (e: any) {
    const id = await q.insert('payments', {
      location_id: ctx.locId,
      appointment_id: o.appointmentId,
      customer_id: o.customerId,
      kind: o.kind,
      provider,
      amount_cents: o.amountCents,
      status: 'failed',
      failure_reason: String(e.message).slice(0, 200),
      idempotency_key: idem + ':fail',
      created_ts: Date.now(),
      updated_ts: Date.now(),
    });
    await observe('payment', 'deposit', Date.now() - t0, 'error', { error: String(e.message).slice(0, 200) }, ctx.locId);
    return { id, status: 'failed', provider, clientSecret: null, url: null, pending: false };
  }
}

/** webhook Stripe : `payment_intent.succeeded` => RDV payé et confirmé. */
export async function handleStripeWebhook(rawBody: string, signature: string) {
  const { default: Stripe } = await import('stripe' as string).catch(() => ({ default: null } as any));
  if (!Stripe) throw new Error('stripe manquant');
  const stripe = new Stripe(env.stripeSecret, { typescript: true });
  let event: any;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, env.stripeWebhook);
  } catch (e: any) {
    throw new Error('signature webhook invalide: ' + e.message);
  }
  const q = db();
  if (event.type === 'payment_intent.succeeded' || event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    const pay = await q.one<any>(`SELECT * FROM payments WHERE provider_ref = :r`, { r: pi.id });
    if (pay) {
      const ok = event.type === 'payment_intent.succeeded';
      await q.update('payments', pay.id, { status: ok ? 'succeeded' : 'failed', failure_reason: ok ? null : 'échec carte', updated_ts: Date.now() });
      if (pay.appointment_id) {
        await q.update('appointments', pay.appointment_id, ok ? { status: 'booked', deposit_status: 'paid', paid_cents: pay.amount_cents } : { status: 'cancelled', deposit_status: 'failed', cancel_reason: 'paiement_refuse', cancelled_ts: Date.now() });
        await q.insert('appointment_events', { appointment_id: pay.appointment_id, kind: ok ? 'deposit_paid' : 'payment_failed', data_json: sj({ provider: 'stripe', pi: pi.id }), actor_type: 'system', ts: Date.now() });
      }
    }
  }
  return { received: true, type: event.type };
}

export async function refundPayment(ctx: Ctx, payment: any, reason: string) {
  const q = db();
  if (!payment || payment.status !== 'succeeded') return 0;
  if (payment.provider === 'demo') {
    const id = await q.insert('payments', { location_id: ctx.locId, appointment_id: payment.appointment_id, customer_id: payment.customer_id, kind: 'refund', provider: 'demo', provider_ref: `reimb_${payment.provider_ref}`, amount_cents: payment.amount_cents, status: 'succeeded', refund_of: payment.id, failure_reason: null, meta_json: sj({ reason, simulated: true }), created_ts: Date.now(), updated_ts: Date.now() });
    void id;
    await q.update('payments', payment.id, { status: 'refunded', updated_ts: Date.now() });
    await q.update('appointments', payment.appointment_id, { deposit_status: 'refunded' });
    await audit(ctx.locId, 'system', null, 'payment.refund', 'payment', payment.id, { amount: payment.amount_cents, reason });
    return payment.amount_cents;
  }
  try {
    const { default: Stripe } = await import('stripe' as string).catch(() => ({ default: null } as any));
    if (!Stripe) throw new Error('stripe manquant');
    const stripe = new Stripe(env.stripeSecret, { typescript: true });
    const r = await stripe.refunds.create({ payment_intent: payment.provider_ref });
    await q.insert('payments', { location_id: ctx.locId, appointment_id: payment.appointment_id, customer_id: payment.customer_id, kind: 'refund', provider: 'stripe', provider_ref: r.id, amount_cents: payment.amount_cents, status: r.status === 'succeeded' ? 'succeeded' : 'pending', refund_of: payment.id, meta_json: sj({ reason }), created_ts: Date.now(), updated_ts: Date.now() });
    await q.update('payments', payment.id, { status: r.status === 'succeeded' ? 'refunded' : 'refund_pending', updated_ts: Date.now() });
    await q.update('appointments', payment.appointment_id, { deposit_status: 'refunded' });
    return payment.amount_cents;
  } catch (e: any) {
    await observe('payment', 'refund', null, 'error', { error: String(e.message) }, ctx.locId);
    return 0;
  }
}

export { serviceById };
