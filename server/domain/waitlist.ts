import { db, j, sj, transaction } from '../db/index.ts';
import { DAY, MIN, dateKey, dow as dowOf, fmtDate, fmtTime, humanWhen, minutesOfDay, startOfDayMs } from '../lib/time.ts';
import { appLink, cleanText, normalizePhone } from '../lib/inputs.ts';
import { signToken, verifyToken } from '../lib/secrets.ts';
import type { Ctx } from './context.ts';
import { bumpAvailabilityCache, computeDay, slotOfferable } from './availability.ts';
import { notify, dispatchNow } from './notify.ts';
import { audit, upsertCustomer } from './customers.ts';
import { fireAutomation } from './automations.ts';

/**
 * Waitlist — la règle "zéro demande perdue".
 * Un créneau libéré ne reste jamais vide : il est proposé, dans l'ordre de priorité,
 * aux clients en attente compatibles, avec un délai d'exclusivité court et automatique.
 * L'exclusivité est réelle : le créneau est passé en `held` (donc invendable) tant que
 * l'offre est ouverte, puis relibéré si personne ne répond.
 */

export interface WaitlistJoin {
  name: string;
  phone: string;
  email?: string | null;
  serviceId?: number | null;
  offeringId?: number | null;
  staffId?: number | null;
  days?: (number | string)[];
  window?: [number, number] | null;
  flex?: { otherStaff?: boolean; otherDays?: boolean; sameDayOtherTime?: boolean; anyTime?: boolean };
  note?: string | null;
  consent?: boolean;
  source?: string | null;
  customerId?: number | null;
  attribution?: any;
}

export async function joinWaitlist(ctx: Ctx, inp: WaitlistJoin) {
  return transaction(async q => {
  const phoneNorm = normalizePhone(inp.phone);
  if (!/^\d{9,15}$/.test(phoneNorm)) throw Object.assign(new Error('Numéro invalide'), { status: 422, code: 'telephone_invalide' });
  const dup = await q.one<any>(`SELECT * FROM waitlist WHERE location_id = :l AND phone_norm = :p AND status = 'active'`, { l: ctx.locId, p: phoneNorm });
  if (dup) {
    // Connaître un numéro de téléphone ne donne pas accès au suivi privé d'une autre personne.
    return { alreadyExists: true, message: 'Une demande existe déjà pour ce numéro. Utilise ton lien de suivi précédent ou contacte le salon.' };
  }
  let customerId = inp.customerId ?? null;
  if (!customerId && inp.email) {
    const c = await q.one<any>(`SELECT id FROM customers WHERE location_id = :l AND (phone_norm = :p OR email_norm = :e)`, { l: ctx.locId, p: phoneNorm, e: (inp.email || '').toLowerCase() });
    customerId = c?.id ?? null;
  }
  const id = await q.insert('waitlist', {
    location_id: ctx.locId,
    customer_id: customerId,
    name: cleanText(inp.name, 60) || 'Client',
    phone: inp.phone,
    phone_norm: phoneNorm,
    email: inp.email ?? null,
    service_id: inp.serviceId ?? null,
    offering_id: inp.offeringId ?? null,
    staff_id: inp.staffId ?? null,
    days: sj(inp.days ?? []),
    window_start_min: inp.window?.[0] ?? null,
    window_end_min: inp.window?.[1] ?? null,
    flex_json: sj(inp.flex ?? { otherStaff: true, otherDays: true, sameDayOtherTime: true }),
    note: inp.note ? cleanText(inp.note, 400) : null,
    priority: 0,
    status: 'active',
    consent_contact: inp.consent === false ? 0 : 1,
    source: inp.source ?? 'booking_full',
    token: signToken({ w: 0, k: 'waitlist' }),
    created_ts: Date.now(),
    updated_ts: Date.now(),
  });
  await q.update('waitlist', id, { token: signToken({ w: id, k: 'waitlist' }, 365 * DAY) });
  await audit(ctx.locId, 'customer', customerId, 'waitlist.join', 'waitlist', id, { serviceId: inp.serviceId, days: inp.days });
  const row = await q.one<any>(`SELECT * FROM waitlist WHERE id = :i`, { i: id });
  const guess = await nextSlotGuessFor(ctx, row);
  if (inp.email && inp.consent !== false) await notify(ctx, 'waitlist_joined', { emailTo: inp.email, channels: ['email'], idem: `waitlist-join:${id}:email`, vars: { link_manage: appLink(`/waitlist?token=${row.token}`), staff: '', service: '' } });
  return { id, alreadyExists: false, position: await position(row), token: row.token, status: 'active', estimatedNext: guess, manageUrl: appLink(`/waitlist?token=${row.token}`) };
  }, ctx.locId);
}

async function position(entry: any) {
  const ahead = await db().num(`SELECT COUNT(*) FROM waitlist WHERE location_id = :l AND status = 'active' AND (priority > :pr OR (priority = :pr AND created_ts < :c))`, { l: entry.location_id, pr: entry.priority, c: entry.created_ts });
  const total = await db().num(`SELECT COUNT(*) FROM waitlist WHERE location_id = :l AND status = 'active'`, { l: entry.location_id });
  return { rank: ahead + 1, total };
}

async function nextSlotGuessFor(ctx: Ctx, entry: any) {
  const serviceId = entry.service_id ?? ctx.services[0]?.id;
  const svc = ctx.services.find((s) => s.id === serviceId) ?? ctx.services[0];
  if (!svc) return null;
  const off = ctx.offerings.find(o => o.service_id === svc.id);
  if (!off) return null;
  const st = ctx.staff.filter(s => (!s.service_ids.length || s.service_ids.includes(svc.id)) && (!entry.staff_id || j<any>(entry.flex_json, {}).otherStaff || s.id === entry.staff_id));
  if (!st.length) return null;
  for (let d = 0; d < Math.min(30, ctx.policy.horizonDays); d++) {
    const day = dateKey(Date.now() + d * DAY);
    const result = await computeDay(ctx, { serviceId: svc.id, durationMin: off.duration_min, prepMin: svc.prep_min, cleanupMin: svc.cleanup_min, staffIds: st.map(s => s.id), day, now: Date.now(), window: null });
    const slot = result.slots.find(s => s.staffIds.some(id => Number.isFinite(scoreEntry(ctx, entry, { start: s.start, staffId: id, serviceId: svc.id }).score)));
    if (slot) return { start: slot.start, end: slot.end, staffId: slot.staffIds.find(id => Number.isFinite(scoreEntry(ctx, entry, { start: slot.start, staffId: id, serviceId: svc.id }).score))!, label: `${fmtDate(slot.start, { short: true })} à ${fmtTime(slot.start)}`, serviceId: svc.id, offeringId: off.id };
  }
  return null;
}

/** File ordonnée par compatibilité réelle, pas seulement par ancienneté. */
export function scoreEntry(ctx: Ctx, e: any, slot: { start: number; staffId: number; serviceId: number }, opts: { customer?: any } = {}) {
  const flex = j<any>(e.flex_json, {});
  const days = j<(number | string)[]>(e.days, []);
  const matchesDay = !days.length || days.includes(dateKey(slot.start)) || days.includes(dowOf(slot.start));
  if ((!matchesDay && !flex.otherDays) || (e.staff_id && e.staff_id !== slot.staffId && !flex.otherStaff) || (e.window_start_min != null && (minutesOfDay(slot.start) < e.window_start_min || minutesOfDay(slot.start) >= e.window_end_min) && !flex.sameDayOtherTime) || slot.start <= Date.now()) return { score: -Infinity, reasons: ['hors contraintes acceptées'] };
  let score = 0;
  const reasons: string[] = [];
  const day = dateKey(slot.start);
  const wantedDays = j<(number | string)[]>(e.days, []);
  if (!wantedDays.length) {
    score += 40;
    reasons.push('sans contrainte de jour');
  } else if (wantedDays.includes(day)) {
    score += 100;
    reasons.push('jour demandé');
  } else if (wantedDays.includes(dowOf(startOfDayMs(day)))) {
    score += 30;
    reasons.push('même jour de semaine');
  } else if (j<any>(e.flex_json, {}).otherDays) {
    score -= 5;
    reasons.push('autre jour (flexible)');
  } else {
    score -= 60;
    reasons.push('jour non demandé');
  }
  if (e.window_start_min != null && e.window_end_min != null) {
    const m = minutesOfDay(slot.start);
    if (m >= e.window_start_min && m <= e.window_end_min) {
      score += 60;
      reasons.push('horaire demandé');
    } else if (j<any>(e.flex_json, {}).sameDayOtherTime) {
      score += 10;
      reasons.push('hors créneau mais flexible');
    } else score -= 80;
  }
  if (e.staff_id && e.staff_id === slot.staffId) {
    score += 40;
    reasons.push('barbier demandé');
  } else if (e.staff_id) {
    score += j<any>(e.flex_json, {}).otherStaff ? 8 : -100;
  }
  const seniorityDays = Math.max(0, (Date.now() - e.created_ts) / DAY);
  score += Math.min(40, seniorityDays * 6);
  if (e.priority > 0) {
    score += e.priority * 50;
    reasons.push('priorité manuelle');
  }
  if (opts.customer) {
    if (opts.customer.loyalty_visits >= 8) {
      score += 25;
      reasons.push('client fidèle');
    }
    if (opts.customer.priority_until && opts.customer.priority_until > Date.now()) {
      score += 60;
      reasons.push('accès prioritaire');
    }
    if ((opts.customer.noshow_count ?? 0) >= 3) score -= 25;
    if (opts.customer.membership_status === 'active') score += 20;
  }
  if (slot.start < Date.now()) score -= 500;
  return { score, reasons };
}

export async function eligibleForSlot(ctx: Ctx, slot: { start: number; end: number; staffId: number; serviceId: number; offeringId: number }, limit = 3) {
  const q = db();
  const svc = ctx.services.find((s) => s.id === slot.serviceId);
  const rows = await q.all<any>(
    `SELECT w.*, c.loyalty_visits, c.priority_until, c.noshow_count, c.membership_status, c.id AS cust_id
     FROM waitlist w LEFT JOIN customers c ON c.location_id = w.location_id AND (c.phone_norm = w.phone_norm OR (w.email IS NOT NULL AND c.email_norm = lower(w.email)))
     WHERE w.location_id = :l AND w.status = 'active' AND (w.service_id IS NULL OR w.service_id = :s) AND w.consent_contact = 1
       AND (w.closed_ts IS NULL OR w.closed_ts > :recent)
     ORDER BY w.priority DESC, w.created_ts ASC LIMIT 40`,
    { l: ctx.locId, s: slot.serviceId, recent: Date.now() - 2 * MIN },
  );
  const scored = [];
  for (const e of rows) {
    const activeOffer = await q.one(`SELECT id FROM waitlist_offers WHERE waitlist_id = :i AND (status = 'pending' OR (start_ts = :st AND staff_id = :s AND status IN ('declined','expired')))`, { i: e.id, st: slot.start, s: slot.staffId });
    if (activeOffer) continue; // une seule offre ouverte par client (anti-accaparement)
    const sc = scoreEntry(ctx, e, slot, { customer: e });
    if (sc.score < -70) continue;
    scored.push({ entry: e, ...sc });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.created_ts - b.entry.created_ts);
  // un créneau qui ne correspond à personne exactement est quand même proposé au plus proche (zéro demande perdue)
  if (!scored.length) return [];
  void svc;
  return scored.slice(0, limit);
}

/** Un créneau se libère → on le propose. Retourne ce qui a été envoyé. */
export async function replayWaitlist(ctx: Ctx, slot: { staffId: number; start: number; end: number; serviceId: number; offeringId: number; reason?: string }) {
  if (!ctx.features.waitlist) return { offers: 0, claimUrls: [], skipped: 'waitlist désactivée' };
  const q = db();
  const svcNow = ctx.services.find(s => s.id === slot.serviceId);
  const offNow = ctx.offerings.find(o => o.id === slot.offeringId && o.service_id === slot.serviceId);
  const barber = ctx.staff.find(s => s.id === slot.staffId);
  if (!svcNow || !offNow || !barber || (barber.service_ids.length && !barber.service_ids.includes(slot.serviceId)) || slot.start <= Date.now()) return { offers: 0, claimUrls: [], skipped: 'prestation ou barbier indisponible' };
  const real = await computeDay(ctx, { serviceId: svcNow.id, durationMin: offNow.duration_min, prepMin: svcNow.prep_min, cleanupMin: svcNow.cleanup_min, day: dateKey(slot.start), now: Date.now(), staffIds: [barber.id], respectStep: false, window: null });
  if (slot.start < Date.now() + ctx.policy.leadTimeMin * MIN || !slotOfferable(real, slot.start, slot.start + offNow.duration_min * MIN)) return { offers: 0, claimUrls: [], skipped: 'créneau hors disponibilités réelles' };
  slot = { ...slot, end: slot.start + offNow.duration_min * MIN };
  const cfg = await q.one<any>(`SELECT config_json FROM automations WHERE location_id = :l AND key = 'auto_waitlist_replay' AND is_active = 1`, { l: ctx.locId });
  if (!cfg) return { offers: 0, claimUrls: [], skipped: 'automatisation désactivée' };
  const conf = j<any>(cfg.config_json, {});
  const ttl = Math.min((conf.ttlMin ?? ctx.policy.waitlistOfferTtlMin) * MIN, slot.start - Date.now());
  const max = conf.maxPerSlot ?? 3;
  const eligible = await eligibleForSlot(ctx, slot, max);
  if (!eligible.length) return { offers: 0, claimUrls: [], skipped: 'aucune demande compatible' };

  const created: { offerId: number; url: string; name: string; declineUrl?: string }[] = [];
  for (const { entry, score, reasons } of eligible) {
    let customerId = entry.customer_id;
    if (!customerId) {
      const { customer } = await upsertCustomer(ctx, {
        phone: entry.phone,
        email: entry.email,
        firstName: (entry.name || 'Client').split(' ')[0],
        lastName: (entry.name || '').split(' ').slice(1).join(' ') || null,
        attribution: { source: 'waitlist', medium: 'system' },
      });
      customerId = customer.id;
      await q.update('waitlist', entry.id, { customer_id: customerId });
    }
    try {
      const result = await transaction(async (t) => {
        const freshEntry = await t.one<any>('SELECT status, consent_contact FROM waitlist WHERE id = :i AND location_id = :l', { i: entry.id, l: ctx.locId });
        if (!freshEntry || freshEntry.status !== 'active' || !freshEntry.consent_contact) return null;
        const clash = await t.one(
          `SELECT id FROM appointments WHERE staff_id = :s AND status IN ('booked','confirmed','pending_payment','held','waiting_client','in_progress') AND start_ts < :e AND end_ts > :st LIMIT 1`,
          { s: slot.staffId, st: slot.start, e: slot.end },
        );
        if (clash) return null;
        const apptId = await t.insert('appointments', {
          location_id: ctx.locId,
          customer_id: customerId,
          offering_id: slot.offeringId,
          service_id: slot.serviceId,
          staff_id: slot.staffId,
          start_ts: slot.start,
          end_ts: slot.end,
          status: 'held',
          price_cents: 0,
          duration_min: Math.round((slot.end - slot.start) / MIN),
          waitlist_offer_id: null,
          source: 'waitlist',
          created_ts: Date.now(),
          updated_ts: Date.now(),
        });
        const offerId = await t.insert('waitlist_offers', {
          waitlist_id: entry.id,
          location_id: ctx.locId,
          staff_id: slot.staffId,
          offering_id: slot.offeringId,
          service_id: slot.serviceId,
          start_ts: slot.start,
          end_ts: slot.end,
          status: 'pending',
          channel: 'sms',
          token: `tmp-${Math.random().toString(36).slice(2)}-${apptId}`,
          expires_ts: Date.now() + ttl,
          created_ts: Date.now(),
          reason: sj({ score, reasons, why: slot.reason ?? 'slot_freed' }),
        });
        await t.update('appointments', apptId, { waitlist_offer_id: offerId });
        await t.update('waitlist_offers', offerId, { appointment_id: apptId });
        await t.update('waitlist_offers', offerId, { token: signToken({ o: offerId, k: 'claim', a: apptId }, ttl + 5 * MIN) });
        await t.insert('appointment_events', { appointment_id: apptId, kind: 'waitlist_hold', data_json: sj({ waitlistId: entry.id, score, reasons, ttlMin: ttl / MIN }), actor_type: 'system', ts: Date.now() });
        return { offerId, apptId };
      }, ctx.locId);
      if (!result) continue;
      const svc = ctx.services.find((s) => s.id === slot.serviceId);
      const saved = await q.one<any>(`SELECT token FROM waitlist_offers WHERE id = :i`, { i: result.offerId });
      await notify(ctx, 'waitlist_offer', {
        customerId,
        appointmentId: result.apptId,
        waitlistOfferId: result.offerId,
        vars: {
          waitlistToken: saved?.token ?? null,
          service: svc?.name ?? 'ta prestation',
          jour: fmtDate(slot.start, { weekday: true }).split(' ')[0],
          date: fmtDate(slot.start, { short: true }),
          heure: fmtTime(slot.start),
          ttl: String(Math.round(ttl / MIN)),
          slot: humanWhen(slot.start),
        },
      });
      await q.update('waitlist', entry.id, { notified_count: entry.notified_count + 1, updated_ts: Date.now() });
      created.push({ offerId: result.offerId, url: appLink(`/waitlist/reserver?token=${saved?.token}`), declineUrl: appLink(`/waitlist/refuser?token=${saved?.token}`), name: entry.name });
    } catch (e: any) {
      if (!/UNIQUE/i.test(String(e?.message))) console.error('[waitlist]', String(e?.message).slice(0, 140));
    }
  }
  await fireAutomation(ctx, 'waitlist_notified', { slot, offers: created.length });
  bumpAvailabilityCache();
  return { offers: created.length, claimUrls: created.map((c) => c.url), entries: created };
}

export async function resolveClaimToken(token: string) {
  const payload = verifyToken<{ o: number; a?: number; k: string }>(token);
  if (!payload || payload.k !== 'claim') return null;
  const q = db();
  const offer = payload.o ? await q.one<any>(`SELECT * FROM waitlist_offers WHERE id = :i`, { i: payload.o }) : await q.one<any>(`SELECT * FROM waitlist_offers WHERE token = :t`, { t: token });
  if (!offer) return null;
  return { offer, expired: offer.expires_ts < Date.now() };
}

/** Réclamation : le créneau est à toi. Tout est vérifié dans la transaction. */
export async function claimOffer(ctx: Ctx, token: string) {
  const q = db();
  const resolved = await resolveClaimToken(token);
  if (!resolved || resolved.offer.location_id !== ctx.locId) return { ok: false, code: 'lien_invalide', message: 'Ce lien n’est plus valide.' };
  const { offer } = resolved;
  if (offer.status === 'claimed') {
    const appt = await q.one<any>(`SELECT * FROM appointments WHERE id = :i`, { i: offer.appointment_id });
    return { ok: true, alreadyClaimed: true, appointmentId: appt?.id, start: offer.start_ts, manageToken: appt ? signToken({ a: appt.id, c: appt.customer_id, k: 'manage' }, 120 * DAY) : undefined };
  }
  if (offer.status !== 'pending') return { ok: false, code: 'offre_prise', message: 'Ce créneau est parti. Voici d’autres possibilités.' };
  if (offer.expires_ts < Date.now()) return { ok: false, code: 'expire', message: "L'offre a expiré — le créneau est repassé aux autres clients en attente." };

  const out = await transaction(async (t) => {
    const o = await t.one<any>(`SELECT * FROM waitlist_offers WHERE id = :i`, { i: offer.id });
    if (!o || o.status !== 'pending') throw new SlotTaken();
    if (o.expires_ts < Date.now()) throw new SlotExpired();
    const appt = await t.one<any>(`SELECT * FROM appointments WHERE id = :i`, { i: o.appointment_id ?? -1 });
    if (!appt || appt.status !== 'held') throw new SlotTaken();
    const w = await t.one<any>('SELECT status FROM waitlist WHERE id = :i AND location_id = :l', { i: o.waitlist_id, l: ctx.locId });
    if (!w || w.status !== 'active') throw new SlotTaken();
    const clash = await t.one(
      `SELECT id FROM appointments WHERE staff_id = :s AND id != :self AND status IN ('booked','confirmed','pending_payment','waiting_client','in_progress') AND start_ts < :e AND end_ts > :st LIMIT 1`,
      { s: o.staff_id, self: appt.id, st: o.start_ts, e: o.end_ts },
    );
    if (clash) throw new SlotTaken();
    const svc = ctx.services.find((s) => s.id === o.service_id);
    const off = ctx.offerings.find((x) => x.id === o.offering_id);
    if (!svc || !off || !ctx.staff.some(s => s.id === o.staff_id)) throw new SlotTaken();
    const real = await computeDay(ctx, { serviceId: svc.id, durationMin: off.duration_min, prepMin: svc.prep_min, cleanupMin: svc.cleanup_min, day: dateKey(o.start_ts), now: Date.now(), staffIds: [o.staff_id], excludeAppointmentId: appt.id, respectStep: false, window: null });
    // Le préavis a été validé lors de la mise en réserve ; honorer l'offre jusqu'à son échéance.
    if (o.start_ts <= Date.now() || !slotOfferable(real, o.start_ts, o.start_ts + off.duration_min * MIN)) throw new SlotTaken();
    const price = off.price_cents;
    await t.update('appointments', appt.id, { status: 'booked', price_cents: price, duration_min: (o.end_ts - o.start_ts) / MIN, updated_ts: Date.now(), source: 'waitlist', deposit_cents: 0, deposit_status: 'none' });
    await t.update('waitlist_offers', o.id, { status: 'claimed', responded_ts: Date.now(), appointment_id: appt.id });
    await t.update('waitlist', o.waitlist_id, { status: 'fulfilled', fulfilled_ts: Date.now(), updated_ts: Date.now() });
    await t.insert('appointment_events', { appointment_id: appt.id, kind: 'waitlist_claimed', data_json: sj({ offerId: o.id }), actor_type: 'customer', ts: Date.now() });
    await t.update('customers', appt.customer_id, { next_visit_ts: o.start_ts, updated_ts: Date.now() });
    return { apptId: appt.id, customerId: appt.customer_id, start: o.start_ts, end: o.end_ts, staffId: o.staff_id, priceCents: price };
  }, ctx.locId);

  bumpAvailabilityCache();
  // les autres offres sur le même créneau sont annulées et leurs holds libérés
  await releaseOtherOffersForSlot(ctx, out.start, out.staffId, offer.id);
  const appt = await q.one<any>(`SELECT * FROM appointments WHERE id = :i`, { i: out.apptId });
  const customer = await q.one<any>(`SELECT * FROM customers WHERE id = :i`, { i: out.customerId });
  await notify(ctx, 'booking_confirmed', { appointmentId: out.apptId, customerId: out.customerId });
  await scheduleRemindersFromClaim(ctx, appt);
  await fireAutomation(ctx, 'waitlist_claimed', { appointmentId: out.apptId, customerId: out.customerId, slot: out.start });
  await audit(ctx.locId, 'customer', out.customerId, 'waitlist.claim', 'appointment', out.apptId, { offerId: offer.id });
  void customer;
  await dispatchNow(ctx, 30);
  return { ok: true, appointmentId: out.apptId, manageToken: signToken({ a: out.apptId, c: out.customerId, k: 'manage' }, 120 * DAY), ...out };
}

class SlotTaken extends Error {
  status = 409;
  constructor() { super('Ce créneau n’est plus disponible.'); }
  code = 'creneau_pris';
}
class SlotExpired extends Error {
  status = 409;
  constructor() { super('Cette offre a expiré.'); }
  code = 'expire';
}

async function scheduleRemindersFromClaim(ctx: Ctx, appt: any) {
  const { scheduleAppointmentNotifications } = await import('./notify.ts');
  await scheduleAppointmentNotifications(ctx, appt, {});
}

export async function declineOffer(ctx: Ctx, token: string) {
  const resolved = await resolveClaimToken(token);
  if (!resolved || resolved.offer.location_id !== ctx.locId) return { ok: false, message: 'Lien invalide ou expiré.' };
  const offer = resolved.offer;
  const result = await transaction(async t => {
    const o = await t.one<any>('SELECT * FROM waitlist_offers WHERE id = :i', { i: offer.id });
    if (o?.status === 'declined') return { ok: true, already: true };
    if (!o || o.status !== 'pending') return { ok: false, message: 'Cette offre est déjà traitée. Aucun rendez-vous confirmé n’a été annulé.' };
    await t.update('waitlist_offers', o.id, { status: 'declined', responded_ts: Date.now() });
    await t.exec("UPDATE appointments SET status = 'cancelled', cancelled_ts = :n, cancel_reason = 'waitlist_declinee', updated_ts = :n WHERE id = :a AND status = 'held'", { n: Date.now(), a: o.appointment_id ?? -1 });
    await t.exec("UPDATE notifications SET status = 'cancelled' WHERE waitlist_offer_id = :i AND status = 'queued'", { i: o.id });
    return { ok: true, already: false };
  }, ctx.locId);
  if (!result.ok || result.already) return result;
  bumpAvailabilityCache();
  await replayWaitlist(ctx, { staffId: offer.staff_id, start: offer.start_ts, end: offer.end_ts, serviceId: offer.service_id, offeringId: offer.offering_id, reason: 'decline_replay' });
  await audit(ctx.locId, 'customer', null, 'waitlist.decline', 'waitlist_offers', offer.id, {});
  return { ok: true };
}

export async function closeOpenOffersForSlot(ctx: Ctx, appt: any) {
  const q = db();
  const offers = await q.all<any>(`SELECT * FROM waitlist_offers WHERE location_id = :l AND start_ts = :s AND staff_id = :st AND status = 'pending' AND appointment_id != :a`, { l: ctx.locId, s: appt.start_ts, st: appt.staff_id, a: appt.id });
  for (const o of offers) {
    await q.update('waitlist_offers', o.id, { status: 'expired', responded_ts: Date.now(), reason: sj({ why: 'créneau vendu entre-temps' }) });
    if (o.appointment_id) await q.update('appointments', o.appointment_id, { status: 'cancelled', cancelled_ts: Date.now(), cancel_reason: 'slot_pris', updated_ts: Date.now() });
  }
}

async function releaseOtherOffersForSlot(ctx: Ctx, start: number, staffId: number, keepOfferId: number) {
  const q = db();
  const others = await q.all<any>(`SELECT * FROM waitlist_offers WHERE location_id = :l AND start_ts = :s AND staff_id = :st AND status = 'pending' AND id != :keep`, { l: ctx.locId, s: start, st: staffId, keep: keepOfferId });
  for (const o of others) {
    await q.update('waitlist_offers', o.id, { status: 'expired', responded_ts: Date.now(), reason: sj({ why: 'créneau pris par un autre client en attente' }) });
    if (o.appointment_id) {
      await q.update('appointments', o.appointment_id, { status: 'cancelled', cancelled_ts: Date.now(), cancel_reason: 'waitlist_perdue', updated_ts: Date.now() });
      await q.insert('appointment_events', { appointment_id: o.appointment_id, kind: 'hold_released', data_json: sj({ reason: 'slot_taken_by_other_waitlist' }), actor_type: 'system', ts: Date.now() });
    }
  }
}

/** Le cron expire les offres mortes et fait avancer la file. */
export async function expireStaleOffers(ctx: Ctx) {
  const q = db();
  const due = await q.all<any>(`SELECT * FROM waitlist_offers WHERE location_id = :l AND status = 'pending' AND expires_ts <= :n ORDER BY id LIMIT 50`, { l: ctx.locId, n: Date.now() });
  let promoted = 0, expired = 0;
  for (const o of due) {
    const changed = await transaction(async t => {
      const fresh = await t.one<any>('SELECT * FROM waitlist_offers WHERE id = :i', { i: o.id });
      if (!fresh || fresh.status !== 'pending' || fresh.expires_ts > Date.now()) return false;
      await t.update('waitlist_offers', o.id, { status: 'expired', responded_ts: Date.now(), reason: sj({ why: 'delai_depasse' }) });
      await t.exec("UPDATE appointments SET status = 'cancelled', cancelled_ts = :n, cancel_reason = 'offre_expiree', updated_ts = :n WHERE id = :i AND status = 'held'", { i: o.appointment_id ?? -1, n: Date.now() });
      await t.exec("UPDATE notifications SET status = 'cancelled' WHERE waitlist_offer_id = :i AND status = 'queued'", { i: o.id });
      return true;
    }, ctx.locId);
    if (!changed) continue;
    expired++; bumpAvailabilityCache();
    const r = await replayWaitlist(ctx, { staffId: o.staff_id, start: o.start_ts, end: o.end_ts, serviceId: o.service_id, offeringId: o.offering_id, reason: 'offer_expired_replay' });
    promoted += r.offers;
  }
  return { expired, promoted };
}

/** Capacité ajoutée (heures ouvertes, nouveau barbier) → on rappelle ceux qui attendent. */
export async function fulfillPromises(ctx: Ctx) {
  if (!ctx.features.waitlist || !ctx.services.length || !ctx.staff.length) return { notified: 0 };
  const rows = await db().all<any>(`SELECT * FROM waitlist WHERE location_id = :l AND status = 'active' AND consent_contact = 1 ORDER BY priority DESC, created_ts LIMIT 40`, { l: ctx.locId });
  let notified = 0;
  for (const e of rows) {
    if (await db().one("SELECT id FROM waitlist_offers WHERE waitlist_id = :i AND status = 'pending'", { i: e.id })) continue;
    const guess = await nextSlotGuessFor(ctx, e);
    if (!guess) continue;
    const result = await replayWaitlist(ctx, { staffId: guess.staffId, start: guess.start, end: guess.end, serviceId: guess.serviceId, offeringId: guess.offeringId, reason: 'capacite_disponible' });
    notified += result.offers;
  }
  return { notified };
}

export async function waitlistStats(ctx: Ctx) {
  const q = db();
  const rows = await q.all<any>(`SELECT * FROM waitlist WHERE location_id = :l AND status = 'active' ORDER BY priority DESC, created_ts`, { l: ctx.locId });
  const out = [];
  for (const r of rows) {
    const svc = ctx.services.find((s) => s.id === r.service_id);
    out.push({
      id: r.id,
      name: r.name,
      phone: r.phone,
      phoneDisplay: r.phone,
      service: svc?.name ?? 'Prestation libre',
      serviceId: r.service_id,
      staffId: r.staff_id,
      staffName: ctx.staff.find((s) => s.id === r.staff_id)?.name ?? 'Peu importe',
      days: j(r.days, []),
      window: r.window_start_min != null ? [r.window_start_min, r.window_end_min] : null,
      flex: j(r.flex_json, {}),
      note: r.note,
      priority: r.priority,
      waitingSince: r.created_ts,
      waitingLabel: humanWhen(r.created_ts),
      notified: r.notified_count,
      token: r.token,
      estimatedNext: await nextSlotGuessFor(ctx, r),
    });
  }
  const offers = await q.all<any>(`SELECT o.*, w.name FROM waitlist_offers o JOIN waitlist w ON w.id = o.waitlist_id WHERE o.location_id = :l AND o.status = 'pending'`, { l: ctx.locId });
  return { entries: out, openOffers: offers.map((o: any) => ({ ...o, expiresInMin: Math.round((o.expires_ts - Date.now()) / MIN) })) };
}

/** Owners: forcer une offre manuelle sur un créneau précis. */
export async function manualOffer(ctx: Ctx, waitlistId: number, slot: { staffId: number; start: number; end: number; serviceId: number; offeringId: number }) {
  return replayWaitlist(ctx, { ...slot, reason: 'manuel' });
}

export async function closeWaitlistEntry(ctx: Ctx, id: number, status = 'closed') {
  const offers = await transaction(async t => {
    const entry = await t.one<any>('SELECT * FROM waitlist WHERE id = :i AND location_id = :l', { i: id, l: ctx.locId });
    if (!entry) throw Object.assign(new Error('Demande introuvable.'), { status: 404 });
    if (entry.status === 'fulfilled') return [];
    await t.update('waitlist', id, { status, closed_ts: Date.now(), updated_ts: Date.now() });
    const rows = await t.all<any>("SELECT * FROM waitlist_offers WHERE waitlist_id = :i AND status = 'pending'", { i: id });
    for (const o of rows) {
      await t.update('waitlist_offers', o.id, { status: 'expired', responded_ts: Date.now(), reason: sj({ why: 'demande retirée' }) });
      await t.exec("UPDATE appointments SET status = 'cancelled', cancelled_ts = :n, cancel_reason = 'waitlist_retiree', updated_ts = :n WHERE id = :a AND status = 'held'", { n: Date.now(), a: o.appointment_id ?? -1 });
      await t.exec("UPDATE notifications SET status = 'cancelled' WHERE waitlist_offer_id = :i AND status = 'queued'", { i: o.id });
    }
    await t.exec("UPDATE notifications SET status = 'cancelled' WHERE idempotency_key = :k AND status = 'queued'", { k: `waitlist-join:${id}:email` });
    return rows;
  }, ctx.locId);
  bumpAvailabilityCache();
  for (const o of offers) await replayWaitlist(ctx, { staffId: o.staff_id, start: o.start_ts, end: o.end_ts, serviceId: o.service_id, offeringId: o.offering_id, reason: 'retrait_demande' });
  return true;
}
