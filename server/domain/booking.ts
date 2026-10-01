import { db, j, sj, transaction } from '../db/index.ts';
import { DAY, MIN, dateKey, endOfDayMs, fmtDate, fmtTime, humanWhen, minutesOfDay, startOfDayMs, todayDay, dayAdd, weekdayLabel } from '../lib/time.ts';
import { appLink, cleanText, deviceFromUA, normalizeEmail, normalizePhone } from '../lib/inputs.ts';
import { signToken, verifyToken } from '../lib/secrets.ts';
import { bumpAvailabilityCache, computeDay, occupying, occupyingValues, presentStepFor, resolveOffering, slotOfferable, smartAlternatives } from './availability.ts';
import { invalidateCtx, type Ctx } from './context.ts';
import { audit, flagRisk, refreshSegment, upsertCustomer } from './customers.ts';
import { notify, scheduleAppointmentNotifications } from './notify.ts';
import { fireAutomation } from './automations.ts';
import { depositFor, depositPlan, ensurePayment, refundPayment } from './payments.ts';
import { replayWaitlist } from './waitlist.ts';
import { addLoyaltyVisit, computeLoyalty, maybeGiftBirthday, settleReferralOnFirstVisit, applyRedemptionAtBooking } from './loyalty.ts';

export { depositPlan };

/** L'index unique `ux_appt_slot` est le dernier rempart contre le double booking : s'il sonne,
    ce n'est pas une panne à exposer en 500, c'est l'issue métier déjà prévue (créneau pris), avec
    ses solutions de repli. Utile en multi-instance (deux fonctions serverless sur la même minute). */
function isSlotConflict(e: any): boolean {
  const m = `${e?.message ?? ''} ${e?.constraint ?? ''}`;
  return /ux_appt_slot/i.test(m) || /UNIQUE constraint failed: appointments\.location_id, appointments\.staff_id, appointments\.start_ts/i.test(m);
}

async function slotSafe<T>(
  ctx: Ctx,
  p: Promise<T>,
  o: { serviceId: number; durationMin: number; start: number; staffId: number | null },
): Promise<T> {
  try {
    return await p;
  } catch (e: any) {
    if (e instanceof BookingError || !isSlotConflict(e)) throw e;
    throw new BookingError('creneau_pris', 'Ce créneau vient d’être réservé pendant la validation.', 409, {
      alternatives: await suggestAlternativesFor(ctx, { id: o.serviceId }, o.durationMin, o.start, o.staffId),
    });
  }
}


/**
 * Réservation — le contrat du produit :
 *  1. zéro double réservation (vérification de conflit + écriture dans la même transaction atomique),
 *  2. zéro demande perdue (tout refus propose une suite réelle : autres créneaux, waitlist),
 *  3. zéro chaos (confirmation, rappels, recyclage du créneau, avis, rebooking sont déclenchés ici).
 */

export class BookingError extends Error {
  code: string;
  status: number;
  data?: any;
  constructor(code: string, message: string, status = 409, data?: any) {
    super(message);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

export interface Attribution {
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  landing?: string | null;
  device?: string | null;
  referrer?: string | null;
  gclid?: string | null;
}

export interface CreateInput {
  ctx: Ctx;
  offeringId: number;
  addonIds?: number[];
  staffId?: number | null;
  start: number;
  customer: { firstName: string; lastName?: string; phone: string; email?: string; note?: string; birthDay?: string };
  attribution?: Attribution | null;
  consentMarketing?: { email?: boolean; sms?: boolean };
  paymentMode?: 'deposit' | 'full' | 'none';
  giftCardCode?: string | null;
  referrerCode?: string | null;
  rewardCode?: string | null;
  source?: string;
  isWalkin?: boolean;
  requireConfirm?: boolean | null;
  initialStatus?: 'booked' | 'held';
  waitlistId?: number | null;
  force?: boolean;
  actor?: { type: 'customer' | 'staff' | 'owner' | 'system'; id?: number | null };
}

export interface CreatedBooking {
  id: number;
  status: string;
  start: number;
  end: number;
  staffId: number;
  staffName: string;
  serviceName: string;
  priceCents: number;
  depositCents: number;
  balanceCents: number;
  payment: { status: string; provider: string; clientSecret?: string | null; url?: string | null };
  manageToken: string;
  manageUrl: string;
  icsUrl: string;
  customerId: number;
  isNewCustomer: boolean;
  needsConfirm: boolean;
  loyalty: any;
  durationMin: number;
  addOns: { key: string; name: string; priceCents: number }[];
  depositPolicy: any;
  waitlist?: boolean;
}

export async function createBooking(inp: CreateInput): Promise<CreatedBooking> {
  const { ctx } = inp;
  const p = ctx.policy;
  const offering = ctx.offerings.find((o) => o.id === inp.offeringId);
  if (!offering) throw new BookingError('service_inconnu', 'Prestation introuvable', 404);
  const resolved = resolveOffering(ctx, offering, (inp.addonIds ?? []).filter(Boolean));
  const service = resolved.service;
  const start = Number(inp.start);

  if (!Number.isFinite(start)) throw new BookingError('slot_invalide', 'Créneau invalide', 400);
  if (minutesOfDay(start) % p.slotStepMin !== 0) throw new BookingError('slot_non_aligne', 'Ce créneau n’est pas proposé à cette minute.', 400);
  if (start < Date.now() + p.leadTimeMin * MIN) throw new BookingError('slot_trop_proche', `Il faut au moins ${p.leadTimeMin} minutes pour réserver en ligne.`, 409, { leadTimeMin: p.leadTimeMin });
  const day = dateKey(start);
  if (day > dayAdd(todayDay(), p.horizonDays)) throw new BookingError('hors_horizon', `Les réservations ouvrent jusqu'à ${p.horizonDays} jours.`, 400);

  const phone = normalizePhone(inp.customer.phone);
  if (!/^\d{9,15}$/.test(phone)) throw new BookingError('telephone_invalide', 'Numéro de téléphone invalide.', 422);
  const email = inp.customer.email ? normalizeEmail(inp.customer.email) : null;
  if (email && !/^[^@\s]+@[^@\s.]+\.[a-z]{2,}$/i.test(email)) throw new BookingError('email_invalide', 'Adresse email invalide.', 422);
  const firstName = cleanText(inp.customer.firstName, 60);
  if (firstName.length < 2) throw new BookingError('nom_requis', 'On a besoin de ton prénom.', 422);

  // ── pré-vérification ( UX rapide + message d'erreur utile ) ──
  const preDay = await computeDay(ctx, {
    serviceId: service.id,
    durationMin: resolved.durationMin,
    prepMin: resolved.prepMin,
    cleanupMin: resolved.cleanupMin,
    day,
    now: Date.now() - (p.leadTimeMin + 2) * MIN,
    staffIds: inp.staffId != null ? [inp.staffId] : resolved.staffIds,
    window: null,
    respectStep: false,
    presentStepMin: presentStepFor(resolved.durationMin),
  });
  const preSlot = preDay.slots.find((s) => s.start === start) ?? (slotOfferable(preDay, start, start + resolved.durationMin * MIN) ? { start } : null);
  if (!inp.force && !preSlot) {
    throw new BookingError('creneau_pris', 'Ce créneau vient de partir. Voici ce qui reste de vraiment libre.', 409, {
      alternatives: await suggestAlternativesFor(ctx, { id: service.id }, resolved.durationMin, start, inp.staffId ?? null),
    });
  }

  const { customer, isNew } = await upsertCustomer(ctx, {
    phone: inp.customer.phone,
    email: inp.customer.email ?? null,
    firstName: inp.customer.firstName,
    lastName: inp.customer.lastName ?? null,
    note: inp.customer.note ?? null,
    birthDay: inp.customer.birthDay ?? null,
    attribution: inp.attribution ?? null,
    consentMarketing: inp.consentMarketing,
    referrerCode: inp.referrerCode ?? null,
  });

  // ── transaction : autoritaire ──
  const out = await slotSafe(ctx, transaction(async (t) => {
    const end = start + resolved.durationMin * MIN;
    let chosenStaff: number | null = null;
    const candidates = inp.staffId != null ? [inp.staffId] : resolved.staffIds;
    for (const sid of candidates) {
      const clash = await t.one<any>(
        `SELECT a.id FROM appointments a JOIN services s ON s.id = a.service_id
         WHERE a.staff_id = :s AND ${occupying('a')}
           AND :st < a.end_ts + s.cleanup_min * :min AND :en > a.start_ts - s.prep_min * :min LIMIT 1`,
        { s: sid, st: start, en: end, min: MIN, nowOcc: Date.now(), ...occupyingValues() },
      );
      if (!clash) {
        chosenStaff = sid;
        break;
      }
    }
    if (!chosenStaff) throw new BookingError('creneau_pris', 'Ce créneau vient d’être réservé entre-temps.', 409, { alternatives: await suggestAlternativesFor(ctx, { id: service.id }, resolved.durationMin, start, inp.staffId ?? null) });

    // horaires : le créneau doit rester dans la plage d'ouverture (défense contre un changement de config entre-temps)
    const okDay = await computeDay(ctx, { serviceId: service.id, durationMin: resolved.durationMin, prepMin: resolved.prepMin, cleanupMin: resolved.cleanupMin, day, now: start - 60 * MIN, staffIds: [chosenStaff], window: null, respectStep: false, presentStepMin: presentStepFor(resolved.durationMin) });
    if (!inp.force && !okDay.slots.some((s) => s.start === start) && !okDay.gaps.some((g) => start >= g.start && end <= g.end)) {
      throw new BookingError('creneau_pris', 'Ce créneau n’est plus disponible.', 409);
    }

    if (!inp.force) {
      const active = await t.num(`SELECT COUNT(*) FROM appointments WHERE customer_id = :c AND status IN ('booked','confirmed','pending_payment','waiting_client') AND start_ts > :n`, { c: customer.id, n: Date.now() });
      if (active >= p.maxActivePerCustomer) throw new BookingError('trop_de_rdv', `Tu as déjà ${active} rendez-vous en attente. Annule-en un pour en reprendre un autre.`, 429);
      if (p.blockSameDaySameService) {
        const dup = await t.one(`SELECT id FROM appointments WHERE customer_id = :c AND service_id = :sv AND status IN ('booked','confirmed','pending_payment') AND start_ts >= :ds AND start_ts < :de`, { c: customer.id, sv: service.id, ds: startOfDayMs(day), de: endOfDayMs(day) });
        if (dup) throw new BookingError('doublon', 'Tu as déjà cette prestation de réservée ce jour-là.', 409);
      }
      // anti-abus waitlist : ne pas squatter un créneau tenu pour quelqu'un d'autre
      const held = await t.one<any>(`SELECT waitlist_offer_id FROM appointments WHERE staff_id = :s AND start_ts = :st AND status = 'held'`, { s: chosenStaff, st: start });
      if (held?.waitlist_offer_id) {
        const offer = await t.one<any>(`SELECT * FROM waitlist_offers WHERE id = :i`, { i: held.waitlist_offer_id });
        const mine = await t.one(`SELECT id FROM waitlist WHERE id = :i AND (customer_id = :c OR phone_norm = :pn)`, { i: offer?.waitlist_id ?? -1, c: customer.id, pn: phone });
        if (!mine) throw new BookingError('creneau_reserve', 'Ce créneau est temporairement réservé pour un client en attente. Choisis-en un autre ou rejoins la waitlist.', 409, { waitlistOk: true });
      }
    }

    // ── prix, carte cadeau, récompense fidélité ──
    let price = resolved.priceCents;
    let giftCardId: number | null = null;
    let giftUsed = 0;
    if (inp.giftCardCode) {
      const gc = await t.one<any>(`SELECT * FROM gift_cards WHERE location_id = :l AND upper(code) = :c`, { l: ctx.locId, c: inp.giftCardCode.toUpperCase().trim() });
      if (!gc || gc.status !== 'active' || gc.balance_cents <= 0 || (gc.expiry_ts && gc.expiry_ts <= Date.now())) throw new BookingError('carte_invalide', 'Carte cadeau invalide ou déjà utilisée.', 422);
      giftUsed = Math.min(gc.balance_cents, price);
      price -= giftUsed;
      giftCardId = gc.id;
      await t.update('gift_cards', gc.id, { balance_cents: gc.balance_cents - giftUsed, status: gc.balance_cents - giftUsed <= 0 ? 'redeemed' : 'active', redeemed_ts: gc.redeemed_ts ?? Date.now(), redeemer_id: gc.redeemer_id ?? customer.id });
    }
    let discount = 0;
    if (inp.rewardCode) {
      const r = await applyRedemptionAtBooking(ctx, customer.id, inp.rewardCode);
      if (r?.discountCents) discount = Math.min(r.discountCents, price);
      if (r?.redemptionId) await t.update('loyalty_redemptions', r.redemptionId, { status: 'redeemed', redeemed_ts: Date.now(), appointment_id: null });
    }
    price = Math.max(0, price - discount);
    const deposit = inp.paymentMode === 'none' ? 0 : depositFor(ctx, { priceCents: price, service, customer, durationMin: resolved.durationMin });
    const initialStatus = inp.initialStatus ?? (deposit > 0 ? 'pending_payment' : 'booked');

    const apptId = await t.insert('appointments', {
      location_id: ctx.locId,
      customer_id: customer.id,
      offering_id: offering.id,
      service_id: service.id,
      staff_id: chosenStaff,
      start_ts: start,
      end_ts: end,
      prep_end_ts: start - resolved.prepMin * MIN,
      status: initialStatus,
      price_cents: price + giftUsed, // carte = moyen de règlement, pas une remise
      deposit_cents: deposit,
      deposit_status: deposit > 0 ? 'none' : 'none',
      paid_cents: giftUsed,
      add_on_cents: resolved.addons.reduce((acc: number, a: any) => acc + a.price_cents, 0),
      duration_min: resolved.durationMin,
      confirm_required: inp.requireConfirm ?? needsConfirm(ctx, start) ? 1 : 0,
      is_walkin: inp.isWalkin ? 1 : 0,
      gift_card_id: giftCardId,
      source: inp.attribution?.source ?? inp.source ?? 'direct',
      medium: inp.attribution?.medium ?? null,
      campaign: inp.attribution?.campaign ?? null,
      landing: inp.attribution?.landing ?? null,
      device: inp.attribution?.device ?? null,
      referrer: inp.attribution?.referrer ?? null,
      client_ip: inp.attribution?.gclid ? String(inp.attribution.gclid).slice(0, 40) : null,
      reminder_offsets: sj(inp.initialStatus === 'held' ? [] : p.reminderOffsets),
      created_ts: Date.now(),
      updated_ts: Date.now(),
    });
    for (const a of resolved.addons) await t.insert('appointment_addons', { appointment_id: apptId, addon_id: a.id, price_cents: a.price_cents, duration_min: a.duration_min });
    await t.insert('appointment_events', {
      appointment_id: apptId,
      kind: 'created',
      data_json: sj({ source: inp.source ?? inp.attribution?.source ?? 'direct', addons: resolved.addons.map((a: any) => a.key), deposit, gift: giftUsed, discount, via: inp.actor?.type ?? 'client', waitlistId: inp.waitlistId ?? null }),
      actor_type: inp.actor?.type ?? 'customer',
      actor_id: inp.actor?.id ?? null,
      ts: Date.now(),
    });
    await t.update('customers', customer.id, { next_visit_ts: start, preferred_service_id: service.id, preferred_staff_id: inp.staffId ?? customer.preferred_staff_id ?? chosenStaff, updated_ts: Date.now() });
    return { apptId, price, deposit, chosenStaff, end, giftUsed, discount };
  }, ctx.locId), { serviceId: service.id, durationMin: resolved.durationMin, start, staffId: inp.staffId ?? null });

  bumpAvailabilityCache();
  await audit(ctx.locId, inp.actor?.type ?? 'customer', inp.actor?.id, 'booking.create', 'appointment', out.apptId, { start, service: service.key, price: out.price, deposit: out.deposit }, inp.attribution?.gclid as any);

  // ── paiement de l'acompte : échec => libération immédiate et complète ──
  let payment: CreatedBooking['payment'] = { status: 'not_required', provider: 'none', clientSecret: null, url: null };
  if (out.deposit > 0) {
    const pay = await ensurePayment(ctx, { appointmentId: out.apptId, customerId: customer.id, amountCents: out.deposit, kind: 'deposit', mode: inp.paymentMode ?? 'deposit' });
    payment = { status: pay.status, provider: pay.provider, clientSecret: pay.clientSecret, url: pay.url };
    if (pay.status !== 'succeeded') {
      await releaseBooking(ctx, out.apptId, 'paiement_non_confirme');
      if (pay.pending) return { ...(await buildResponse(ctx, out.apptId, customer.id, isNew, resolved, out, payment, inp)) };
      throw new BookingError('paiement_echoue', 'Le paiement n’a pas abouti — le créneau a été libéré automatiquement. Réessaie ou choisis un autre horaire.', 402, {
        alternatives: await suggestAlternativesFor(ctx, { id: service.id }, resolved.durationMin, start),
      });
    }
    const q = db();
    await q.update('appointments', out.apptId, { deposit_status: 'paid', status: 'booked', paid_cents: out.deposit + out.giftUsed });
    await q.insert('appointment_events', { appointment_id: out.apptId, kind: 'deposit_paid', data_json: sj({ amount: out.deposit, provider: pay.provider }), actor_type: 'system', ts: Date.now() });
  }

  // ── confirmation, rappels, bienvenue, relances : le salon n'a plus rien à faire ──
  const q = db();
  const appt = await q.one<any>(`SELECT * FROM appointments WHERE id = :i`, { i: out.apptId });
  if (appt) {
    if (appt.status === 'booked' || appt.status === 'confirmed') {
      await scheduleAppointmentNotifications(ctx, appt, { customer, isNew });
      await fireAutomation(ctx, 'booking_created', { appointmentId: out.apptId, customerId: customer.id });
      const { dispatchNow } = await import('./notify.ts');
      await dispatchNow(ctx, 30);
    } else {
      await q.update('appointments', out.apptId, { needs_action: 1 });
    }
  }
  await refreshSegment(customer.id).catch(() => undefined);
  return buildResponse(ctx, out.apptId, customer.id, isNew, resolved, out, payment, inp);
}

async function buildResponse(ctx: Ctx, apptId: number, customerId: number, isNew: boolean, resolved: any, out: any, payment: any, inp: CreateInput): Promise<CreatedBooking> {
  const q = db();
  const appt = await q.one<any>(`SELECT * FROM appointments WHERE id = :i`, { i: apptId });
  const rows = await q.all<any>(`SELECT addon_id FROM appointment_addons WHERE appointment_id = :i`, { i: apptId });
  void rows;
  const loyalty = await computeLoyalty(ctx, customerId);
  const manageToken = signToken({ a: apptId, c: customerId, k: 'manage' }, 120 * DAY);
  return {
    id: apptId,
    status: appt.status,
    start: appt.start_ts,
    end: appt.end_ts,
    staffId: appt.staff_id,
    staffName: ctx.staff.find((s) => s.id === appt.staff_id)?.name ?? 'Équipe',
    serviceName: resolved.service.name,
    priceCents: appt.price_cents,
    depositCents: appt.deposit_cents,
    balanceCents: Math.max(0, appt.price_cents - appt.paid_cents),
    payment,
    manageToken,
    customerId,
    isNewCustomer: isNew,
    needsConfirm: !!appt.confirm_required,
    loyalty,
    durationMin: appt.duration_min,
    addOns: resolved.addons.map((a: any) => ({ key: a.key, name: a.name, priceCents: a.price_cents })),
    icsUrl: appLink(`/api/public/actions/ics?token=${manageToken}`),
    manageUrl: appLink(`/rdv/${apptId}?token=${manageToken}`),
    waitlist: appt.status !== 'booked' ? true : undefined,
    depositPolicy: depositPlan(ctx, { priceCents: resolved.priceCents, service: resolved.service, customer: { noshow_count: 0 }, durationMin: resolved.durationMin }),
  } as CreatedBooking;
}

/** suppression d'un hold / échec paiement : on nettoie sans laisser de trace bloquante */
export async function releaseBooking(ctx: Ctx, appointmentId: number, reason: string) {
  const q = db();
  await q.update('appointments', appointmentId, { status: 'cancelled', cancelled_ts: Date.now(), cancel_reason: reason, updated_ts: Date.now() });
  await q.insert('appointment_events', { appointment_id: appointmentId, kind: 'released', data_json: sj({ reason }), actor_type: 'system', ts: Date.now() });
  const gc = await q.one<any>(`SELECT gift_card_id, paid_cents FROM appointments WHERE id = :i`, { i: appointmentId });
  if (gc?.gift_card_id && gc.paid_cents > 0) {
    const card = await q.one<any>(`SELECT * FROM gift_cards WHERE id = :i`, { i: gc.gift_card_id });
    if (card) await q.update('gift_cards', card.id, { balance_cents: card.balance_cents + gc.paid_cents, status: 'active' });
  }
  await q.exec(`UPDATE waitlist_offers SET status = 'expired', reason = :r WHERE appointment_id = :i AND status = 'pending'`, { r: sj({ why: reason }), i: appointmentId });
  bumpAvailabilityCache();
  return true;
}

function needsConfirm(ctx: Ctx, start: number) {
  if (!ctx.policy.confirmRequired) return false;
  const ahead = (start - Date.now()) / DAY;
  return ahead > 0.9 && ahead < 9;
}

export async function suggestAlternativesFor(ctx: Ctx, service: { id: number }, durationMin: number, around: number, staffId: number | null = null) {
  const svc = ctx.services.find((s) => s.id === service.id) ?? ctx.services[0];
  const alts = await smartAlternatives(ctx, { serviceId: svc.id, durationMin, prepMin: svc.prep_min, cleanupMin: svc.cleanup_min, requestedDay: dateKey(around), requestedStaffId: staffId, limit: 4 });
  // même forme que GET /public/availability → alternatives : ts/time/day/weekday/staffName.
  // Sans cette normalisation, l'écran « créneau devenu indisponible » affichait des heures vides.
  return alts.map((a) => {
    const staff = ctx.staff.find((x) => x.id === a.staffId);
    return {
      start: a.slot.start,
      end: a.slot.end,
      ts: a.slot.start,
      time: fmtTime(a.slot.start),
      day: dateKey(a.slot.start),
      weekday: weekdayLabel(a.slot.start),
      label: a.label,
      kind: a.kind,
      staffId: a.staffId,
      staffName: staff?.name ?? null,
    };
  });
}

/** report / annulation / changement de prestation depuis l'espace client (1 clic) */
export interface ManageHandle {
  ctx: Ctx;
  appointmentId: number;
  customerId?: number | null;
  actor?: { type: 'customer' | 'staff' | 'owner' | 'system'; id?: number | null };
}

export async function rescheduleBooking(m: ManageHandle, newStart: number, opts: { offeringId?: number; addonIds?: number[]; staffId?: number | null; reason?: string } = {}) {
  const { ctx } = m;
  const q = db();
  const appt = await q.one<any>(`SELECT * FROM appointments WHERE id = :i AND location_id = :l`, { i: m.appointmentId, l: ctx.locId });
  if (!appt) throw new BookingError('introuvable', 'Rendez-vous introuvable.', 404);
  if (m.customerId && m.customerId !== appt.customer_id) throw new BookingError('id_or', 'Lien invalide.', 403);
  if (!['booked', 'confirmed', 'pending_payment', 'held'].includes(appt.status)) throw new BookingError('statut', 'Ce rendez-vous n’est plus modifiable en ligne — appelle-nous.', 409);
  if (appt.start_ts - Date.now() < 10 * MIN) throw new BookingError('trop_tard', 'Trop proche pour être déplacé en ligne : appelle-nous au ' + (ctx.phone ?? ''), 409);

  const offering = ctx.offerings.find((o) => o.id === (opts.offeringId ?? appt.offering_id))!;
  const currentAddons = (await q.all<any>(`SELECT addon_id FROM appointment_addons WHERE appointment_id = :i`, { i: appt.id })).map((r: any) => r.addon_id);
  const resolved = resolveOffering(ctx, offering, opts.addonIds ?? currentAddons);
  const day = await computeDay(ctx, { serviceId: offering.service_id, durationMin: resolved.durationMin, prepMin: resolved.prepMin, cleanupMin: resolved.cleanupMin, excludeAppointmentId: appt.id, day: dateKey(newStart), now: Date.now() - 2 * MIN, staffIds: opts.staffId != null ? [opts.staffId] : [appt.staff_id], window: null, respectStep: false, presentStepMin: presentStepFor(resolved.durationMin) });
  if (!slotOfferable(day, newStart, newStart + resolved.durationMin * MIN)) {
    throw new BookingError('creneau_pris', 'Ce créneau n’est pas libre.', 409, { alternatives: await suggestAlternativesFor(ctx, { id: offering.service_id }, resolved.durationMin, newStart, opts.staffId ?? appt.staff_id) });
  }

  const out = await slotSafe(ctx, transaction(async (t) => {
    const staffId = opts.staffId ?? appt.staff_id;
    const clash = await t.one(
      `SELECT a.id FROM appointments a JOIN services s ON s.id = a.service_id
       WHERE a.staff_id = :s AND a.id != :self AND ${occupying('a')}
         AND :st < a.end_ts + s.cleanup_min * :min AND :en > a.start_ts - s.prep_min * :min LIMIT 1`,
      { s: staffId, self: appt.id, st: newStart, en: newStart + resolved.durationMin * MIN, min: MIN, nowOcc: Date.now(), ...occupyingValues() },
    );
    if (clash) throw new BookingError('creneau_pris', 'Créneau pris entre-temps.', 409);
    await t.update('appointments', appt.id, {
      start_ts: newStart,
      end_ts: newStart + resolved.durationMin * MIN,
      offering_id: offering.id,
      service_id: offering.service_id,
      staff_id: staffId,
      price_cents: resolved.priceCents,
      duration_min: resolved.durationMin,
      confirm_required: needsConfirm(ctx, newStart) ? 1 : 0,
      rescheduled_from: appt.start_ts,
      rescheduled_count: appt.rescheduled_count + 1,
      reminder_cursor: 0,
      updated_ts: Date.now(),
    });
    await t.exec(`DELETE FROM appointment_addons WHERE appointment_id = :i`, { i: appt.id });
    for (const a of resolved.addons) await t.insert('appointment_addons', { appointment_id: appt.id, addon_id: a.id, price_cents: a.price_cents, duration_min: a.duration_min });
    await t.insert('appointment_events', { appointment_id: appt.id, kind: 'rescheduled', data_json: sj({ from: appt.start_ts, to: newStart, reason: opts.reason ?? 'client' }), actor_type: m.actor?.type ?? 'customer', actor_id: m.actor?.id ?? null, ts: Date.now() });
    // l'ancien créneau repart immédiatement en waitlist
    return { staffId, old: appt };
  }, ctx.locId), { serviceId: offering.service_id, durationMin: resolved.durationMin, start: newStart, staffId: appt.staff_id });

  bumpAvailabilityCache();
  await replayWaitlist(ctx, { staffId: appt.staff_id, start: appt.start_ts, end: appt.end_ts, serviceId: appt.service_id, offeringId: appt.offering_id, reason: 'reschedule' });
  await q.exec(`UPDATE notifications SET status = 'cancelled' WHERE appointment_id = :i AND status = 'queued' AND kind LIKE 'reminder%'`, { i: appt.id });
  const fresh = await q.one<any>(`SELECT * FROM appointments WHERE id = :i`, { i: appt.id });
  await scheduleAppointmentNotifications(ctx, fresh, { customer: await q.one<any>(`SELECT * FROM customers WHERE id = :i`, { i: appt.customer_id }) });
  await notify(ctx, 'rescheduled', { appointmentId: appt.id, customerId: appt.customer_id });
  await fireAutomation(ctx, 'slot_freed', { slot: { staffId: appt.staff_id, start: appt.start_ts, end: appt.end_ts, serviceId: appt.service_id, offeringId: appt.offering_id }, appointmentId: appt.id, reason: 'reschedule' });
  await audit(ctx.locId, m.actor?.type ?? 'customer', m.actor?.id, 'booking.reschedule', 'appointment', appt.id, { from: appt.start_ts, to: newStart });
  return { ok: true, start: newStart, label: `${fmtDate(newStart, { short: true })} à ${fmtTime(newStart)}` };
}

export async function cancelBooking(ctx: Ctx, appointmentId: number, opts: { reason?: string; by?: 'client' | 'staff' | 'system' | 'owner'; customerId?: number | null; releaseToWaitlist?: boolean; notifyCustomer?: boolean; refund?: boolean } = {}) {
  const q = db();
  const appt = await q.one<any>(`SELECT * FROM appointments WHERE id = :i AND location_id = :l`, { i: appointmentId, l: ctx.locId });
  if (!appt) throw new BookingError('introuvable', 'Rendez-vous introuvable.', 404);
  if (opts.customerId && opts.customerId !== appt.customer_id) throw new BookingError('id_or', 'Lien invalide.', 403);
  if (['cancelled', 'completed', 'no_show'].includes(appt.status)) return { ok: true, already: true, status: appt.status };

  const leadMin = Math.floor((appt.start_ts - Date.now()) / MIN);
  const refundable = appt.deposit_cents > 0 && leadMin >= ctx.policy.cancelCutoffMin;
  await transaction(async (t) => {
    await t.update('appointments', appt.id, { status: 'cancelled', cancelled_ts: Date.now(), cancel_reason: opts.reason ?? 'client', cancel_by: opts.by ?? 'client', updated_ts: Date.now(), needs_action: 0, confirm_required: 0 });
    await t.insert('appointment_events', { appointment_id: appt.id, kind: 'cancelled', data_json: sj({ reason: opts.reason ?? 'client', leadMin, refundable, by: opts.by ?? 'client' }), actor_type: opts.by === 'staff' || opts.by === 'owner' ? 'staff' : 'customer', ts: Date.now() });
    if (opts.by !== 'staff' && opts.by !== 'owner') {
      const c = await t.one<any>(`SELECT cancelled_count, tags FROM customers WHERE id = :i`, { i: appt.customer_id });
      await t.update('customers', appt.customer_id, { cancelled_count: (c?.cancelled_count ?? 0) + 1, next_visit_ts: null, updated_ts: Date.now() });
      if ((c?.cancelled_count ?? 0) + 1 >= 3) await flagRisk(ctx.locId, appt.customer_id, 'annulations_repeatees', 'low', { count: c.cancelled_count + 1 });
    } else {
      await t.update('customers', appt.customer_id, { next_visit_ts: null, updated_ts: Date.now() });
    }
    if (appt.gift_card_id) {
      const card = await t.one<any>(`SELECT * FROM gift_cards WHERE id = :i`, { i: appt.gift_card_id });
      const created = await t.one<any>("SELECT data_json FROM appointment_events WHERE appointment_id = :i AND kind = 'created' ORDER BY id LIMIT 1", { i: appt.id });
      const paidBack = Number(j<any>(created?.data_json, {}).gift ?? Math.max(0, appt.paid_cents - appt.deposit_cents));
      if (card && paidBack > 0) await t.update('gift_cards', card.id, { balance_cents: card.balance_cents + paidBack, status: 'active', redeemed_ts: null });
    }
    await t.exec(`UPDATE notifications SET status = 'cancelled' WHERE appointment_id = :i AND status = 'queued'`, { i: appt.id });
  }, ctx.locId);

  bumpAvailabilityCache();
  let refunded = 0;
  if (opts.refund !== false && refundable) {
    const pay = await q.one<any>(`SELECT * FROM payments WHERE appointment_id = :i AND kind = 'deposit' AND status = 'succeeded' ORDER BY id DESC LIMIT 1`, { i: appt.id });
    if (pay) refunded = await refundPayment(ctx, pay, 'annulation_hors_delai');
  }
  if (opts.notifyCustomer !== false) {
    await notify(ctx, 'cancelled', {
      appointmentId: appt.id,
      customerId: appt.customer_id,
      vars: { deposit_msg: refunded ? `Acompte de ${(refunded / 100).toFixed(2)} € remboursé sous 3 à 5 jours.` : appt.deposit_cents > 0 ? `Acompte conservé (annulation à moins de ${Math.round(ctx.policy.cancelCutoffMin / 60)} h).` : '' },
    });
  }
  let recovered = { offers: 0, claimUrls: [] as string[] };
  if (opts.releaseToWaitlist !== false) {
    recovered = await replayWaitlist(ctx, { staffId: appt.staff_id, start: appt.start_ts, end: appt.end_ts, serviceId: appt.service_id, offeringId: appt.offering_id, reason: 'cancel' });
  }
  await refreshSegment(appt.customer_id);
  await audit(ctx.locId, opts.by === 'staff' || opts.by === 'owner' ? 'staff' : 'customer', null, 'booking.cancel', 'appointment', appt.id, { leadMin, refundable, waitlistOffers: recovered.offers });
  return { ok: true, refundable, refundedCents: refunded, waitlistOffers: recovered.offers, ...(opts.by === 'owner' || opts.by === 'staff' ? { claimUrls: recovered.claimUrls } : {}), freed: { start: appt.start_ts, staffId: appt.staff_id }, leadMin };
}

export async function markNoShow(ctx: Ctx, appointmentId: number, by = 'system') {
  const q = db();
  const appt = await q.one<any>(`SELECT * FROM appointments WHERE id = :i AND location_id = :l`, { i: appointmentId, l: ctx.locId });
  if (!appt) return null;
  if (!['booked', 'confirmed', 'pending_payment', 'waiting_client'].includes(appt.status)) return { skipped: appt.status };
  await q.update('appointments', appt.id, { status: 'no_show', noshow_ts: Date.now(), updated_ts: Date.now(), needs_action: 0 });
  await q.insert('appointment_events', { appointment_id: appt.id, kind: 'no_show', data_json: sj({ by }), actor_type: by === 'system' ? 'system' : 'staff', ts: Date.now() });
  const cust = await q.one<any>(`SELECT * FROM customers WHERE id = :i`, { i: appt.customer_id });
  const n = (cust?.noshow_count ?? 0) + 1;
  const tags = new Set([...j<string[]>(cust?.tags, []), ...(n >= ctx.policy.noShowDepositEscalation ? (['acompte_obligatoire'] as string[]) : [])]);
  await q.update('customers', appt.customer_id, { noshow_count: n, tags: sj([...tags]), next_visit_ts: null, updated_ts: Date.now() });
  if (n >= ctx.policy.noShowDepositEscalation) await flagRisk(ctx.locId, appt.customer_id, 'noshow_repeat', 'medium', { count: n, effect: 'acompte obligatoire à la prochaine réservation' });
  await notify(ctx, 'noshow_notice', { appointmentId: appt.id, customerId: appt.customer_id });
  await fireAutomation(ctx, 'customer_noshow', { customerId: appt.customer_id, appointmentId: appt.id });
  await replayWaitlist(ctx, { staffId: appt.staff_id, start: appt.start_ts, end: appt.end_ts, serviceId: appt.service_id, offeringId: appt.offering_id, reason: 'no_show' });
  await refreshSegment(appt.customer_id);
  bumpAvailabilityCache();
  return { ok: true, noshowCount: n };
}

export async function completeBooking(ctx: Ctx, appointmentId: number, opts: { paidCents?: number; note?: string; actorId?: number | null } = {}) {
  const q = db();
  const appt = await q.one<any>(`SELECT * FROM appointments WHERE id = :i AND location_id = :l`, { i: appointmentId, l: ctx.locId });
  if (!appt) throw new BookingError('introuvable', 'Introuvable.', 404);
  if (appt.status === 'completed') return { already: true };
  const onSite = opts.paidCents ?? Math.max(0, appt.price_cents - appt.paid_cents);
  const revenue = appt.price_cents;
  await transaction(async (t) => {
    await t.update('appointments', appt.id, { status: 'completed', completed_ts: Date.now(), paid_cents: appt.paid_cents + onSite, updated_ts: Date.now(), needs_action: 0 });
    await t.insert('appointment_events', { appointment_id: appt.id, kind: 'completed', data_json: sj({ revenue, onSite, note: opts.note ?? null }), actor_type: 'staff', actor_id: opts.actorId ?? null, ts: Date.now() });
    const c = await t.one<any>(`SELECT visits_count, spent_cents FROM customers WHERE id = :i`, { i: appt.customer_id });
    await t.update('customers', appt.customer_id, { visits_count: (c?.visits_count ?? 0) + 1, spent_cents: (c?.spent_cents ?? 0) + revenue, last_visit_ts: appt.start_ts, next_visit_ts: null, updated_ts: Date.now() });
    if (appt.waitlist_offer_id) await t.update('waitlist_offers', appt.waitlist_offer_id, { status: appt.status === 'booked' ? 'claimed' : appt.waitlist_offer_id });
  }, ctx.locId);
  await addLoyaltyVisit(ctx, appt);
  await settleReferralOnFirstVisit(ctx, appt.customer_id);
  await maybeGiftBirthday(ctx, appt.customer_id);
  await refreshSegment(appt.customer_id);
  await fireAutomation(ctx, 'appointment_completed', { appointmentId: appt.id, customerId: appt.customer_id });
  await audit(ctx.locId, 'staff', opts.actorId ?? null, 'booking.complete', 'appointment', appt.id, { revenue });
  return { ok: true, revenue, status: 'completed' };
}

export async function confirmBooking(ctx: Ctx, appointmentId: number, customerId?: number | null) {
  const q = db();
  const appt = await q.one<any>(`SELECT * FROM appointments WHERE id = :i AND location_id = :l`, { i: appointmentId, l: ctx.locId });
  if (!appt) throw new BookingError('introuvable', 'Introuvable.', 404);
  if (customerId && appt.customer_id !== customerId) throw new BookingError('id_or', 'Lien invalide.', 403);
  if (['cancelled', 'no_show', 'completed'].includes(appt.status)) return { ok: false, reason: appt.status, message: 'Ce rendez-vous est ' + appt.status };
  if (appt.confirmed_ts) return { ok: true, already: true };
  await q.update('appointments', appt.id, { confirmed_ts: Date.now(), status: 'confirmed', confirm_required: 0, needs_action: 0, updated_ts: Date.now() });
  await q.insert('appointment_events', { appointment_id: appt.id, kind: 'confirmed', data_json: sj({ via: 'lien_rappel' }), actor_type: 'customer', ts: Date.now() });
  await q.exec(`UPDATE notifications SET status = 'cancelled' WHERE appointment_id = :i AND status = 'queued' AND kind = 'confirm_needed'`, { i: appt.id });
  await audit(ctx.locId, 'customer', customerId, 'booking.confirm', 'appointment', appt.id, {});
  return { ok: true };
}

/** changement de prestation sur un RDV existant (mêmes garanties de conflit que la création) */
export async function changeServicesOnBooking(m: ManageHandle, offeringId: number, addonIds: number[] = []) {
  const { ctx } = m;
  const q = db();
  const appt = await q.one<any>(`SELECT * FROM appointments WHERE id = :i AND location_id = :l`, { i: m.appointmentId, l: ctx.locId });
  if (!appt) throw new BookingError('introuvable', 'Rendez-vous introuvable.', 404);
  if (m.customerId && appt.customer_id !== m.customerId) throw new BookingError('id_or', 'Lien invalide.', 403);
  const offering = ctx.offerings.find((o) => o.id === offeringId);
  if (!offering) throw new BookingError('service_inconnu', 'Prestation inconnue.', 404);
  const resolved = resolveOffering(ctx, offering, addonIds);
  const day = await computeDay(ctx, { serviceId: offering.service_id, durationMin: resolved.durationMin, prepMin: resolved.prepMin, cleanupMin: resolved.cleanupMin, excludeAppointmentId: appt.id, day: dateKey(appt.start_ts), now: appt.start_ts - 60_000, staffIds: [appt.staff_id], window: null, respectStep: false, presentStepMin: presentStepFor(resolved.durationMin) });
  const fits = slotOfferable(day, appt.start_ts, appt.start_ts + resolved.durationMin * MIN);
  if (!fits) {
    const next = day.slots.find((s) => s.start > appt.start_ts);
    throw new BookingError(
      'duree_incompatible',
      `« ${offering.name} » demande ${resolved.durationMin} min : ce créneau ne suffit pas.${next ? ` Le même jour, le prochain créneau possible est ${fmtTime(next.start)}.` : ''}`,
      409,
      { nextStart: next?.start ?? null, alternatives: next ? [] : await suggestAlternativesFor(ctx, { id: offering.service_id }, resolved.durationMin, appt.start_ts, appt.staff_id) },
    );
  }
  await transaction(async (t) => {
    const clash = await t.one(
      `SELECT a.id FROM appointments a JOIN services s ON s.id = a.service_id WHERE a.staff_id = :st AND a.id != :self AND ${occupying('a')} AND :so < a.end_ts + s.cleanup_min * :min AND :eo > a.start_ts - s.prep_min * :min LIMIT 1`,
      { st: appt.staff_id, self: appt.id, so: appt.start_ts, eo: appt.start_ts + resolved.durationMin * MIN, min: MIN, nowOcc: Date.now(), ...occupyingValues() },
    );
    if (clash) throw new BookingError('creneau_pris', 'Ce créneau ne permet plus cette prestation.', 409);
    await t.update('appointments', appt.id, {
      offering_id: offering.id,
      service_id: offering.service_id,
      price_cents: resolved.priceCents,
      duration_min: resolved.durationMin,
      end_ts: appt.start_ts + resolved.durationMin * MIN,
      add_on_cents: resolved.addons.reduce((a: number, x: any) => a + x.price_cents, 0),
      updated_ts: Date.now(),
    });
    await t.exec(`DELETE FROM appointment_addons WHERE appointment_id = :i`, { i: appt.id });
    for (const a of resolved.addons) await t.insert('appointment_addons', { appointment_id: appt.id, addon_id: a.id, price_cents: a.price_cents, duration_min: a.duration_min });
    await t.insert('appointment_events', { appointment_id: appt.id, kind: 'services_changed', data_json: sj({ offeringId, addonIds, price: resolved.priceCents }), actor_type: m.actor?.type ?? 'customer', ts: Date.now() });
  }, ctx.locId);
  bumpAvailabilityCache();
  await notify(ctx, 'rescheduled', { appointmentId: appt.id, customerId: appt.customer_id });
  await audit(ctx.locId, m.actor?.type ?? 'customer', m.actor?.id ?? null, 'booking.services', 'appointment', appt.id, { offeringId });
  return { ok: true, priceCents: resolved.priceCents, durationMin: resolved.durationMin, serviceName: resolved.service.name };
}

/** admin / staff : créer un RDV pour un client en 4 champs (walk-in, téléphone, fidèle) */
export async function adminQuickBook(ctx: Ctx, o: { customerId?: number | null; name?: string; phone?: string; offeringId: number; addonIds?: number[]; start: number; staffId?: number | null; note?: string; skipPayment?: boolean; isWalkin?: boolean }) {
  let phone = o.phone ? normalizePhone(o.phone) : '';
  let firstName = o.name?.split(' ')[0] ?? 'Client';
  if (o.customerId) {
    const c = await db().one<any>(`SELECT * FROM customers WHERE id = :i`, { i: o.customerId });
    if (!c) throw new BookingError('client_inconnu', 'Client introuvable', 404);
    phone = c.phone_norm ?? phone;
    firstName = c.first_name ?? firstName;
    if (!phone) throw new BookingError('telephone_manquant', 'Ce client n’a pas de téléphone : impossible de créer le RDV.', 422);
  }
  return createBooking({
    ctx,
    offeringId: o.offeringId,
    addonIds: o.addonIds ?? [],
    staffId: o.staffId ?? null,
    start: o.start,
    customer: { firstName, phone: o.phone ?? phone, note: o.note },
    paymentMode: o.skipPayment ? 'none' : 'deposit',
    isWalkin: o.isWalkin,
    requireConfirm: false,
    force: true,
    attribution: { source: o.isWalkin ? 'walkin' : 'admin', medium: 'interne' },
    actor: { type: 'owner' },
  });
}

export { dayAdd };
