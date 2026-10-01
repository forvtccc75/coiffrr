import { publicMapsUrl } from '../shared/salon.ts';
import { randomInt } from 'node:crypto';
import { Hono } from 'hono';
import { FUNNEL_KINDS } from '../shared/funnel.ts';
import type { Context } from 'hono';
import { z } from 'zod';
import { db, j, sj, transaction, ready } from './db/index.ts';
import { env } from './lib/env.ts';
import { DAY, MIN, dateKey, dayAdd, dayDiff, dow, fmtDate, fmtTime, humanDaysAgo, humanDur, humanWhen, hhmm, minutesOfDay, startOfDayMs, todayDay, weekdayLabel , endOfDayMs} from './lib/time.ts';
import { appLink, cents, channelFromUA, cleanText, deviceFromUA, normalizeEmail, normalizePhone, parseAttribution } from './lib/inputs.ts';
import { hashPassword, humanCode, promoCode, rnd, signToken, verifyToken } from './lib/secrets.ts';
import { checkPassword, clientIp, cookie, createSession, destroySession, needRole, parseCookie, rateLimit, readSession, ROLES, safeEqual, setPasswordForUser, SESSION_COOKIE, type Role, type SessionUser } from './lib/security.ts';
import { invalidateCtx, loadCtx, staffDayWindows, type Ctx } from './domain/context.ts';
import { availability, bumpAvailabilityCache, computeDay, dayList, gapReport, nextAvailable, presentStepFor, resolveOffering, smartAlternatives } from './domain/availability.ts';
import { adminQuickBook, cancelBooking, completeBooking, confirmBooking, createBooking, depositPlan, markNoShow, rescheduleBooking, changeServicesOnBooking, suggestAlternativesFor, BookingError, type Attribution } from './domain/booking.ts';
import { closeWaitlistEntry, joinWaitlist, resolveClaimToken, claimOffer, declineOffer, waitlistStats, expireStaleOffers, replayWaitlist, fulfillPromises } from './domain/waitlist.ts';
import { audit, customerCard, logConsent, refreshSegment, searchCustomers, segmentOf, SEGMENT_LABEL, upcomingFor } from './domain/customers.ts';
import { dispatchNow, notify, outboxStats, markEngaged, waNumber } from './domain/notify.ts';
import { listAutomations, requiresAction, resolvePendingAction, tick, updateAutomation } from './domain/automations.ts';
import { atRisk, bySource, capacityReport, customerValue, demandHeatmap, forecast, funnel, funnelRealtime, kpis, observability, recommendations, revenueByService, revenueByStaff, revenueSeries } from './domain/analytics.ts';
import { askAssistant, confirmAndRun, parseQuery } from './domain/assistant.ts';
import { assignVariant, approveCampaign, campaignStats, createCampaign, listCampaigns, listContentPages, listExperiments, previewSegment, SEGMENT_FIELDS, trackExperiment, upsertContentPage } from './domain/marketing.ts';
import { buyGiftCard, computeLoyalty, findGiftCard, memberStatus, publicReviews, redeemReward, referralSummary, referralLeaderboard, replyToReview, reviewStats, submitReview, loyaltyConfig } from './domain/loyalty.ts';
import { observe } from './lib/observe.ts';

/* ══════════════════════════════════════════════════════════════════
   API publique — tout ce dont un visiteur a besoin en <= 3 requêtes.
   La disponibilité n'existe QUE côté serveur : le front ne l'invente jamais.
   ══════════════════════════════════════════════════════════════════ */

export const publicApi = new Hono();

const attributionSchema = z.object({
  source: z.string().max(40).nullish(),
  medium: z.string().max(40).nullish(),
  campaign: z.string().max(80).nullish(),
  landing: z.string().max(160).nullish(),
  device: z.string().max(20).nullish(),
  referrer: z.string().max(160).nullish(),
  gclid: z.string().max(80).nullish(),
});

async function ctxFor(c: Context): Promise<Ctx> {
  const explicit = c.req.query('loc') || c.req.param('loc');
  if (explicit) return loadCtx(explicit);
  // Un salon = un domaine (ou un sous-domaine). En serverless, un seul déploiement sert plusieurs
  // tenants : on dérive le salon du Host, sinon tout le monde tombe sur le salon de démo.
  const host = (c.req.header('x-forwarded-host') || c.req.header('host') || '').split(':')[0];
  const label = host.split('.')[0];
  if (label && label !== 'www' && label !== 'localhost' && label !== '127' && /^[a-z0-9][a-z0-9-]{1,40}$/.test(label)) {
    try {
      return await loadCtx(label);
    } catch {
      /* sous-domaine inconnu : on retombe sur le salon par défaut, sans divulguer d'erreur 500 */
    }
  }
  return loadCtx(env.demoSlug);
}

function parseSlotDate(v: string | undefined | null) {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? v : null;
}

publicApi.get('/config', async (c) => {
  const ctx = await ctxFor(c);
  const q = db();
  const gallery = await q.all<any>(`SELECT id, path, alt, label, service_key, price_cents, duration_min, kind, aspect FROM media WHERE location_id = :l ORDER BY ts DESC LIMIT 24`, { l: ctx.locId });
  const rev = await reviewStats(ctx);
  const today = todayDay();
  const svc0 = ctx.services[0];
  // Un salon fraîchement créé n'a pas encore de prestation : ce n'est pas une panne du site,
  // c'est son état « en cours d'ouverture ». Sans ce garde, /config renvoyait un 500 et le site
  // entier (litote, réservation, SEO) tombait pour un tenant vide.
  const next = svc0
    ? await nextAvailable(ctx, { serviceId: svc0.id, durationMin: svc0.base_duration_min + svc0.cleanup_min, prepMin: svc0.prep_min, cleanupMin: svc0.cleanup_min, staffIds: ctx.staff.map((s) => s.id), fromDay: today, days: 14 })
    : null;
  const weekSlots = svc0
    ? await availability(ctx, { serviceId: svc0.id, durationMin: svc0.base_duration_min + svc0.cleanup_min, prepMin: svc0.prep_min, cleanupMin: svc0.cleanup_min, staffIds: ctx.staff.map((s) => s.id), days: await dayList(ctx, today, 7), presentStepMin: 30 })
    : { totalCount: 0, days: [] };
  const services = ctx.services.map((s) => {
    const off = ctx.offerings.find((o) => o.service_id === s.id)!;
    return {
      id: s.id,
      key: s.key,
      name: s.name,
      category: s.category,
      short: s.short_desc,
      description: s.description,
      offeringId: off?.id ?? null,
      priceCents: off?.price_cents ?? s.base_price_cents,
      durationMin: off?.duration_min ?? s.base_duration_min,
      priceFrom: s.base_price_cents,
      level: s.level,
      age: s.age,
      popular: !!off?.is_popular,
      problem: s.problem,
      solution: s.solution,
      faq: s.faq,
      staffIds: ctx.staff.filter((st) => (st.service_ids.length ? st.service_ids.includes(s.id) : true)).map((st) => st.id),
      addons: ctx.addons.filter((a: any) => a.suggest_after_service_key === s.key).map((a: any) => ({ id: a.id, key: a.key, name: a.name, priceCents: a.price_cents, durationMin: a.duration_min, hint: a.hint })),
    };
  });
  const out = {
    salon: {
      name: ctx.name,
      slug: ctx.slug,
      brand: ctx.brand,
      address: ctx.address,
      phone: ctx.loc.phone,
      email: ctx.loc.email,
      hours: ctx.hours,
      holidays: Object.entries(ctx.holidays).map(([day, name]) => ({ day, name })),
      currency: ctx.loc.currency ?? 'EUR',
      timezone: ctx.loc.timezone,
    },
    features: { ...ctx.features, deposits: env.payments !== 'off' && ctx.features.deposits },
    payments: { online: env.payments !== 'off', mode: env.payments === 'off' ? 'on_site' : env.payments },
    onboarding: !svc0 || ctx.staff.length === 0,
    policy: {
      slotStepMin: ctx.policy.slotStepMin,
      leadTimeMin: ctx.policy.leadTimeMin,
      horizonDays: ctx.policy.horizonDays,
      cancelCutoffMin: ctx.policy.cancelCutoffMin,
      confirmRequired: ctx.policy.confirmRequired,
      deposit: env.payments === 'off' ? { mode: 'none', amountCents: 0, percent: 0, aboveCents: 0 } : ctx.policy.deposit,
      depositText: svc0 ? depositPlan(ctx, { priceCents: 2500, service: svc0, durationMin: 30 }).policyText : '',
    },
    staff: ctx.staff.map((s) => ({ id: s.id, name: s.name, slug: s.slug, title: s.title, bio: s.bio, color: s.color_hex, avatar: s.avatar_url, serviceIds: s.service_ids.length ? s.service_ids : ctx.services.map((x) => x.id) })),
    services,
    categories: [...new Set(ctx.services.map((s) => s.category))],
    addons: ctx.addons.map((a: any) => ({ id: a.id, key: a.key, name: a.name, priceCents: a.price_cents, durationMin: a.duration_min, hint: a.hint, after: a.suggest_after_service_key })),
    gallery: gallery.map((g: any) => ({ ...g, priceCents: g.price_cents, price_cents: undefined })),
    reviews: { ...rev, list: await publicReviews(ctx, 8) },
    live: {
      nextSlot: next ? { start: next.start, label: humanWhen(next.start) } : null,
      slotsThisWeek: weekSlots.totalCount,
      waitlistActive: await q.num(`SELECT COUNT(*) FROM waitlist WHERE location_id = :l AND status='active'`, { l: ctx.locId }),
      serverTime: Date.now(),
    },
    links: {
      instagram: ctx.brand.instagram ?? null,
      tiktok: ctx.brand.tiktok ?? null,
      facebook: ctx.brand.facebook ?? null,
      googleMaps: publicMapsUrl(ctx.brand),
      review: ctx.brand.reviewUrl ?? null,
      tel: ctx.loc.phone ? `tel:${ctx.loc.phone.replace(/[^+0-9]/g, '')}` : null,
      whatsapp: ctx.brand.whatsapp ?? null,
      /* Lien prêt à cliquer, construit une seule fois : le numéro vient de la config du salon,
         jamais d'un littéral éparpillé dans les pages. */
      whatsappHref: (() => {
        if (!ctx.brand.whatsapp) return null;
        const digits = waNumber(String(ctx.brand.whatsapp));
        if (digits.length < 11) return null; // numéro incomplet : mieux vaut aucun bouton qu'un bouton qui ouvre une conversation orpheline
        const text = ctx.brand.whatsappGreeting ? `?text=${encodeURIComponent(String(ctx.brand.whatsappGreeting))}` : '';
        return `https://wa.me/${digits}${text}`;
      })(),
      book: '/book',
    },
    demo: env.demo,
  };
  return c.json(out, 200, { 'Cache-Control': 'public, max-age=15, stale-while-revalidate=120' });
});

/** La disponibilité : une seule route, utilisée par le site, l'admin et l'assistant. */
publicApi.get('/availability', async (c) => {
  const ctx = await ctxFor(c);
  const svcKey = c.req.query('service');
  const service = ctx.services.find((s) => s.key === svcKey || String(s.id) === svcKey) ?? ctx.services[0];
  if (!service) {
    // Salon en cours d'ouverture : aucune prestation publiée. On ne renvoie ni 500 ni un « complet »
    // mensonger — la demande du visiteur peut encore être captée par la waitlist (service null).
    return c.json(
      { service: null, days: [], best: null, next: null, summary: { total: 0 }, policy: { slotStepMin: ctx.policy.slotStepMin, leadTimeMin: ctx.policy.leadTimeMin, horizonDays: ctx.policy.horizonDays, cancelCutoffMin: ctx.policy.cancelCutoffMin, confirmRequired: ctx.policy.confirmRequired }, closed: true, onboarding: true, waitlistOpen: ctx.features.waitlist, alternatives: [], note: 'Le salon finalise son ouverture — laisse ton numéro, on te préviendra dès que l’agenda ouvre.' },
      200,
      { 'Cache-Control': 'public, max-age=15' },
    );
  }
  const offering = ctx.offerings.find((o) => o.service_id === service.id)!;
  const addonIds = (c.req.query('addons') || '').split(',').filter(Boolean).map(Number);
  const resolved = resolveOffering(ctx, offering, addonIds.filter((id) => ctx.addons.some((a: any) => a.id === id)));
  const staffSlug = c.req.query('staff');
  const staff = staffSlug ? ctx.staff.find((s) => s.slug === staffSlug || String(s.id) === staffSlug) : null;
  if (staffSlug && !staff) throw new BookingError('staff_inconnu', 'Barbier inconnu', 404);
  if (staff && !(staff.service_ids.length ? staff.service_ids.includes(service.id) : true)) throw new BookingError('staff_incompatible', 'Ce barbier ne propose pas cette prestation.', 400);
  const daysParam = c.req.query('days');
  const from = parseSlotDate(c.req.query('date')) ?? todayDay();
  const count = Math.min(30, Math.max(1, Number(daysParam || Math.min(ctx.policy.horizonDays, 14))));
  const days = await dayList(ctx, from, count);
  const win = (c.req.query('window') || '').split('-').map((v) => (v.includes(':') ? hhmmToMin(v) : Number(v)));
  const window: [number, number] | null = win.length === 2 && win[0] > 0 ? [win[0], win[1]] : null;
  const res = await availability(ctx, {
    serviceId: service.id,
    durationMin: resolved.durationMin,
    prepMin: resolved.prepMin,
    cleanupMin: resolved.cleanupMin,
    staffIds: staff ? [staff.id] : resolved.staffIds,
    days,
    window,
    presentStepMin: presentStepFor(resolved.durationMin),
  });
  const total = res.totalCount;
  const alternatives = await alternativesFor(ctx, { serviceId: service.id, durationMin: resolved.durationMin, prepMin: resolved.prepMin, cleanupMin: resolved.cleanupMin, days, total, day0: c.req.query('date') ?? (total === 0 ? days[0] : null) });
  const nextAny = total ? null : await nextAvailable(ctx, { serviceId: service.id, durationMin: resolved.durationMin, prepMin: resolved.prepMin, cleanupMin: resolved.cleanupMin, staffIds: resolved.staffIds, fromDay: dayAdd(days[days.length - 1], 1), days: Math.max(1, ctx.policy.horizonDays - days.length) });
  return c.json({
    service: { id: service.id, key: service.key, name: service.name, offeringId: offering.id, staffIds: resolved.staffIds, durationMin: resolved.durationMin, priceCents: resolved.priceCents, addons: resolved.addons.map((a: any) => ({ id: a.id, name: a.name, priceCents: a.price_cents, durationMin: a.duration_min })) },
    days: res.days.map((d) => ({
      day: d.day,
      label: fmtDate(startOfDayMs(d.day), { short: true }),
      weekday: weekdayLabel(dow(startOfDayMs(d.day))),
      isToday: d.day === todayDay(),
      count: d.slots.length,
      closed: d.slots.length ? null : (d.closedReason ?? 'complet'),
      freeMin: d.freeMin ?? null,
      waitlistOpen: ctx.features.waitlist && !d.slots.length,
      slots: d.slots.map((s) => ({ ts: s.start, time: fmtTime(s.start), staffIds: s.staffIds, tight: !!s.tight, score: s.score })),
    })),
    best: res.best ? { ts: res.best.start, time: fmtTime(res.best.start), day: dateKey(res.best.start), staffIds: res.best.staffIds } : null,
    next: nextAny ? { ts: nextAny.start, label: humanWhen(nextAny.start) } : res.nearest ? { ts: res.nearest.start, label: humanWhen(res.nearest.start) } : null,
    summary: {
      totalCount: total,
      thisWeek: total,
      message: total === 0 ? 'Aucun créneau dans ton horizon — mais la waitlist récupère les annulations automatiquement.' : total <= 3 ? `${total} créneau${total > 1 ? 'x' : ''} disponible${total > 1 ? 's' : ''} sur ${days.length} jours` : `${total} créneaux disponibles sur ${days.length} jours`,
      honest: true,
    },
    policy: { leadTimeMin: ctx.policy.leadTimeMin, horizonDays: ctx.policy.horizonDays, depositText: depositPlan(ctx, { priceCents: resolved.priceCents, service, durationMin: resolved.durationMin }).policyText, cancelCutoff: humanDur(ctx.policy.cancelCutoffMin * MIN) },
    waitlistOpen: ctx.features.waitlist && total < 4,
    alternatives,
  });
});

/** Jamais un « complet » sec : on propose toujours un autre horaire, un autre jour ou un autre barbier. */
async function alternativesFor(ctx: Ctx, args: { serviceId: number; durationMin: number; prepMin: number; cleanupMin: number; days: string[]; total: number; day0: string | null }) {
  if (args.total >= 4) return [];
  const requestedDay = args.day0 ?? todayDay();
  try {
    const alts = await smartAlternatives(ctx, {
      serviceId: args.serviceId,
      durationMin: args.durationMin,
      prepMin: args.prepMin,
      cleanupMin: args.cleanupMin,
      requestedDay,
      requestedStaffId: null,
      limit: 6,
    });
    return alts.map((a: any) => ({
      kind: a.kind,
      label: a.label,
      ts: a.slot.start,
      time: fmtTime(a.slot.start),
      day: dateKey(a.slot.start),
      weekday: weekdayLabel(dow(a.slot.start)),
      staffId: a.staffId,
      staffName: ctx.staff.find((s) => s.id === a.staffId)?.name ?? 'Équipe',
    }));
  } catch {
    return [];
  }
}

function hhmmToMin(v: string) {
  const [h, m] = String(v).split(':').map(Number);
  return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
}

publicApi.get('/next', async (c) => {
  const ctx = await ctxFor(c);
  const svcKey = c.req.query('service');
  const service = ctx.services.find((s) => s.key === svcKey) ?? ctx.services[0];
  if (!service) return c.json({ service: null, slot: null, onboarding: true });
  const slot = await nextAvailable(ctx, { serviceId: service.id, durationMin: service.base_duration_min + service.cleanup_min, prepMin: service.prep_min, cleanupMin: service.cleanup_min, staffIds: ctx.staff.map((s) => s.id) });
  return c.json({ service: service.name, slot: slot ? { ts: slot.start, label: humanWhen(slot.start), staffIds: slot.staffIds } : null });
});

const trackSchema = z.object({
  visitorId: z.string().min(6).max(64),
  sessionId: z.string().max(64).optional(),
  kind: z.enum(FUNNEL_KINDS as unknown as [string, ...string[]]),
  path: z.string().max(200).optional(),
  meta: z.record(z.any()).optional(),
  attribution: attributionSchema.optional(),
});

publicApi.post('/track', async (c) => {
  const ctx = await ctxFor(c);
  const body = trackSchema.parse(await c.req.json());
  await db().insert('funnel_events', {
    location_id: ctx.locId,
    visitor_id: body.visitorId,
    session_id: body.sessionId ?? null,
    kind: body.kind,
    step: 0,
    meta_json: sj(body.meta ?? {}),
    source: body.attribution?.source ?? null,
    medium: body.attribution?.medium ?? null,
    campaign: body.attribution?.campaign ?? null,
    landing: body.path ?? null,
    device: body.attribution?.device ?? null,
    referrer: body.attribution?.referrer ?? null,
    ts: Date.now(),
  });
  return c.json({ ok: true }, 202);
});

const bookingSchema = z.object({
  offeringId: z.number().int().positive(),
  addonIds: z.array(z.number().int().positive()).max(6).default([]),
  staffId: z.number().int().positive().nullish(),
  start: z.number().int().positive(),
  visitorId: z.string().max(64).optional(),
  customer: z.object({
    firstName: z.string().min(2).max(60),
    lastName: z.string().max(60).optional(),
    phone: z.string().min(8).max(24),
    email: z.string().email().max(120).optional().or(z.literal('')),
    note: z.string().max(400).optional(),
    birthDay: z.string().max(10).optional(),
  }),
  consent: z.object({ marketingEmail: z.boolean().optional(), marketingSms: z.boolean().optional(), terms: z.boolean() }).optional(),
  attribution: attributionSchema.optional(),
  giftCardCode: z.string().max(40).nullish(),
  referrerCode: z.string().max(40).nullish(),
  paymentMode: z.enum(['deposit', 'full', 'none']).optional(),
  draftId: z.number().int().positive().optional(),
});

publicApi.post('/booking', async (c) => {
  const ctx = await ctxFor(c);
  const rl = await rateLimit(`book:${clientIp(c.req)}`, 12, 600);
  if (!rl.allowed) return c.json({ error: 'too_many_requests', message: 'Trop de tentatives. Réessaie dans une minute.' }, 429);
  const body = bookingSchema.parse(await c.req.json());
  const ua = c.req.header('user-agent') ?? '';
  const chan = channelFromUA(ua);
  const attr: Attribution = {
    source: body.attribution?.source ?? chan?.source ?? 'direct',
    medium: body.attribution?.medium ?? (chan ? 'social' : 'none'),
    campaign: body.attribution?.campaign ?? null,
    landing: body.attribution?.landing ?? c.req.header('referer')?.slice(-120) ?? null,
    device: body.attribution?.device ?? deviceFromUA(ua),
    referrer: body.attribution?.referrer ?? c.req.header('referer')?.split('/')[2] ?? null,
    gclid: body.attribution?.gclid ?? undefined,
  };
  const res = await createBooking({
    ctx,
    offeringId: body.offeringId,
    addonIds: body.addonIds,
    staffId: body.staffId ?? null,
    start: body.start,
    customer: body.customer,
    consentMarketing: { email: body.consent?.marketingEmail, sms: body.consent?.marketingSms },
    attribution: attr,
    giftCardCode: body.giftCardCode ?? null,
    referrerCode: body.referrerCode ?? null,
    paymentMode: body.paymentMode,
    source: attr.source!,
    actor: { type: 'customer' },
  });
  if (body.draftId) await db().update('booking_drafts', body.draftId, { status: 'converted', updated_ts: Date.now() });
  if (body.visitorId) await trackExperimentFromBooking(ctx, body.visitorId, res.priceCents, c);
  return c.json(res, 201);
});

async function trackExperimentFromBooking(ctx: Ctx, visitorId: string, revenue: number, c: Context) {
  try {
    const exps = await db().all<any>(`SELECT * FROM experiments WHERE location_id = :l AND status='running'`, { l: ctx.locId });
    for (const e of exps) {
      const variants = await db().all<any>(`SELECT key, weight FROM experiment_variants WHERE experiment_id = :i`, { i: e.id });
      const v = assignVariant(e.key, visitorId, variants as any);
      await trackExperiment(ctx, e.key, v, visitorId, true, revenue);
    }
  } catch {}
}

publicApi.get('/appointment', async (c) => {
  const ctx = await ctxFor(c);
  const token = c.req.query('token');
  const p = verifyToken<{ a: number; c: number }>(token || '');
  if (!p) return c.json({ error: 'lien_invalide' }, 403);
  const a = await db().one<any>(
    `SELECT a.*, s.name AS service_name, s.key AS service_key, st.name AS staff_name, st.id AS sid, c.first_name, c.last_name, c.phone
     FROM appointments a JOIN services s ON s.id = a.service_id JOIN staff st ON st.id = a.staff_id JOIN customers c ON c.id = a.customer_id WHERE a.id = :i`,
    { i: p.a },
  );
  if (!a || a.customer_id !== p.c) return c.json({ error: 'introuvable' }, 404);
  const addons = await db().all<any>(`SELECT ad.name, ad.price_cents FROM appointment_addons aa JOIN addons ad ON ad.id = aa.addon_id WHERE aa.appointment_id = :i`, { i: a.id });
  return c.json({
    appointment: {
      id: a.id,
      service: a.service_name,
      serviceKey: a.service_key,
      staff: a.staff_name,
      staffId: a.sid,
      start: a.start_ts,
      end: a.end_ts,
      durationMin: a.duration_min,
      priceCents: a.price_cents,
      depositCents: a.deposit_cents,
      depositStatus: a.deposit_status,
      balanceCents: Math.max(0, a.price_cents - a.paid_cents),
      status: a.status,
      confirmed: !!a.confirmed_ts,
      confirmRequired: !!a.confirm_required,
      cancelAllowed: a.start_ts - Date.now() > ctx.policy.cancelCutoffMin,
      cancelCutoffLabel: humanDur(ctx.policy.cancelCutoffMin * MIN),
      addons,
      customer: { firstName: a.first_name, phone: a.phone },
      address: `${ctx.address.street}, ${ctx.address.postalCode} ${ctx.address.city}`,
      maps: ctx.brand.googleMapsUrl,
      location: ctx.name,
    },
    token,
    actions: { confirm: `/api/public/actions/confirm?token=${token}`, reschedule: `/rdv/${a.id}/decaler?token=${token}`, cancel: `/rdv/${a.id}/annuler?token=${token}`, ics: `/api/public/actions/ics?token=${token}`, review: `/avis/${a.id}?token=${token}` },
  });
});

publicApi.post('/appointment/cancel', async (c) => {
  const ctx = await ctxFor(c);
  const { token } = z.object({ token: z.string().min(10) }).parse(await c.req.json());
  const p = verifyToken<{ a: number; c: number }>(token);
  if (!p) return c.json({ error: 'lien_invalide' }, 403);
  const out = await cancelBooking(ctx, p.a, { by: 'client', customerId: p.c, reason: 'client_en_ligne' });
  return c.json(out);
});

publicApi.post('/appointment/reschedule', async (c) => {
  const ctx = await ctxFor(c);
  const body = z.object({ token: z.string().min(10), start: z.number().int().positive(), offeringId: z.number().int().positive().optional(), addonIds: z.array(z.number()).max(6).optional(), staffId: z.number().int().positive().nullish(), reason: z.string().max(200).optional() }).parse(await c.req.json());
  const p = verifyToken<{ a: number; c: number }>(body.token);
  if (!p) return c.json({ error: 'lien_invalide' }, 403);
  const out = await rescheduleBooking({ ctx, appointmentId: p.a, customerId: p.c }, body.start, { offeringId: body.offeringId, addonIds: body.addonIds, staffId: body.staffId, reason: body.reason });
  return c.json(out);
});

publicApi.post('/appointment/service', async (c) => {
  const ctx = await ctxFor(c);
  const body = z.object({ token: z.string().min(10), offeringId: z.number().int().positive(), addonIds: z.array(z.number()).max(6).default([]) }).parse(await c.req.json());
  const p = verifyToken<{ a: number; c: number }>(body.token);
  if (!p) return c.json({ error: 'lien_invalide' }, 403);
  return c.json(await changeServicesOnBooking({ ctx, appointmentId: p.a, customerId: p.c }, body.offeringId, body.addonIds));
});

publicApi.post('/waitlist', async (c) => {
  const ctx = await ctxFor(c);
  const rl = await rateLimit(`wl:${clientIp(c.req)}`, 8, 3600);
  if (!rl.allowed) return c.json({ error: 'too_many', message: 'Tu as déjà plusieurs demandes en cours.' }, 429);
  const body = z
    .object({
      name: z.string().min(2).max(60),
      phone: z.string().min(8).max(24),
      email: z.string().email().max(120).optional().or(z.literal('')),
      serviceKey: z.string().max(40).optional(),
      staffSlug: z.string().max(40).optional(),
      days: z.array(z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.number().int().min(0).max(6)])).max(7).default([]),
      window: z.tuple([z.number().int().min(0).max(1439), z.number().int().min(1).max(1440)]).refine(w => w[1] > w[0], 'La fin doit suivre le début').optional(),
      flex: z.object({ otherStaff: z.boolean().optional(), otherDays: z.boolean().optional(), sameDayOtherTime: z.boolean().optional() }).optional(),
      note: z.string().max(400).optional(),
      consent: z.boolean().default(false),
      attribution: attributionSchema.optional(),
    })
    .parse(await c.req.json());
  if (!ctx.features.waitlist) return c.json({ error: 'waitlist_desactivee', message: 'La liste d’attente est désactivée. Contacte le salon.' }, 409);
  const svc = ctx.services.find((s) => s.key === body.serviceKey);
  const staff = ctx.staff.find((s) => s.slug === body.staffSlug);
  if (body.serviceKey && !svc) return c.json({ error: 'prestation_indisponible', message: 'Cette prestation n’est pas publiée. Choisis une autre prestation ou une demande générale.' }, 422);
  if (body.staffSlug && !staff) return c.json({ error: 'barbier_indisponible', message: 'Ce barbier n’est pas disponible.' }, 422);
  const out = await joinWaitlist(ctx, {
    name: body.name,
    phone: body.phone,
    email: body.email || null,
    serviceId: svc?.id ?? null,
    offeringId: svc ? ctx.offerings.find((o) => o.service_id === svc.id)?.id ?? null : null,
    staffId: staff?.id ?? null,
    days: body.days,
    window: body.window?.length === 2 ? [body.window[0], body.window[1]] : null,
    flex: body.flex,
    note: body.note,
    consent: body.consent,
    source: body.attribution?.source ?? 'site',
  });
  await dispatchNow(ctx, 15);
  return c.json(out, 201);
});

publicApi.get('/waitlist/status', async (c) => {
  const ctx = await ctxFor(c);
  const p = verifyToken<{ w: number; k: string }>(c.req.query('token') || '');
  if (!p || p.k !== 'waitlist') return c.json({ error: 'lien_invalide' }, 403);
  const w = await db().one<any>(`SELECT * FROM waitlist WHERE id = :i AND location_id = :l`, { i: p.w, l: ctx.locId });
  if (!w) return c.json({ error: 'introuvable' }, 404);
  const offers = await db().all<any>(`SELECT * FROM waitlist_offers WHERE waitlist_id = :i ORDER BY id DESC LIMIT 5`, { i: w.id });
  return c.json({
    entry: { id: w.id, status: w.status, createdAt: w.created_ts, notified: w.notified_count, days: j(w.days, []), note: w.note, service: ctx.services.find((s) => s.id === w.service_id)?.name ?? null, staff: ctx.staff.find((s) => s.id === w.staff_id)?.name ?? null },
    position: await countAhead(w),
    offers: offers.map((o: any) => ({ start: o.start_ts, status: o.status, expires: o.expires_ts, token: o.token, service: ctx.services.find((s) => s.id === o.service_id)?.name })),
    manageUrl: appLink(`/waitlist?token=${c.req.query('token')}`),
  });
});

async function countAhead(w: any) {
  const ahead = await db().num(`SELECT COUNT(*) FROM waitlist WHERE location_id = :l AND status='active' AND (priority > :pr OR (priority = :pr AND created_ts < :c))`, { l: w.location_id, pr: w.priority, c: w.created_ts });
  const total = await db().num(`SELECT COUNT(*) FROM waitlist WHERE location_id = :l AND status='active'`, { l: w.location_id });
  return { rank: w.status === 'active' ? ahead + 1 : null, total };
}

publicApi.post('/waitlist/cancel', async (c) => {
  const ctx = await ctxFor(c);
  const { token } = z.object({ token: z.string().min(10) }).parse(await c.req.json());
  const p = verifyToken<{ w: number; k: string }>(token);
  if (!p || p.k !== 'waitlist') return c.json({ error: 'lien_invalide' }, 403);
  await closeWaitlistEntry(ctx, p.w, 'withdrawn');
  return c.json({ ok: true });
});

publicApi.get('/waitlist/offer', async (c) => {
  const ctx = await ctxFor(c);
  const result = await resolveClaimToken(c.req.query('token') || '');
  if (!result || result.offer.location_id !== ctx.locId) return c.json({ error: 'lien_invalide', message: 'Lien invalide ou expiré.' }, 403);
  const o = result.offer;
  return c.json({ status: o.status, expired: result.expired, start: o.start_ts, expires: o.expires_ts,
    service: ctx.services.find(s => s.id === o.service_id)?.name ?? 'Prestation',
    staff: ctx.staff.find(s => s.id === o.staff_id)?.name ?? 'Le salon',
    priceCents: ctx.offerings.find(s => s.id === o.offering_id)?.price_cents ?? null }, 200, { 'Cache-Control': 'no-store' });
});

publicApi.post('/waitlist/claim', async (c) => {
  const ctx = await ctxFor(c);
  const { token } = z.object({ token: z.string().min(10) }).parse(await c.req.json());
  const out = await claimOffer(ctx, token);
  return c.json(out, out.ok ? 200 : 409);
});

publicApi.post('/waitlist/decline', async (c) => {
  const ctx = await ctxFor(c);
  const { token } = z.object({ token: z.string().min(10) }).parse(await c.req.json());
  const out = await declineOffer(ctx, token);
  return c.json(out, out.ok ? 200 : 409);
});

/* Actions déclenchées depuis un lien SMS/email : GET simples, idempotents, non destructifs. */
publicApi.get('/actions/confirm', async (c) => {
  const ctx = await ctxFor(c);
  const p = verifyToken<{ a: number; c: number }>(c.req.query('token') || '');
  if (!p) return c.html(pageResult('Lien expiré', 'Le rendez-vous est toujours là : ouvre ton espace pour le gérer.'), 403);
  const out = await confirmBooking(ctx, p.a, p.c);
  return c.html(pageResult(out.ok ? 'Rendez-vous confirmé ✔' : 'Déjà pris en charge', out.ok ? `Rien d'autre à faire. À très vite chez ${ctx.name}.` : out.message ?? ''));
});

publicApi.get('/actions/ics', async (c) => {
  const ctx = await ctxFor(c);
  const p = verifyToken<{ a: number; c: number }>(c.req.query('token') || '');
  if (!p) return c.json({ error: 'lien_invalide' }, 403);
  const a = await db().one<any>(`SELECT a.*, s.name AS service, st.name AS staff FROM appointments a JOIN services s ON s.id=a.service_id JOIN staff st ON st.id=a.staff_id WHERE a.id = :i AND a.customer_id = :cc`, { i: p.a, cc: p.c });
  if (!a) return c.json({ error: 'introuvable' }, 404);
  const stamp = (ts: number) => new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Z.YASS Barber Shop//RDV//FR', 'BEGIN:VEVENT', `UID:${a.id}@${ctx.slug}.zyass`, `DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(a.start_ts)}`, `DTEND:${stamp(a.end_ts)}`, `SUMMARY:${a.service} — ${ctx.name}`, `LOCATION:${ctx.address.street}\\, ${ctx.address.postalCode} ${ctx.address.city}`, `DESCRIPTION:Barbier : ${a.staff}. Modifier/annuler : ${appLink(`/rdv/${a.id}?token=${c.req.query('token')}`)}`, 'BEGIN:VALARM', 'TRIGGER:-PT3H', 'ACTION:DISPLAY', `DESCRIPTION:RDV ${ctx.name}`, 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  return c.body(ics, 200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="rdv-${a.id}.ics"`, 'Cache-Control': 'private, no-store' });
});

publicApi.get('/actions/open', async (c) => {
  const id = Number(c.req.query('n') || 0);
  if (id) await markEngaged(id, 'opened');
  return c.body('GIF89a\u0001\u0000\u0001\u0000\u0000;\u0000', 200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' });
});
publicApi.get('/actions/click', async (c) => {
  const id = Number(c.req.query('n') || 0);
  if (id) await markEngaged(id, 'clicked');
  const to = c.req.query('to');
  if (to && /^https?:\/\//.test(to)) return c.redirect(to, 302);
  return c.redirect(appLink('/espace'), 302);
});
publicApi.get('/actions/unsubscribe', async (c) => {
  const ctx = await ctxFor(c);
  const p = verifyToken<{ cu: number; k: string }>(c.req.query('token') || '');
  if (!p) return c.html(pageResult('Lien invalide', ''), 403);
  const q = db();
  await q.update('customers', p.cu, { consent_marketing_sms: 0, consent_marketing_email: 0, updated_ts: Date.now() });
  await logConsent(ctx, p.cu, 'marketing_sms', false, 'lien_desinscription', null);
  await logConsent(ctx, p.cu, 'marketing_email', false, 'lien_desinscription', null);
  return c.html(pageResult('C’est noté', 'Tu ne recevras plus de message de notre part (hors rappels de rendez-vous). Tu peux te réinscrire à tout moment depuis ton espace.'));
});

publicApi.get('/reviews', async (c) => {
  const ctx = await ctxFor(c);
  return c.json({ stats: await reviewStats(ctx), list: await publicReviews(ctx, Number(c.req.query('limit') || 9)), note: 'Seuls les avis collectés avec consentement ou publiés sur un profil vérifiable sont affichés.' });
});

publicApi.post('/reviews', async (c) => {
  const ctx = await ctxFor(c);
  const body = z.object({ token: z.string().min(10), rating: z.number().int().min(1).max(5).optional(), comment: z.string().max(900).optional(), consentPublish: z.boolean().optional() }).parse(await c.req.json());
  const p = verifyToken<{ a: number; c: number }>(body.token);
  if (!p) return c.json({ error: 'lien_invalide' }, 403);
  const out = await submitReview(ctx, p.a, { rating: body.rating, comment: body.comment, consentPublish: body.consentPublish, customerId: p.c });
  return c.json(out, 201);
});

publicApi.post('/draft', async (c) => {
  const ctx = await ctxFor(c);
  const body = z
    .object({
      visitorId: z.string().min(4).max(64),
      sessionId: z.string().max(64).optional(),
      offeringId: z.number().int().positive().optional(),
      staffId: z.number().int().positive().nullish(),
      addonIds: z.array(z.number()).max(6).default([]),
      slot: z.number().int().positive().optional(),
      step: z.string().max(24).default('service'),
      contact: z.object({ firstName: z.string().max(60).optional(), lastName: z.string().max(60).optional(), phone: z.string().max(24).optional(), email: z.string().email().optional(), note: z.string().max(400).optional(), marketingEmail: z.boolean().optional() }).optional(),
      attribution: attributionSchema.optional(),
    })
    .parse(await c.req.json());
  const q = db();
  const existing = await q.one<any>(`SELECT * FROM booking_drafts WHERE visitor_id = :v AND status = 'open' ORDER BY id DESC LIMIT 1`, { v: body.visitorId });
  const row = {
    location_id: ctx.locId,
    visitor_id: body.visitorId,
    session_id: body.sessionId ?? existing?.session_id ?? null,
    offering_id: body.offeringId ?? existing?.offering_id ?? null,
    staff_id: body.staffId === undefined ? existing?.staff_id ?? null : body.staffId ?? null,
    addon_ids: sj(body.addonIds.length ? body.addonIds : j(existing?.addon_ids, [])),
    slot_start_ts: body.slot ?? existing?.slot_start_ts ?? null,
    first_name: body.contact?.firstName ?? existing?.first_name ?? null,
    last_name: body.contact?.lastName ?? existing?.last_name ?? null,
    phone: body.contact?.phone ?? existing?.phone ?? null,
    email: body.contact?.email ?? existing?.email ?? null,
    note: body.contact?.note ?? existing?.note ?? null,
    consent_marketing: body.contact?.marketingEmail ? 1 : existing?.consent_marketing ?? 0,
    contact_ts: body.contact?.phone || body.contact?.email ? Date.now() : existing?.contact_ts ?? null,
    source: body.attribution?.source ?? existing?.source ?? null,
    medium: body.attribution?.medium ?? existing?.medium ?? null,
    campaign: body.attribution?.campaign ?? existing?.campaign ?? null,
    landing: body.attribution?.landing ?? existing?.landing ?? null,
    device: body.attribution?.device ?? existing?.device ?? null,
    referrer: body.attribution?.referrer ?? existing?.referrer ?? null,
    step: body.step,
    status: 'open',
    updated_ts: Date.now(),
  };
  let id: number;
  if (existing) {
    await q.update('booking_drafts', existing.id, row);
    id = existing.id;
  } else {
    id = await q.insert('booking_drafts', { created_ts: Date.now(), expires_ts: Date.now() + 3 * DAY, ...row });
  }
  const token = signToken({ d: id, v: body.visitorId, k: 'draft' }, 3 * DAY);
  return c.json({ id, resumeUrl: appLink(`/book?draft=${token}`), token }, 201);
});

publicApi.get('/draft', async (c) => {
  const ctx = await ctxFor(c);
  const p = verifyToken<{ d: number; k: string }>(c.req.query('token') || '');
  if (!p) return c.json({ error: 'lien_invalide' }, 403);
  const d = await db().one<any>(`SELECT * FROM booking_drafts WHERE id = :i AND location_id = :l`, { i: p.d, l: ctx.locId });
  if (!d) return c.json({ error: 'introuvable' }, 404);
  return c.json({
    id: d.id,
    step: d.step,
    offeringId: d.offering_id,
    staffId: d.staff_id,
    addonIds: j(d.addon_ids, []),
    slot: d.slot_start_ts,
    contact: { firstName: d.first_name, lastName: d.last_name, phone: d.phone, email: d.email, note: d.note, marketingEmail: !!d.consent_marketing },
    attribution: { source: d.source, medium: d.medium, campaign: d.campaign, landing: d.landing, device: d.device, referrer: d.referrer },
    status: d.status,
  });
});

publicApi.post('/auth/code', async (c) => {
  const ctx = await ctxFor(c);
  const body = z.object({ target: z.string().min(6).max(80) }).parse(await c.req.json());
  const rl = await rateLimit(`code:${body.target}`, 4, 900);
  if (!rl.allowed) return c.json({ error: 'too_many', message: 'Trop de demandes. Réessaie dans 15 minutes.' }, 429);
  const phone = normalizePhone(body.target);
  const email = body.target.includes('@') ? normalizeEmail(body.target) : null;
  const cust = await db().one<any>(`SELECT * FROM customers WHERE location_id = :l AND (phone_norm = :p OR (email_norm IS NOT NULL AND email_norm = :e)) AND deleted_ts IS NULL`, { l: ctx.locId, p: phone || '-', e: email ?? '-' });
  if (!cust) return c.json({ error: 'inconnu', message: 'Aucun compte associé. Réserve d’abord un créneau : ton espace se crée tout seul.', found: false }, 404);
  const code = String(randomInt(100000, 1000000));
  const { hashPepper } = await import('./lib/secrets.ts');
  await db().exec(
    `INSERT INTO login_codes (target, channel, code_hash, created_ts, expires_ts, attempts, consumed, ip) VALUES (:t, :ch, :h, :n, :x, 0, 0, :ip)
     ON CONFLICT(target, channel) DO UPDATE SET code_hash = :h2, created_ts = :n2, expires_ts = :x2, attempts = 0, consumed = 0, ip = :ip2`,
    { t: body.target, ch: email && !phone ? 'email' : 'sms', h: hashPepper(code), n: Date.now(), x: Date.now() + 10 * MIN, ip: clientIp(c.req), h2: hashPepper(code), n2: Date.now(), x2: Date.now() + 10 * MIN, ip2: clientIp(c.req) },
  );
  await notify(ctx, 'login_code', { customerId: cust.id, idem: `login:${cust.id}:${hashPepper(code)}:${Date.now()}`, vars: { message: `Ton code de connexion : ${code} (valable 10 minutes).` }, channels: email && !phone ? ['email'] : ['sms'] });
  await dispatchNow(ctx, 8);
  return c.json({ ok: true, channel: phone ? 'sms' : 'email', demoCode: env.demo ? code : undefined, expiresInMin: 10 });
});

publicApi.post('/auth/code/verify', async (c) => {
  const body = z.object({ target: z.string().min(6).max(80), code: z.string().min(4).max(10) }).parse(await c.req.json());
  const rl = await rateLimit(`codeverify:${body.target.replace(/\D/g, '').slice(-9)}`, 6, 900);
  if (!rl.allowed) return c.json({ error: 'trop_de_essais', message: 'Trop de tentatives. Redemande un code dans 15 minutes.' }, 429);
  const { hashPepper } = await import('./lib/secrets.ts');
  const q = db();
  const row = await q.one<any>(`SELECT * FROM login_codes WHERE target = :t ORDER BY id DESC LIMIT 1`, { t: body.target });
  if (!row) return c.json({ error: 'code_inconnu', message: 'Aucun code en cours pour ce numéro.' }, 404);
  if (row.attempts >= 5) return c.json({ error: 'trop_de_essais', message: 'Trop de tentatives. Redemande un code.' }, 429);
  if (hashPepper(body.code) !== row.code_hash) {
    await q.update('login_codes', row.id, { attempts: row.attempts + 1 });
    return c.json({ error: 'code_invalide', message: 'Code incorrect.' }, 401);
  }
  if (row.consumed || row.expires_ts < Date.now()) return c.json({ error: 'code_expire', message: 'Code expiré, redemande-en un.' }, 410);
  await q.update('login_codes', row.id, { consumed: 1 });
  const phone = normalizePhone(body.target);
  const email = body.target.includes('@') ? normalizeEmail(body.target) : null;
  const ctx = await ctxFor(c);
  const cust = await q.one<any>(`SELECT * FROM customers WHERE location_id = :l AND (phone_norm = :p OR (email_norm IS NOT NULL AND email_norm = :e))`, { l: ctx.locId, p: phone || '-', e: email ?? '-' });
  if (!cust) return c.json({ error: 'inconnu' }, 404);
  let userId = cust.user_id;
  if (!userId) {
    userId = await q.insert('users', { location_id: null, email: cust.email, phone: cust.phone, name: `${cust.first_name ?? ''} ${cust.last_name ?? ''}`.trim(), role_key: 'customer', password_hash: hashPassword(rnd(12)), created_ts: Date.now() });
    await q.update('customers', cust.id, { user_id: userId });
  }
  const sid = await createSession({ id: userId, role: 'customer', location_id: ctx.locId, staff_id: null, name: cust.first_name ?? 'Client', email: cust.email, customer_id: cust.id }, c.req);
  return c.json({ ok: true }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, sid) });
});

/** Cadence de connexion : le plafond de production est un choix de sécurité, pas un réglage de confort. */
export const LOGIN_LIMITS = { prod: 10, dev: 60, windowSec: 600 } as const;

publicApi.post('/auth/password', async (c) => {
  const body = z.object({ email: z.string().email(), password: z.string().min(6).max(200), scope: z.enum(['admin', 'client']).default('admin') }).parse(await c.req.json());
  // 10 tentatives / 10 min en production (anti-force-brute) ; la démo locale a besoin de plus large :
  // les suites e2e ouvrent cinq contextes (mobile, télé, deux tablettes, bureau) et se connectent
  // deux fois par contexte — le mur de 10 faisait échouer les derniers projets pour une raison de
  // cadence, pas de sécurité. En prod, la valeur reste 10.
  const rl = await rateLimit(`login:${clientIp(c.req)}`, env.isProd ? LOGIN_LIMITS.prod : LOGIN_LIMITS.dev, LOGIN_LIMITS.windowSec);
  if (!rl.allowed) return c.json({ error: 'too_many', message: 'Trop de tentatives.' }, 429);
  const u = await checkPassword(body.email, body.password);
  if (!u) return c.json({ error: 'identifiants', message: 'Email ou mot de passe incorrect.' }, 401);
  if (body.scope === 'admin' && !needRole({ role: u.role_key as Role } as any, 'staff')) return c.json({ error: 'acces', message: 'Compte sans accès au back-office.' }, 403);
  const cust = u.role_key === 'customer' ? await db().one<any>(`SELECT id FROM customers WHERE user_id = :i`, { i: u.id }) : null;
  const sid = await createSession({ id: u.id, role: u.role_key, location_id: u.location_id, staff_id: u.staff_id, name: u.name, email: u.email, customer_id: cust?.id ?? null }, c.req);
  await audit(u.location_id, u.role_key, u.id, 'auth.login', 'users', u.id, { ip: clientIp(c.req) });
  return c.json({ ok: true, role: u.role_key }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, sid) });
});

publicApi.post('/auth/logout', async (c) => {
  await destroySession(c.req);
  return c.json({ ok: true }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, '', { maxAgeSec: 0 }) });
});

publicApi.get('/me', async (c) => {
  const u = await readSession(c.req);
  /* Contrat explicite : `anonymous` fait partie de la réponse. Un simple `{ user: null }` laissait
     l'espace client conclure « connecté » (le test était `!data.anonymous`), rendre le tableau de
     bord sur un utilisateur null, et — faute de boundary — laisser une page entièrement blanche.
     Mesuré sur le build du 28/09/2026 : `/espace` = 0 caractère visible, TypeError non rattrapé. */
  return c.json(u ? { user: u, anonymous: false } : { user: null, anonymous: true });
});

/* Brouillon de client : réinitialiser mot de passe + création de compte à la volée */
publicApi.post('/auth/password/set', async (c) => {
  const body = z.object({ target: z.string().min(6).max(80), code: z.string().min(4).max(10), password: z.string().min(8).max(200) }).parse(await c.req.json());
  const ctx = await ctxFor(c);
  const q = db();
  const { hashPepper } = await import('./lib/secrets.ts');
  const row = await q.one<any>(`SELECT * FROM login_codes WHERE target = :t AND expires_ts > :n AND consumed = 0 ORDER BY id DESC LIMIT 1`, { t: body.target, n: Date.now() });
  if (!row || hashPepper(body.code) !== row.code_hash) return c.json({ error: 'code', message: 'Code invalide ou expiré.' }, 401);
  const phone = normalizePhone(body.target);
  const email = body.target.includes('@') ? normalizeEmail(body.target) : null;
  const cust = await q.one<any>(`SELECT * FROM customers WHERE location_id = :l AND (phone_norm = :p OR (email_norm IS NOT NULL AND email_norm = :e))`, { l: ctx.locId, p: phone || '-', e: email ?? '-' });
  if (!cust) return c.json({ error: 'inconnu' }, 404);
  let userId = cust.user_id;
  if (!userId) userId = await q.insert('users', { location_id: null, email: cust.email, phone: cust.phone, name: cust.first_name, role_key: 'customer', password_hash: hashPassword(body.password), created_ts: Date.now() });
  else await setPasswordForUser(userId, body.password);
  await q.update('customers', cust.id, { user_id: userId });
  await q.update('login_codes', row.id, { consumed: 1 });
  const sid = await createSession({ id: userId, role: 'customer', location_id: ctx.locId, staff_id: null, name: cust.first_name ?? 'Client', email: cust.email, customer_id: cust.id }, c.req);
  return c.json({ ok: true }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, sid) });
});

publicApi.post('/gift-cards', async (c) => {
  const ctx = await ctxFor(c);
  // Sans paiement en ligne, on ne laisse pas croire qu'une carte vient d'être achetée : la
  // demande est refusée avec l'alternative réelle (le salon imprime le code au comptoir), et
  // l'émission par l'admin reste disponible — c'est elle que le salon utilise vraiment ici.
  if (env.payments === 'off')
    return c.json(
      { error: 'reglement_au_comptoir', message: 'Les cartes cadeaux se règlent au comptoir : passe au salon (20 boulevard Roy) ou appelle le ' + (ctx.loc.phone ?? 'le salon') + ', le code est imprimé et activé devant toi.' },
      409,
    );
  const rl = await rateLimit(`gift:${clientIp(c.req)}`, 6, 3600);
  if (!rl.allowed) return c.json({ error: 'too_many', message: 'Trop de demandes, réessaie dans 1 heure.' }, 429);
  const body = z
    .object({
      amountCents: z.number().int().min(1000).max(50000),
      buyerName: z.string().min(2).max(60),
      buyerEmail: z.string().email().max(120),
      recipientName: z.string().max(60).optional(),
      message: z.string().max(240).optional(),
      serviceKey: z.string().max(40).optional(),
      sendAt: z.number().int().positive().optional(),
    })
    .parse(await c.req.json());
  const serviceId = ctx.services.find((x) => x.key === body.serviceKey)?.id ?? null;
  const gc = await buyGiftCard(ctx, {
    amountCents: body.amountCents,
    buyerName: cleanText(body.buyerName, 60),
    buyerEmail: body.buyerEmail,
    recipientName: body.recipientName ? cleanText(body.recipientName, 60) : undefined,
    message: body.message ? cleanText(body.message, 240) : undefined,
    serviceId,
    sendAt: body.sendAt,
  });
  await audit(ctx.locId, 'customer', null, 'gift_card.buy', 'gift_card', gc.id, { amountCents: body.amountCents, status: gc.status });
  return c.json(
    {
      ok: true,
      status: gc.status,
      code: gc.status === 'active' ? gc.code : null,
      amountCents: gc.amount_cents,
      recipientName: gc.recipient_name,
      message: gc.message,
      bookUrl: appLink(`/book?gift=${gc.status === 'active' ? gc.code : ''}`),
      note: gc.status === 'active' ? 'Carte activée — le code part par e-mail, et se saisit au moment de la réservation.' : 'Paiement à confirmer pour activer la carte.',
    },
    201,
  );
});

publicApi.get('/content-pages', async (c) => {
  const ctx = await ctxFor(c);
  const rows = await db().all<any>(`SELECT slug, title, summary, updated_ts, kind FROM content_pages WHERE location_id = :l AND is_published = 1 ORDER BY updated_ts DESC LIMIT 24`, { l: ctx.locId });
  return c.json({ pages: rows });
});

publicApi.get('/content-pages/:slug', async (c) => {
  const ctx = await ctxFor(c);
  const want = c.req.param('slug') || '';
  // une page peut être adressée par son slug stocké (`guide-barbe-propre`) ou par sa forme
  // courte d'URL (`barbe-propre`) : on tente les deux, plus le préfixe guide- — sinon chaque
  // lien cassé devient un 404 invisible.
  const cands = [...new Set([want, `guide-${want}`, want.replace(/^guide-/, '')].filter(Boolean))];
  const ph = cands.map((_, i) => `:s${i}`).join(',');
  let p = await db().one<any>(
    `SELECT * FROM content_pages WHERE location_id = :l AND is_published = 1 AND slug IN (${ph}) ORDER BY CASE ${cands
      .map((_, i) => `WHEN slug = :s${i} THEN ${i}`)
      .join(' ')} ELSE 9 END LIMIT 1`,
    Object.fromEntries([['l', ctx.locId], ...cands.map((v, i) => [`s${i}`, v])]),
  );
  if (!p) return c.json({ error: 'introuvable' }, 404);
  return c.json({
    page: {
      slug: p.slug,
      title: p.title,
      summary: p.summary,
      blocks: j(p.body_json, []),
      faq: j(p.faq_json, []),
      serviceKey: p.service_key,
      readingMin: p.reading_min,
      updated: p.updated_ts,
      seo: { title: p.seo_title, description: p.seo_desc },
    },
  });
});

publicApi.get('/gift-cards/:code', async (c) => {
  const ctx = await ctxFor(c);
  const code = String(c.req.param('code') || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
  const gc = await findGiftCard(ctx, code);
  if (!gc) return c.json({ error: 'introuvable', message: 'Ce code ne correspond à aucune carte de ce salon.' }, 404);
  return c.json({
    ok: true,
    amountCents: gc.amount_cents,
    balanceCents: gc.balance_cents,
    status: gc.status,
    recipientName: gc.recipient_name,
    message: gc.message,
    expires: gc.expires_ts,
    service: ctx.services.find((x) => x.id === gc.service_id)?.name ?? null,
    bookUrl: appLink(`/book?gift=${gc.code}`),
  });
});

publicApi.get('/experiments/variant', async (c) => {
  const ctx = await ctxFor(c);
  const visitor = c.req.query('visitor') || 'anon';
  const key = c.req.query('key');
  const q = db();
  const rows = await q.all<any>(`SELECT e.key AS k, e.id, v.key AS vkey, v.payload_json FROM experiments e JOIN experiment_variants v ON v.experiment_id = e.id WHERE e.location_id = :l AND e.status='running' ${key ? 'AND e.key = :k' : ''}`, { l: ctx.locId, ...(key ? { k: key } : {}) });
  const byExp: Record<string, { variant: string; cfg: any }> = {};
  const grouped: Record<string, any[]> = {};
  for (const r of rows) (grouped[r.k] = grouped[r.k] ?? []).push({ key: r.vkey, weight: 50, payload: j(r.payload_json, {}) });
  for (const [k, vs] of Object.entries(grouped)) {
    const v = assignVariant(k, visitor, vs as any);
    byExp[k] = { variant: v, cfg: vs.find((x) => x.key === v)?.payload ?? {} };
    await q.exec(`INSERT INTO experiment_assignments (experiment_key, variant_key, visitor_id, converted, revenue_cents, ts) VALUES (:e, :v, :u, 0, 0, :t) ON CONFLICT(experiment_key, variant_key, visitor_id) DO NOTHING`, { e: k, v, u: visitor, t: Date.now() }).catch(() => undefined);
  }
  return c.json(byExp, 200, { 'Cache-Control': 'no-store' });
});

publicApi.get('/gallery', async (c) => {
  const ctx = await ctxFor(c);
  const filter = c.req.query('filter');
  const rows = await db().all<any>(`SELECT * FROM media WHERE location_id = :l AND kind IN ('photo','video','before_after') ORDER BY ts DESC LIMIT 40`, { l: ctx.locId });
  const out = rows.filter((r: any) => !filter || r.service_key === filter || r.label?.toLowerCase().includes(String(filter).toLowerCase()));
  return c.json({ items: out.map((r: any) => ({ ...r, service: ctx.services.find((s) => s.key === r.service_key)?.name ?? null, priceCents: r.price_cents, durationMin: r.duration_min })), filters: [...new Set(rows.map((r: any) => r.service_key).filter(Boolean))] });
});

publicApi.get('/walkin', async (c) => {
  const ctx = await ctxFor(c);
  if (!ctx.features.walkin) return c.json({ enabled: false });
  const q = db();
  const open = await q.all<any>(`SELECT * FROM walkins WHERE location_id = :l AND status = 'waiting' ORDER BY queue_rank`, { l: ctx.locId });
  if (!ctx.services[0]) {
    return c.json({ enabled: false, onboarding: true, waiting: open.length, freeNow: 0, etaMin: null, note: 'Le salon finalise son ouverture : pas encore d’agenda publié.' });
  }
  const day = await computeDay(ctx, { serviceId: ctx.services[0].id, durationMin: ctx.services[0].base_duration_min + 5, prepMin: 0, cleanupMin: 5, day: todayDay(), now: Date.now(), staffIds: ctx.staff.map((s) => s.id), window: null, respectStep: false });
  const free = day.slots.length;
  const minFree = ctx.staff.length ? Math.ceil((open.length + 1) * (ctx.services[0].base_duration_min / Math.max(1, ctx.staff.length))) : 0;
  // Un fauteuil libre se dit « libre », pas « attends 5 minutes » : promettre un chiffre qu'aucune
  // donnée ne soutient est exactement la fausse rareté (et la fausse attente) qu'on interdit ailleurs.
  return c.json({
    enabled: true,
    waiting: open.length,
    freeNow: free,
    etaMin: free > open.length ? 0 : minFree,
    note: free > open.length ? 'Un fauteuil est libre maintenant : passez.' : 'Estimation basée sur les RDV en cours, pas une promesse.',
  });
});

function pageResult(title: string, msg: string) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;background:#0B0B0D;color:#F4F1EA;font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;display:grid;place-items:center;min-height:100vh}
div{max-width:420px;padding:32px;text-align:center}h1{font-size:22px;margin:0 0 10px}a{color:#E8C98A}</style></head>
<body><div><h1>${title}</h1><p>${msg}</p><p><a href="/book">Prendre rendez-vous</a></p></div></body></html>`;
}

/* ══════════════════════════════════════════════════════════════════
   Espace client
   ══════════════════════════════════════════════════════════════════ */

export const clientApi = new Hono();

async function requireCustomer(c: Context): Promise<{ ctx: Ctx; user: SessionUser & { customerId: number } }> {
  const user = await readSession(c.req);
  if (!user) throw Object.assign(new Error('Connexion requise'), { status: 401 });
  const ctx = await loadCtx(c.req.query('loc') || (user.locationId ?? env.demoSlug));
  if (!user.customerId) throw Object.assign(new Error('Aucune fiche client associée'), { status: 403 });
  return { ctx, user: { ...user, customerId: user.customerId } };
}

clientApi.get('/summary', async (c) => {
  const { ctx, user } = await requireCustomer(c);
  const q = db();
  const card = await customerCard(ctx, user.customerId!);
  const up = await upcomingFor(ctx, user.customerId!);
  const loy = await computeLoyalty(ctx, user.customerId!);
  const ref = await referralSummary(ctx, user.customerId!);
  const member = await memberStatus(ctx, user.customerId!);
  const alerts = await q.all<any>(`SELECT id, kind, body_text, created_ts, appointment_id FROM notifications WHERE customer_id = :c AND channel='web' ORDER BY id DESC LIMIT 6`, { c: user.customerId });
  const habit = card?.avg_days_between ?? 28;
  const dueIn = card?.last_visit_ts ? Math.round(habit - (Date.now() - card.last_visit_ts) / DAY) : null;
  return c.json({
    customer: { id: card.id, firstName: card.first_name, lastName: card.last_name, phone: card.phone, email: card.email, tags: card.tags, notes: card.notes, birthDay: card.birth_day, consent: { email: !!card.consent_marketing_email, sms: !!card.consent_marketing_sms }, preferredStaffId: card.preferred_staff_id, segment: card.segment, visits: card.visits_count, spentCents: card.spent_cents },
    upcoming: up.map((a: any) => shapeAppointment(a, ctx)),
    history: (card.visits ?? []).slice(0, 20).map((a: any) => shapeAppointment(a, ctx)),
    loyalty: loy,
    referral: ref,
    membership: member,
    alerts,
    rebookHint: dueIn != null ? (dueIn > 0 ? `Tu reviens généralement toutes les ${habit} jours — le bon moment sera dans ${dueIn} jours.` : `Ça fait ${-dueIn} jours de plus que d'habitude : voilà les prochains créneaux.`) : null,
    habitDays: habit,
    lastVisit: card.last_visit_ts,
  });
});

function shapeAppointment(a: any, ctx: Ctx) {
  return {
    id: a.id,
    service: a.service_name,
    serviceId: a.service_id,
    staff: a.staff_name,
    staffId: a.staff_id,
    start: a.start_ts,
    end: a.end_ts,
    durationMin: a.duration_min,
    priceCents: a.price_cents,
    depositCents: a.deposit_cents,
    depositStatus: a.deposit_status,
    status: a.status,
    confirmed: !!a.confirmed_ts,
    confirmRequired: !!a.confirm_required,
    reviewStatus: a.review_status,
    token: signToken({ a: a.id, c: a.customer_id, k: 'manage' }, 120 * DAY),
    cancelAllowed: a.start_ts - Date.now() > ctx.policy.cancelCutoffMin && ['booked', 'confirmed', 'pending_payment'].includes(a.status),
    cancelCutoff: humanDur(ctx.policy.cancelCutoffMin * MIN),
    manageUrl: appLink(`/rdv/${a.id}?token=${signToken({ a: a.id, c: a.customer_id, k: 'manage' }, 120 * DAY)}`),
  };
}

clientApi.get('/appointments', async (c) => {
  const { ctx, user } = await requireCustomer(c);
  const rows = await db().all<any>(
    `SELECT a.*, s.name AS service_name, st.name AS staff_name FROM appointments a JOIN services s ON s.id=a.service_id JOIN staff st ON st.id=a.staff_id
     WHERE a.customer_id = :c ORDER BY a.start_ts DESC LIMIT 60`,
    { c: user.customerId },
  );
  return c.json(rows.map((r: any) => shapeAppointment(r, ctx)));
});

/** "Reprendre le même rendez-vous" — 1 clic, date suggérée selon l'habitude réelle. */
clientApi.post('/rebook', async (c) => {
  const { ctx, user } = await requireCustomer(c);
  const body = z.object({ appointmentId: z.number().int().positive().optional(), serviceId: z.number().int().positive().optional(), staffId: z.number().int().positive().nullish() }).parse(await c.req.json().catch(() => ({})));
  const q = db();
  const last = body.appointmentId ? await q.one<any>(`SELECT * FROM appointments WHERE id = :i AND customer_id = :c`, { i: body.appointmentId, c: user.customerId }) : await q.one<any>(`SELECT * FROM appointments WHERE customer_id = :c AND status='completed' ORDER BY start_ts DESC LIMIT 1`, { c: user.customerId });
  const serviceId = body.serviceId ?? last?.service_id ?? ctx.services[0].id;
  const staffId = body.staffId === undefined ? last?.staff_id ?? null : body.staffId;
  const svc = ctx.services.find((s) => s.id === serviceId)!;
  const habit = (await q.one<any>(`SELECT avg_days_between FROM customers WHERE id = :i`, { i: user.customerId }))?.avg_days_between ?? 28;
  const lastTs = last?.start_ts ?? null;
  const fromDay = lastTs ? (Date.now() - lastTs > habit * DAY ? todayDay() : dayAdd(dateKey(lastTs + habit * DAY), 0)) : todayDay();
  const days = await dayList(ctx, fromDay < todayDay() ? todayDay() : fromDay, Math.min(14, ctx.policy.horizonDays));
  const res = await availability(ctx, { serviceId: svc.id, durationMin: svc.base_duration_min + svc.cleanup_min, prepMin: svc.prep_min, cleanupMin: svc.cleanup_min, staffIds: staffId ? [staffId] : ctx.staff.filter((s) => (s.service_ids.length ? s.service_ids.includes(svc.id) : true)).map((s) => s.id), days, presentStepMin: 30 });
  return c.json({
    service: { id: svc.id, key: svc.key, name: svc.name, priceCents: svc.base_price_cents, durationMin: svc.base_duration_min },
    suggestedFrom: fromDay,
    habitDays: habit,
    message: lastTs ? `Tu reviens en général toutes les ${Math.round(habit)} jours. Voici ${res.totalCount} créneaux${staffId ? ` avec ${ctx.staff.find((s) => s.id === staffId)?.name}` : ''}.` : `Voici ${res.totalCount} créneaux disponibles.`,
    days: res.days.map((d) => ({ day: d.day, weekday: weekdayLabel(dow(startOfDayMs(d.day))), label: fmtDate(startOfDayMs(d.day), { short: true }), count: d.slots.length, closed: d.slots.length ? null : d.closedReason, slots: d.slots.slice(0, 24).map((s) => ({ ts: s.start, time: fmtTime(s.start), staffIds: s.staffIds })) })),
    best: res.best ? { ts: res.best.start, staffIds: res.best.staffIds, day: dateKey(res.best.start) } : null,
    noSlots: res.totalCount === 0,
  });
});

clientApi.post('/profile', async (c) => {
  const { ctx, user } = await requireCustomer(c);
  const body = z
    .object({
      firstName: z.string().max(60).optional(),
      lastName: z.string().max(60).optional(),
      email: z.string().email().max(120).or(z.literal('')).optional(),
      birthDay: z.string().max(10).optional(),
      note: z.string().max(500).optional(),
      preferredStaffId: z.number().int().positive().nullish(),
      preferredServiceId: z.number().int().positive().nullish(),
      consentMarketingEmail: z.boolean().optional(),
      consentMarketingSms: z.boolean().optional(),
      consentMarketingWhatsapp: z.boolean().optional(),
    })
    .parse(await c.req.json());
  const q = db();
  const patch: any = { updated_ts: Date.now() };
  if (body.firstName !== undefined) patch.first_name = cleanText(body.firstName, 60);
  if (body.lastName !== undefined) patch.last_name = cleanText(body.lastName, 60);
  if (body.email !== undefined) patch.email = body.email || null;
  if (body.birthDay) patch.birth_day = body.birthDay;
  if (body.note !== undefined) patch.notes = cleanText(body.note, 500);
  if (body.preferredStaffId !== undefined) patch.preferred_staff_id = body.preferredStaffId;
  if (body.preferredServiceId !== undefined) patch.preferred_service_id = body.preferredServiceId;
  if (body.consentMarketingEmail !== undefined) patch.consent_marketing_email = body.consentMarketingEmail ? 1 : 0;
  if (body.consentMarketingSms !== undefined) patch.consent_marketing_sms = body.consentMarketingSms ? 1 : 0;
  if (body.consentMarketingWhatsapp !== undefined) patch.consent_marketing_whatsapp = body.consentMarketingWhatsapp ? 1 : 0;
  await q.update('customers', user.customerId!, patch);
  if (body.consentMarketingEmail !== undefined) await logConsent(ctx, user.customerId!, 'marketing_email', !!body.consentMarketingEmail, 'espace_client', body.email ?? null, clientIp(c.req), c.req.header('user-agent') ?? undefined);
  if (body.consentMarketingSms !== undefined) await logConsent(ctx, user.customerId!, 'marketing_sms', !!body.consentMarketingSms, 'espace_client', null, clientIp(c.req), c.req.header('user-agent') ?? undefined);
  return c.json({ ok: true });
});

clientApi.post('/rewards/redeem', async (c) => {
  const { ctx, user } = await requireCustomer(c);
  const { rewardId } = z.object({ rewardId: z.number().int().positive() }).parse(await c.req.json());
  try {
    return c.json(await redeemReward(ctx, user.customerId!, rewardId));
  } catch (e: any) {
    return c.json({ error: 'reward', message: e.message }, 422);
  }
});

clientApi.get('/gift-cards', async (c) => {
  const { ctx, user } = await requireCustomer(c);
  const me = await db().one<any>(`SELECT id FROM customers WHERE id = :i`, { i: user.customerId });
  void me;
  const rows = await db().all<any>(`SELECT code, amount_cents, balance_cents, status, redeemed_ts, created_ts FROM gift_cards WHERE location_id = :l AND (redeemer_id = :c OR buyer_email = (SELECT email FROM customers WHERE id = :c)) ORDER BY created_ts DESC LIMIT 10`, { l: ctx.locId, c: user.customerId });
  return c.json(rows);
});

clientApi.get('/export', async (c) => {
  const { ctx, user } = await requireCustomer(c);
  const q = db();
  const card = await customerCard(ctx, user.customerId!);
  const data = {
    export: { genere_le: new Date().toISOString(), salon: ctx.name },
    client: { ...card, notes: card?.notes, consent_log: card?.consents, loyalty: card?.ledger, reviews: card?.reviews },
    rendezvous: card?.visits,
    messages: await q.all<any>(`SELECT kind, channel, subject, body_text, created_ts, sent_ts FROM notifications WHERE customer_id = :i ORDER BY created_ts DESC LIMIT 200`, { i: user.customerId }),
    consentements: await q.all<any>(`SELECT purpose, channel, granted, source, ts FROM consents WHERE customer_id = :i ORDER BY ts DESC`, { i: user.customerId }),
  };
  await audit(ctx.locId, 'customer', user.customerId, 'gdpr.export', 'customers', user.customerId, {});
  return c.json(data, 200, { 'Content-Disposition': `attachment; filename="mes-donnees-${ctx.slug}.json"` });
});

clientApi.post('/delete', async (c) => {
  const { ctx, user } = await requireCustomer(c);
  const body = z.object({ confirm: z.boolean() }).parse(await c.req.json());
  if (!body.confirm) return c.json({ error: 'confirmation_requise' }, 422);
  const q = db();
  const upcoming = await q.num(`SELECT COUNT(*) FROM appointments WHERE customer_id = :i AND start_ts > :n AND status IN ('booked','confirmed','pending_payment')`, { i: user.customerId, n: Date.now() });
  if (upcoming) {
    for (const a of await q.all<any>(`SELECT id FROM appointments WHERE customer_id = :i AND start_ts > :n AND status IN ('booked','confirmed','pending_payment')`, { i: user.customerId, n: Date.now() })) {
      await cancelBooking(ctx, a.id, { by: 'client', reason: 'suppression_compte' });
    }
  }
  // anonymisation plutôt que suppression physique : le chiffre d'affaires et les stats du salon restent justes
  await q.update('customers', user.customerId, {
    deleted_ts: Date.now(),
    first_name: 'Supprimé',
    last_name: null,
    phone: null,
    phone_norm: null,
    email: null,
    email_norm: null,
    birth_day: null,
    notes: null,
    tags: sj([]),
    consent_marketing_email: 0,
    consent_marketing_sms: 0,
    updated_ts: Date.now(),
  });
  await q.exec(`DELETE FROM consents WHERE customer_id = :i AND purpose LIKE 'marketing%'`, { i: user.customerId });
  await q.insert('requests_deletion', { location_id: ctx.locId, customer_id: user.customerId, kind: 'erasure', status: 'done', done_ts: Date.now(), ts: Date.now(), ip: clientIp(c.req) });
  await destroySession(c.req);
  await audit(ctx.locId, 'customer', user.customerId, 'gdpr.erase', 'customers', user.customerId, {});
  return c.json({ ok: true, message: 'Compte supprimé et données personnelles effacées.' }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, '', { maxAgeSec: 0 }) });
});

/* ══════════════════════════════════════════════════════════════════
   Back-office
   ══════════════════════════════════════════════════════════════════ */

export const adminApi = new Hono();

async function requireAdmin(c: Context, min: Role = 'staff'): Promise<{ ctx: Ctx; user: SessionUser }> {
  const user = await readSession(c.req);
  if (!user) throw Object.assign(new Error('Connexion requise'), { status: 401 });
  if (!needRole(user, min)) throw Object.assign(new Error('Droits insuffisants'), { status: 403 });
  // Sans `?loc=`, le back-office travaille SUR LE SALON DU COMPTE : un employé du salon B ne doit
  // pas avoir à porter un paramètre (et un paramètre qui vise un autre salon reste refusé).
  const ctx = await loadCtx(c.req.query('loc') || (user.locationId ?? env.demoSlug));
  if (user.locationId && user.locationId !== ctx.locId) throw Object.assign(new Error('Salon hors de ton périmètre'), { status: 403 });
  return { ctx, user };
}

adminApi.get('/today', async (c) => {
  const { ctx } = await requireAdmin(c);
  const q = db();
  const day = c.req.query('day') || todayDay();
  const { a, b } = { a: startOfDayMs(day), b: endOfDayMs(day) };
  const rows = await q.all<any>(
    `SELECT a.*, s.name AS service_name, c.first_name, c.last_name, c.phone, c.noshow_count, c.tags, st.name AS staff_name, st.color_hex
     FROM appointments a JOIN services s ON s.id=a.service_id JOIN customers c ON c.id=a.customer_id JOIN staff st ON st.id=a.staff_id
     WHERE a.location_id = :l AND a.start_ts >= :s AND a.start_ts < :e ORDER BY a.start_ts`,
    { l: ctx.locId, s: a, e: b },
  );
  const active = rows.filter((r: any) => !['cancelled', 'no_show'].includes(r.status));
  const revenue = rows.filter((r: any) => r.status === 'completed').reduce((acc: number, r: any) => acc + r.price_cents, 0);
  const now = Date.now();
  const next = active.find((r: any) => r.start_ts > now);
  const late = active.filter((r: any) => r.end_ts < now && !['completed'].includes(r.status));
  const freePerStaff = [];
  for (const s of ctx.staff) {
    const d = ctx.services[0]
      ? await computeDay(ctx, { serviceId: ctx.services[0].id, durationMin: ctx.services[0].base_duration_min + ctx.services[0].cleanup_min, prepMin: ctx.services[0].prep_min, cleanupMin: ctx.services[0].cleanup_min, day, now, staffIds: [s.id], window: null, respectStep: false })
      : null;
    freePerStaff.push({ staff: s.name, color: s.color_hex, free: d?.slots.length ?? 0, next: d?.slots[0]?.start ?? null, holes: d ? gapReport(d, 25).deadMinutes : 0 });
  }
  return c.json({
    day,
    counts: {
      total: rows.length,
      active: active.length,
      completed: rows.filter((r: any) => r.status === 'completed').length,
      cancelled: rows.filter((r: any) => r.status === 'cancelled').length,
      noShow: rows.filter((r: any) => r.status === 'no_show').length,
      needsConfirm: rows.filter((r: any) => r.confirm_required && !r.confirmed_ts).length,
      walkins: await q.num(`SELECT COUNT(*) FROM walkins WHERE location_id = :l AND status='waiting'`, { l: ctx.locId }),
      revenueCents: revenue,
      expectedCents: active.reduce((acc: number, r: any) => acc + r.price_cents, 0),
      lateMinutes: late.length,
    },
    next: next ? { id: next.id, when: humanWhen(next.start_ts), name: `${next.first_name} ${next.last_name ?? ''}`.trim(), service: next.service_name, staff: next.staff_name, phone: next.phone } : null,
    agenda: rows.map((r: any) => ({ ...shapeAppointment(r, ctx), firstName: r.first_name, lastName: r.last_name, phone: r.phone, color: r.color_hex, late: r.end_ts < now && r.status !== 'completed' })),
    freePerStaff,
    waitlist: await q.num(`SELECT COUNT(*) FROM waitlist WHERE location_id = :l AND status='active'`, { l: ctx.locId }),
    tasks: await requiresAction(ctx),
    realtime: await funnelRealtime(ctx),
  });
});

adminApi.get('/calendar', async (c) => {
  const { ctx } = await requireAdmin(c);
  const q = db();
  const mode = c.req.query('mode') || 'day';
  let from = c.req.query('from') || todayDay();
  if (mode === 'week') {
    const d = new Date(startOfDayMs(from));
    from = dayAdd(from, -((d.getUTCDay() + 6) % 7));
  }
  const count = mode === 'month' ? 35 : mode === 'week' ? 7 : 1;
  const days = await dayList(ctx, from, count);
  const a = startOfDayMs(days[0]);
  const b = endOfDayMs(days[days.length - 1]);
  const rows = await q.all<any>(
    `SELECT a.*, s.name AS service_name, c.first_name, c.last_name, c.phone, st.name AS staff_name
     FROM appointments a JOIN services s ON s.id=a.service_id JOIN customers c ON c.id=a.customer_id JOIN staff st ON st.id=a.staff_id
     WHERE a.location_id = :l AND a.start_ts >= :s AND a.start_ts < :e ORDER BY a.start_ts`,
    { l: ctx.locId, s: a, e: b },
  );
  const blocks = await q.all<any>(`SELECT * FROM blocks WHERE location_id = :l AND end_ts > :s AND start_ts < :e`, { l: ctx.locId, s: a, e: b });
  const perDay = [];
  for (const d of days) {
    const items = rows.filter((r: any) => dateKey(r.start_ts) === d);
    const perStaff = [];
    for (const st of ctx.staff) {
      const mine = items.filter((r: any) => r.staff_id === st.id);
      const day = ctx.services[0]
        ? await computeDay(ctx, { serviceId: ctx.services[0].id, durationMin: ctx.services[0].base_duration_min + 5, prepMin: ctx.services[0].prep_min, cleanupMin: ctx.services[0].cleanup_min, day: d, now: Date.now() - DAY, staffIds: [st.id], window: null, respectStep: false })
        : null;
      const g = day ? gapReport(day, 25) : { deadMinutes: 0, usableSlots: 0 };
      perStaff.push({ staff: st, appointments: mine.map((r: any) => ({ ...shapeAppointment(r, ctx), firstName: r.first_name, lastName: r.last_name, phone: r.phone })), free: day ? day.slots.map((s) => s.start) : [], deadMinutes: g.deadMinutes, usable: g.usableSlots });
    }
    perDay.push({ day: d, weekday: weekdayLabel(dow(startOfDayMs(d))), label: fmtDate(startOfDayMs(d), { short: true }), isToday: d === todayDay(), windows: (await Promise.all(ctx.staff.map((s) => staffDayWindows(ctx, s.id, d)))).map((w) => w.windows).flat(), blocks: blocks.filter((bl: any) => dateKey(bl.start_ts) === d).map((bl: any) => ({ id: bl.id, start: bl.start_ts, end: bl.end_ts, kind: bl.kind, reason: bl.reason, staffId: bl.staff_id })), perStaff, total: items.length, revenueCents: items.filter((r: any) => r.status === 'completed').reduce((acc: number, r: any) => acc + r.price_cents, 0) });
  }
  return c.json({ mode, days: perDay, staff: ctx.staff.map((s) => ({ id: s.id, name: s.name, color: s.color_hex })), policy: { slotStepMin: ctx.policy.slotStepMin } });
});

adminApi.post('/appointments', async (c) => {
  const { ctx, user } = await requireAdmin(c);
  const body = z
    .object({
      customerId: z.number().int().positive().optional(),
      name: z.string().max(60).optional(),
      phone: z.string().max(24).optional(),
      offeringId: z.number().int().positive(),
      addonIds: z.array(z.number()).max(6).default([]),
      start: z.number().int().positive(),
      staffId: z.number().int().positive().nullish(),
      note: z.string().max(400).optional(),
      skipPayment: z.boolean().optional(),
      isWalkin: z.boolean().optional(),
    })
    .parse(await c.req.json());
  const out = await adminQuickBook(ctx, { ...body, actorId: user.userId } as any);
  return c.json(out, 201);
});

adminApi.post('/appointments/:id/:action', async (c) => {
  const { ctx, user } = await requireAdmin(c);
  const id = Number(c.req.param('id'));
  const action = c.req.param('action');
  const body = await c.req.json().catch(() => ({}));
  switch (action) {
    case 'complete':
      return c.json(await completeBooking(ctx, id, { paidCents: body.paidCents, note: body.note, actorId: user.userId }));
    case 'cancel':
      return c.json(await cancelBooking(ctx, id, { by: 'staff', reason: body.reason ?? 'staff', releaseToWaitlist: body.replay !== false }));
    case 'no-show':
      return c.json(await markNoShow(ctx, id, 'staff'));
    case 'confirm':
      return c.json(await confirmBooking(ctx, id));
    case 'move': {
      if (!Number.isInteger(body.start)) return c.json({ error: 'start_requis' }, 422);
      const staffId = body.staffId ? Number(body.staffId) : undefined;
      const out = await rescheduleBooking({ ctx, appointmentId: id, actor: { type: 'staff', id: user.userId } }, Number(body.start), { staffId, reason: 'glissé depuis le planning' });
      return c.json(out);
    }
    case 'note': {
      await db().update('appointments', id, { internal_note: cleanText(body.note ?? '', 400), updated_ts: Date.now() });
      return c.json({ ok: true });
    }
    case 'remind': {
      await notify(ctx, 'reminder_h3', { appointmentId: id, customerId: (await db().one<any>(`SELECT customer_id FROM appointments WHERE id = :i`, { i: id }))?.customer_id, idem: `manual:remind:${id}:${Date.now()}` });
      const d = await dispatchNow(ctx, 40);
      return c.json({ ok: true, sent: d.sent });
    }
    default:
      return c.json({ error: 'action_inconnue' }, 400);
  }
});

adminApi.post('/blocks', async (c) => {
  const { ctx, user } = await requireAdmin(c);
  const body = z.object({ day: z.string(), staffId: z.number().int().positive().nullish(), from: z.number().int(), to: z.number().int(), kind: z.string().max(20).default('busy'), reason: z.string().max(120).optional() }).parse(await c.req.json());
  const start = startOfDayMs(body.day) + body.from * MIN;
  const end = startOfDayMs(body.day) + body.to * MIN;
  if (end <= start) return c.json({ error: 'plage_invalide' }, 422);
  const ids = [];
  for (const s of body.staffId ? [body.staffId] : ctx.staff.map((x) => x.id)) {
    ids.push(await db().insert('blocks', { location_id: ctx.locId, staff_id: s, start_ts: start, end_ts: end, kind: body.kind, reason: body.reason ?? null, created_ts: Date.now() }));
  }
  bumpAvailabilityCache();
  await audit(ctx.locId, 'owner', user.userId, 'block.create', 'blocks', ids[0] ?? null, { day: body.day, from: body.from, to: body.to });
  return c.json({ ok: true, ids });
});

adminApi.post('/blocks/:id/delete', async (c) => {
  const { ctx } = await requireAdmin(c);
  await db().del('blocks', Number(c.req.param('id')));
  bumpAvailabilityCache();
  return c.json({ ok: true });
});

adminApi.get('/waitlist', async (c) => {
  const { ctx } = await requireAdmin(c);
  const stats = await waitlistStats(ctx);
  const byDay: Record<string, number> = {};
  for (const e of stats.entries) for (const d of e.days) byDay[String(d)] = (byDay[String(d)] ?? 0) + 1;
  return c.json({ ...stats, byDay, labels: SEGMENT_LABEL });
});

adminApi.post('/waitlist/:id/:action', async (c) => {
  const { ctx, user } = await requireAdmin(c, 'manager');
  const id = Number(c.req.param('id'));
  const action = c.req.param('action');
  const q = db();
  const w = await q.one<any>(`SELECT * FROM waitlist WHERE id = :i AND location_id = :l`, { i: id, l: ctx.locId });
  if (!w) return c.json({ error: 'introuvable' }, 404);
  if (action === 'priority') {
    const body = z.object({ priority: z.number().int().min(-5).max(5) }).parse(await c.req.json());
    await q.update('waitlist', w.id, { priority: body.priority, updated_ts: Date.now() });
    return c.json({ ok: true });
  }
  if (action === 'close') {
    await closeWaitlistEntry(ctx, w.id, 'closed');
    return c.json({ ok: true });
  }
  if (action === 'offer') {
    const body = z.object({ start: z.number().int().positive(), staffId: z.number().int().positive(), end: z.number().int().positive().optional() }).parse(await c.req.json());
    if (!ctx.services[0] && !w.service_id) throw new BookingError('service_requis', 'Ce salon n’a pas encore de prestation publiée : impossible de proposer un créneau.', 409);
    const svcId = w.service_id ?? ctx.services[0].id;
    const svc = ctx.services.find((s) => s.id === svcId)!;
    const offId = w.offering_id ?? ctx.offerings.find((o) => o.service_id === svcId)!.id;
    const out = await replayWaitlist(ctx, { staffId: body.staffId, start: body.start, end: body.end ?? body.start + svc.base_duration_min * MIN, serviceId: svcId, offeringId: offId, reason: 'manuel' });
    await audit(ctx.locId, 'owner', user.userId, 'waitlist.manual_offer', 'waitlist', w.id, { start: body.start });
    return c.json(out);
  }
  if (action === 'book') {
    const body = z.object({ start: z.number().int().positive(), staffId: z.number().int().positive(), offeringId: z.number().int().positive().optional() }).parse(await c.req.json());
    const offId = body.offeringId ?? w.offering_id ?? ctx.offerings.find((o) => o.service_id === (w.service_id ?? ctx.services[0].id))!.id;
    const res = await createBooking({
      ctx,
      offeringId: offId,
      start: body.start,
      staffId: body.staffId,
      customer: { firstName: w.name.split(' ')[0] || 'Waitlist', lastName: w.name.split(' ').slice(1).join(' '), phone: w.phone, email: w.email ?? undefined },
      paymentMode: 'none',
      force: true,
      requireConfirm: false,
      source: 'waitlist',
      waitlistId: w.id,
      actor: { type: 'owner', id: user.userId },
    });
    await closeWaitlistEntry(ctx, w.id, 'fulfilled');
    return c.json(res, 201);
  }
  return c.json({ error: 'action_inconnue' }, 400);
});

adminApi.get('/queue', async (c) => {
  const { ctx } = await requireAdmin(c);
  const q = db();
  const rows = await q.all<any>(
    `SELECT a.*, c.first_name, c.last_name, c.phone, s.name AS service_name, st.name AS staff_name
     FROM appointments a JOIN customers c ON c.id=a.customer_id JOIN services s ON s.id=a.service_id JOIN staff st ON st.id=a.staff_id
     WHERE a.location_id = :l AND a.start_ts > :n AND a.status IN ('held','pending_payment','booked','confirmed','waiting_client','in_progress')
     ORDER BY a.start_ts LIMIT 80`,
    { l: ctx.locId, n: Date.now() - 2 * MIN },
  );
  const buckets: Record<string, any[]> = { NEW_REQUEST: [], WAITLIST: [], BOOKED: [], CONFIRMED: [], REQUIRES_ACTION: [] };
  for (const r of rows) {
    const key = r.status === 'pending_payment' ? 'NEW_REQUEST' : r.status === 'held' ? 'WAITLIST' : r.needs_action || (r.confirm_required && !r.confirmed_ts) ? 'REQUIRES_ACTION' : r.status === 'confirmed' ? 'CONFIRMED' : 'BOOKED';
    const expires = r.status === 'held' ? (await q.one<any>(`SELECT expires_ts FROM waitlist_offers WHERE appointment_id = :i`, { i: r.id }))?.expires_ts : null;
    buckets[key].push({ ...shapeAppointment(r, ctx), firstName: r.first_name, lastName: r.last_name, phone: r.phone, status: r.status, needsAction: !!r.needs_action, expires });
  }
  return c.json(buckets);
});

adminApi.get('/customers', async (c) => {
  const { ctx } = await requireAdmin(c);
  const term = c.req.query('q') || '';
  const seg = c.req.query('segment');
  const q = db();
  let rows;
  if (term.trim()) rows = await searchCustomers(ctx, term, 40);
  else rows = await q.all<any>(`SELECT id, first_name, last_name, phone, email, segment, visits_count, spent_cents, last_visit_ts, loyalty_points, noshow_count, tags, source FROM customers WHERE location_id = :l AND deleted_ts IS NULL ${seg ? 'AND segment = :seg' : ''} ORDER BY last_visit_ts DESC LIMIT 60`, { l: ctx.locId, ...(seg ? { seg } : {}) });
  const counts = await q.all<any>(`SELECT segment, COUNT(*) AS n FROM customers WHERE location_id = :l AND deleted_ts IS NULL GROUP BY segment`, { l: ctx.locId });
  return c.json({ rows: rows.map((r: any) => ({ ...r, tags: j<string[]>(r.tags, []), lastVisit: r.last_visit_ts ? humanDaysAgo(r.last_visit_ts) : null })), segments: counts.map((x: any) => ({ key: x.segment, label: SEGMENT_LABEL[x.segment] ?? x.segment, n: Number(x.n) })) });
});

adminApi.get('/customers/:id', async (c) => {
  const { ctx } = await requireAdmin(c);
  const card = await customerCard(ctx, Number(c.req.param('id')));
  if (!card) return c.json({ error: 'introuvable' }, 404);
  return c.json(card);
});

adminApi.post('/customers/:id', async (c) => {
  const { ctx, user } = await requireAdmin(c, 'manager');
  const id = Number(c.req.param('id'));
  const body = z.object({ notes: z.string().max(800).optional(), tags: z.array(z.string().max(24)).max(12).optional(), preferredStaffId: z.number().int().positive().nullish(), consentMarketingEmail: z.boolean().optional(), consentMarketingSms: z.boolean().optional(), addPoints: z.number().int().min(-500).max(500).optional() }).parse(await c.req.json());
  const q = db();
  const patch: any = { updated_ts: Date.now() };
  if (body.notes !== undefined) patch.notes = cleanText(body.notes, 800);
  if (body.tags !== undefined) patch.tags = sj(body.tags);
  if (body.preferredStaffId !== undefined) patch.preferred_staff_id = body.preferredStaffId;
  if (body.consentMarketingEmail !== undefined) patch.consent_marketing_email = body.consentMarketingEmail ? 1 : 0;
  if (body.consentMarketingSms !== undefined) patch.consent_marketing_sms = body.consentMarketingSms ? 1 : 0;
  await q.update('customers', id, patch);
  if (body.addPoints) {
    const { grantPoints } = await import('./domain/loyalty.ts');
    await grantPoints(ctx, id, body.addPoints, 'ajustement_admin', 'Ajustement manuel');
  }
  await refreshSegment(id);
  await audit(ctx.locId, 'owner', user.userId, 'customer.update', 'customers', id, body);
  return c.json({ ok: true });
});

adminApi.get('/search', async (c) => {
  const { ctx } = await requireAdmin(c);
  const term = (c.req.query('q') || '').trim();
  if (term.length < 2) return c.json({ customers: [], appointments: [], services: [] });
  const q = db();
  const digits = term.replace(/\D/g, '');
  const like = `%${term.toLowerCase()}%`;
  const customers = await q.all<any>(`SELECT id, first_name, last_name, phone, email, segment FROM customers WHERE location_id = :l AND (lower(first_name) LIKE :k OR lower(last_name) LIKE :k OR lower(coalesce(email,'')) LIKE :k OR replace(coalesce(phone,''),' ','') LIKE :d) LIMIT 8`, { l: ctx.locId, k: like, d: `%${digits}%` });
  const appointments = await q.all<any>(
    `SELECT a.id, a.start_ts, a.status, c.first_name, c.last_name, s.name AS service, st.name AS staff
     FROM appointments a JOIN customers c ON c.id=a.customer_id JOIN services s ON s.id=a.service_id JOIN staff st ON st.id=a.staff_id
     WHERE a.location_id = :l AND a.start_ts > :n AND (lower(c.first_name) LIKE :k OR lower(c.last_name) LIKE :k) ORDER BY a.start_ts LIMIT 8`,
    { l: ctx.locId, n: Date.now() - DAY, k: like },
  );
  return c.json({ customers, appointments, services: ctx.services.filter((s) => s.name.toLowerCase().includes(term.toLowerCase()) || s.key.includes(term.toLowerCase())).slice(0, 6) });
});

adminApi.get('/analytics/:report', async (c) => {
  const { ctx } = await requireAdmin(c);
  const r = c.req.param('report');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const days = Number(c.req.query('days') || 30);
  switch (r) {
    case 'kpis':
      return c.json(await kpis(ctx, from, to));
    case 'funnel':
      return c.json(await funnel(ctx, from, to));
    case 'sources':
      return c.json(await bySource(ctx, days));
    case 'revenue':
      return c.json(await revenueSeries(ctx, days));
    case 'services':
      return c.json(await revenueByService(ctx, days));
    case 'staff':
      return c.json(await revenueByStaff(ctx, days));
    case 'heatmap':
      return c.json(await demandHeatmap(ctx, Number(c.req.query('weeks') || 6)));
    case 'capacity':
      return c.json(await capacityReport(ctx, days));
    case 'forecast':
      return c.json(await forecast(ctx, days));
    case 'recommendations':
      return c.json(await recommendations(ctx));
    case 'customers-value':
      return c.json(await customerValue(ctx, days));
    case 'at-risk':
      return c.json(await atRisk(ctx, days));
    case 'realtime':
      return c.json(await funnelRealtime(ctx));
    case 'observability':
      return c.json(await observability(ctx));
    default:
      return c.json({ error: 'rapport_inconnu' }, 404);
  }
});

adminApi.get('/automations', async (c) => {
  const { ctx } = await requireAdmin(c);
  const list = await listAutomations(ctx);
  const outbox = await outboxStats(ctx);
  const templates = await db().all<any>(`SELECT key, channel, body_text, updated_ts FROM templates WHERE location_id = :l ORDER BY key`, { l: ctx.locId });
  return c.json({ automations: list, outbox, templates });
});

adminApi.post('/automations/:key', async (c) => {
  const { ctx, user } = await requireAdmin(c, 'manager');
  const body = z.object({ is_active: z.boolean().optional(), config: z.record(z.any()).optional(), cooldown_hours: z.number().int().min(0).max(2400).optional(), max_per_week: z.number().int().min(0).max(40).optional(), quiet_hours: z.object({ from: z.string(), to: z.string() }).optional(), requires_owner_approval: z.boolean().optional() }).parse(await c.req.json());
  await updateAutomation(ctx, c.req.param('key'), body as any);
  return c.json({ ok: true });
});

adminApi.post('/templates', async (c) => {
  const { ctx, user } = await requireAdmin(c, 'manager');
  const body = z.object({ key: z.string().max(40), channel: z.enum(['sms', 'email', 'whatsapp', 'web']), subject: z.string().max(120).optional(), body_text: z.string().min(4).max(2000) }).parse(await c.req.json());
  const q = db();
  const existing = await q.one<any>(`SELECT id FROM templates WHERE location_id = :l AND key = :k AND channel = :c`, { l: ctx.locId, k: body.key, c: body.channel });
  const row = { key: body.key, channel: body.channel, lang: 'fr', subject: body.subject ?? null, body_text: body.body_text, is_active: 1, updated_ts: Date.now() };
  if (existing) await q.update('templates', existing.id, row);
  else await q.insert('templates', { location_id: ctx.locId, ...row });
  await audit(ctx.locId, 'owner', user.userId, 'template.update', 'templates', existing?.id ?? null, body);
  return c.json({ ok: true });
});

adminApi.get('/notifications', async (c) => {
  const { ctx } = await requireAdmin(c);
  const rows = await db().all<any>(`SELECT n.*, c.first_name, c.last_name FROM notifications n LEFT JOIN customers c ON c.id = n.customer_id WHERE n.location_id = :l ORDER BY n.id DESC LIMIT 120`, { l: ctx.locId });
  return c.json(rows);
});

adminApi.post('/notifications/:id/resend', async (c) => {
  const { ctx, user } = await requireAdmin(c, 'manager');
  const id = Number(c.req.param('id'));
  await db().update('notifications', id, { status: 'queued', send_ts: Date.now(), sent_ts: null, error: null });
  const d = await dispatchNow(ctx, 40);
  await audit(ctx.locId, 'owner', user.userId, 'notification.resend', 'notifications', id, d);
  return c.json({ ok: true, ...d });
});

adminApi.get('/settings', async (c) => {
  const { ctx, user } = await requireAdmin(c, 'manager');
  const q = db();
  return c.json({
    location: {
      id: ctx.locId,
      slug: ctx.slug,
      name: ctx.loc.name,
      legal_name: ctx.loc.legal_name,
      phone: ctx.loc.phone,
      email: ctx.loc.email,
      brand: ctx.brand,
      address: ctx.address,
      hours: ctx.hours,
      holidays: Object.entries(ctx.holidays).map(([day, name]) => ({ day, name })),
      policy: ctx.policy,
      features: ctx.features,
      currency: ctx.loc.currency,
    },
    staff: await Promise.all(
      (await q.all<any>('SELECT * FROM staff WHERE location_id = :l ORDER BY display_order, id', { l: ctx.locId })).map(async (s) => ({
        ...s,
        service_ids: (await q.all<any>('SELECT service_id FROM staff_skills WHERE staff_id = :i', { i: s.id })).map(x => x.service_id),
        hours: await q.all<any>(`SELECT * FROM working_hours WHERE staff_id = :i`, { i: s.id }),
        breaks: await q.all<any>(`SELECT * FROM shift_breaks WHERE staff_id = :i`, { i: s.id }),
      })),
    ),
    services: await q.all<any>(`SELECT * FROM services WHERE location_id = :l ORDER BY display_order`, { l: ctx.locId }),
    addons: ctx.addons,
    offerings: ctx.offerings,
    loyalty: await loyaltyConfig(ctx),
    onboarding: await q.one<any>(`SELECT * FROM onboarding WHERE location_id = :l ORDER BY id DESC LIMIT 1`, { l: ctx.locId }),
    me: user,
  });
});

adminApi.post('/settings/drafts', async (c) => {
  const { ctx } = await requireAdmin(c, 'owner');
  const { prepareDraftCatalogue } = await import('./seed/drafts.ts');
  const result = await prepareDraftCatalogue(ctx.locId); invalidateCtx();
  return c.json(result);
});
adminApi.post('/account/password', async (c) => {
  const { user } = await requireAdmin(c, 'owner');
  const body = z.object({ currentPassword: z.string().max(200), password: z.string().min(12).max(200) }).parse(await c.req.json());
  const { verifyPassword } = await import('./lib/secrets.ts');
  const u = await db().one<any>('SELECT password_hash FROM users WHERE id = :i', { i: user.userId });
  if (!u || !verifyPassword(body.currentPassword, u.password_hash)) return c.json({ error: 'identifiants', message: 'Mot de passe actuel incorrect.' }, 403);
  await setPasswordForUser(user.userId, body.password);
  await db().exec('UPDATE sessions SET revoked_ts = :n WHERE user_id = :u AND id != :s', { n: Date.now(), u: user.userId, s: user.sessionId });
  return c.json({ ok: true });
});

adminApi.post('/settings', async (c) => {
  const { ctx, user } = await requireAdmin(c, 'owner');
  const body = z
    .object({
      brand: z.record(z.any()).optional(),
      address: z.record(z.any()).optional(),
      hours: z.record(z.any()).optional(),
      policy: z.record(z.any()).optional(),
      features: z.record(z.any()).optional(),
      holidays: z.array(z.object({ day: z.string(), name: z.string() })).optional(),
      name: z.string().max(80).optional(),
      phone: z.string().max(30).optional(),
      email: z.string().max(80).optional(),
    })
    .parse(await c.req.json());
  const q = db();
  const loc = await q.one<any>(`SELECT * FROM locations WHERE id = :i`, { i: ctx.locId });
  const patch: any = { updated_ts: Date.now() };
  if (body.brand) patch.brand_json = sj({ ...j(loc.brand_json, {}), ...body.brand });
  if (body.address) patch.address_json = sj({ ...j(loc.address_json, {}), ...body.address });
  if (body.hours) { patch.hours_json = sj(body.hours); patch.brand_json = sj({ ...j(loc.brand_json, {}), ...body.brand, hoursConfirmed: true }); }
  if (body.policy) patch.policy_json = sj({ ...j(loc.policy_json, {}), ...body.policy });
  if (body.features) patch.features_json = sj({ ...j(loc.features_json, {}), ...body.features });
  if (body.holidays) patch.holidays_json = sj(body.holidays);
  if (body.name) patch.name = cleanText(body.name, 80);
  if (body.phone) patch.phone = cleanText(body.phone, 30);
  if (body.email) patch.email = normalizeEmail(body.email);
  await q.update('locations', ctx.locId, patch);
  invalidateCtx();
  bumpAvailabilityCache();
  await audit(ctx.locId, 'owner', user.userId, 'settings.update', 'locations', ctx.locId, Object.keys(body));
  return c.json({ ok: true });
});

adminApi.post('/staff', async (c) => {
  const { ctx, user } = await requireAdmin(c, 'owner');
  const body = z.object({ id: z.number().int().optional(), name: z.string().min(2).max(50), title: z.string().max(50).optional(), bio: z.string().max(600).optional(), color: z.string().max(9).optional(), serviceIds: z.array(z.number()).max(40).optional(), active: z.boolean().optional(), acceptNewClients: z.boolean().optional(), hours: z.array(z.object({ dow: z.number(), start: z.string(), end: z.string() })).optional(), breaks: z.array(z.object({ dow: z.number(), start: z.string(), end: z.string() })).optional() }).parse(await c.req.json());
  const q = db();
  const previous = body.id ? await q.one<any>('SELECT * FROM staff WHERE id = :i AND location_id = :l', { i: body.id, l: ctx.locId }) : null;
  if (body.id && !previous) return c.json({ error: 'introuvable' }, 404);
  const id = body.id ?? (await q.insert('staff', { location_id: ctx.locId, name: cleanText(body.name, 50), slug: body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), title: body.title ?? null, bio: body.bio ?? null, color_hex: body.color ?? '#E8C98A', is_active: body.active === false ? 0 : 1, accept_new_clients: body.acceptNewClients === false ? 0 : 1, display_order: 99, created_ts: Date.now() }));
  if (body.id) await q.update('staff', body.id, { name: cleanText(body.name, 50), title: body.title ?? previous?.title ?? null, bio: body.bio ?? previous?.bio ?? null, color_hex: body.color ?? previous?.color_hex, is_active: body.active === undefined ? previous?.is_active : body.active ? 1 : 0, accept_new_clients: body.acceptNewClients === undefined ? previous?.accept_new_clients : body.acceptNewClients ? 1 : 0 });
  /* Les compétences ne sont réécrites QUE si le client les envoie. Zéro par défaut aurait voulu
     dire : le simple fait de désactiver un barbier (ou d'éditer ses horaires) effaçait ses
     prestations et ses prix différenciés. Un `PATCH` ne détruit pas ce qu'on tait. */
  if ('serviceIds' in body) {
    await q.exec(`DELETE FROM staff_skills WHERE staff_id = :i`, { i: id });
    for (const sid of body.serviceIds ?? []) await q.insert('staff_skills', { staff_id: id, service_id: sid, price_cents: null, duration_min: null, level: null });
  }
  if (body.hours) {
    await q.exec(`DELETE FROM working_hours WHERE staff_id = :i`, { i: id });
    for (const h of body.hours) await q.insert('working_hours', { location_id: ctx.locId, staff_id: id, dow: h.dow, start_min: hhmmToMin(h.start), end_min: hhmmToMin(h.end) });
  }
  if (body.breaks) {
    await q.exec(`DELETE FROM shift_breaks WHERE staff_id = :i`, { i: id });
    for (const h of body.breaks) await q.insert('shift_breaks', { location_id: ctx.locId, staff_id: id, dow: h.dow, start_min: hhmmToMin(h.start), end_min: hhmmToMin(h.end), label: 'Pause' });
  }
  invalidateCtx();
  bumpAvailabilityCache();
  await audit(ctx.locId, 'owner', user.userId, 'staff.upsert', 'staff', id, body);
  return c.json({ ok: true, id });
});

adminApi.post('/services', async (c) => {
  const { ctx, user } = await requireAdmin(c, 'owner');
  const body = z
    .object({
      id: z.number().int().optional(),
      key: z.string().max(40).optional(),
      name: z.string().min(2).max(60),
      category: z.string().max(30).default('coupe'),
      shortDesc: z.string().max(160).optional(),
      description: z.string().max(1200).optional(),
      priceCents: z.number().int().min(0).max(200000),
      durationMin: z.number().int().min(5).max(360),
      prepMin: z.number().int().min(0).max(60).default(0),
      cleanupMin: z.number().int().min(0).max(60).default(5),
      active: z.boolean().optional(),
      popular: z.boolean().optional(),
      bundleAddons: z.array(z.number()).max(8).default([]),
      problem: z.string().max(300).optional(),
      solution: z.string().max(300).optional(),
      staffIds: z.array(z.number()).max(10).optional(),
      faq: z.array(z.object({ q: z.string().max(200), a: z.string().max(600) })).max(8).optional(),
    })
    .parse(await c.req.json());
  const q = db();
  const key = body.key ?? body.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const row = {
    key,
    name: cleanText(body.name, 60),
    category: body.category,
    short_desc: body.shortDesc ?? null,
    description: body.description ?? null,
    base_price_cents: body.priceCents,
    base_duration_min: body.durationMin,
    prep_min: body.prepMin,
    cleanup_min: body.cleanupMin,
    problem: body.problem ?? null,
    solution: body.solution ?? null,
    faq_json: sj(body.faq ?? []),
    is_active: body.active === false ? 0 : 1,
    updated_ts: Date.now(),
  };
  if (body.id && !await q.one('SELECT id FROM services WHERE id = :i AND location_id = :l', { i: body.id, l: ctx.locId })) return c.json({ error: 'introuvable' }, 404);
  let serviceId = body.id;
  if (serviceId) await q.update('services', serviceId, row);
  else serviceId = await q.insert('services', { location_id: ctx.locId, level: 'tous', age: 'adulte', gender: 'm', display_order: 99, seo_title: `${row.name} — ${ctx.address.city ?? ''}`, seo_desc: row.short_desc, ...row });
  const bundleDuration = body.durationMin + body.bundleAddons.reduce((acc, id) => acc + (ctx.addons.find((a: any) => a.id === id)?.duration_min ?? 0), 0);
  const bundlePrice = body.priceCents + body.bundleAddons.reduce((acc, id) => acc + (ctx.addons.find((a: any) => a.id === id)?.price_cents ?? 0), 0);
  const off = await q.one<any>(`SELECT id FROM offerings WHERE location_id = :l AND service_id = :s AND staff_id IS NULL`, { l: ctx.locId, s: serviceId });
  const offPatch = { name: row.name, description: row.short_desc, duration_min: bundleDuration, price_cents: bundlePrice, addon_ids: sj(body.bundleAddons), is_popular: body.popular ? 1 : 0, is_active: body.active === false ? 0 : 1, updated_ts: Date.now() };
  if (off) await q.update('offerings', off.id, offPatch);
  else await q.insert('offerings', { location_id: ctx.locId, service_id: serviceId, staff_id: null, display_order: 99, ...offPatch });
  if (body.staffIds) {
    await q.exec(`DELETE FROM staff_skills WHERE staff_id IN (SELECT id FROM staff WHERE location_id = :l) AND service_id = :s`, { l: ctx.locId, s: serviceId });
    for (const sid of body.staffIds) await q.insert('staff_skills', { staff_id: sid, service_id: serviceId, price_cents: null, duration_min: null, level: null });
  }
  invalidateCtx();
  bumpAvailabilityCache();
  await audit(ctx.locId, 'owner', user.userId, 'service.upsert', 'services', serviceId, body);
  return c.json({ ok: true, id: serviceId });
});

adminApi.get('/campaigns', async (c) => {
  const { ctx } = await requireAdmin(c);
  return c.json({ campaigns: await listCampaigns(ctx), fields: SEGMENT_FIELDS });
});

adminApi.post('/campaigns', async (c) => {
  const { ctx, user } = await requireAdmin(c, 'manager');
  const body = z.object({ name: z.string().min(3).max(80), kind: z.string().max(30).optional(), segment: z.array(z.object({ field: z.string(), op: z.string(), value: z.any() })).default([]), templateKey: z.string().max(40), channel: z.enum(['sms', 'email']).default('sms'), offerText: z.string().max(300).optional(), scheduledTs: z.number().int().positive().nullish() }).parse(await c.req.json());
  return c.json(await createCampaign(ctx, body as any), 201);
});

adminApi.post('/campaigns/:id/:action', async (c) => {
  const { ctx, user } = await requireAdmin(c, 'manager');
  const id = Number(c.req.param('id'));
  const action = c.req.param('action');
  if (action === 'preview') return c.json(await previewSegment(ctx, j((await db().one<any>(`SELECT segment_json FROM campaigns WHERE id = :i`, { i: id }))?.segment_json, [])));
  if (action === 'approve') return c.json(await approveCampaign(ctx, id, user.userId));
  if (action === 'stats') return c.json(await campaignStats(ctx, id));
  if (action === 'cancel') {
    await db().update('campaigns', id, { status: 'cancelled', updated_ts: Date.now() });
    return c.json({ ok: true });
  }
  return c.json({ error: 'action_inconnue' }, 400);
});

adminApi.get('/reviews', async (c) => {
  const { ctx } = await requireAdmin(c);
  const rows = await db().all<any>(
    `SELECT r.*, c.first_name, c.last_name, c.phone, s.name AS service, st.name AS staff FROM reviews r
     LEFT JOIN customers c ON c.id = r.customer_id LEFT JOIN services s ON s.id = r.service_id LEFT JOIN staff st ON st.id = r.staff_id
     WHERE r.location_id = :l ORDER BY r.created_ts DESC LIMIT 60`,
    { l: ctx.locId },
  );
  return c.json({ rows: rows.map((r: any) => ({ ...r, appointmentLabel: r.appointment_id ? `RDV #${r.appointment_id}` : null })), stats: await reviewStats(ctx), pending: (await requiresAction(ctx)).pending });
});

adminApi.post('/reviews/:id/reply', async (c) => {
  const { ctx, user } = await requireAdmin(c, 'manager');
  const body = z.object({ text: z.string().min(2).max(600) }).parse(await c.req.json());
  await replyToReview(ctx, Number(c.req.param('id')), cleanText(body.text, 600));
  await audit(ctx.locId, 'owner', user.userId, 'review.reply', 'reviews', Number(c.req.param('id')), {});
  return c.json({ ok: true });
});

adminApi.get('/referrals', async (c) => {
  const { ctx } = await requireAdmin(c);
  return c.json({ leaderboard: await referralLeaderboard(ctx), totals: await db().all<any>(`SELECT status, COUNT(*) AS n FROM referrals WHERE location_id = :l GROUP BY status`, { l: ctx.locId }) });
});

adminApi.get('/gift-cards', async (c) => {
  const { ctx } = await requireAdmin(c);
  return c.json(await db().all<any>(`SELECT * FROM gift_cards WHERE location_id = :l ORDER BY created_ts DESC LIMIT 50`, { l: ctx.locId }));
});

adminApi.post('/gift-cards', async (c) => {
  const { ctx, user } = await requireAdmin(c, 'manager');
  const body = z.object({ amountCents: z.number().int().min(1000).max(50000), buyerName: z.string().max(60), buyerEmail: z.string().email(), recipientName: z.string().max(60).optional(), message: z.string().max(300).optional(), sendAt: z.number().int().optional(), serviceId: z.number().int().nullish() }).parse(await c.req.json());
  return c.json(await buyGiftCard(ctx, { ...body, serviceId: body.serviceId ?? null, pay: env.payments !== 'off' }), 201);
});

adminApi.get('/walkins', async (c) => {
  const { ctx } = await requireAdmin(c);
  return c.json(await db().all<any>(`SELECT * FROM walkins WHERE location_id = :l AND status IN ('waiting','seated') ORDER BY queue_rank`, { l: ctx.locId }));
});
adminApi.post('/walkins', async (c) => {
  const { ctx } = await requireAdmin(c);
  const body = z.object({ name: z.string().max(60), phone: z.string().max(24).optional(), serviceId: z.number().int().optional(), staffId: z.number().int().nullish() }).parse(await c.req.json());
  const q = db();
  const rank = (await q.num(`SELECT COUNT(*) FROM walkins WHERE location_id = :l AND status='waiting'`, { l: ctx.locId })) + 1;
  const id = await q.insert('walkins', { location_id: ctx.locId, name: cleanText(body.name, 60), phone: body.phone ?? null, service_id: body.serviceId ?? null, staff_id: body.staffId ?? null, status: 'waiting', queue_rank: rank, eta_min: rank * 15, token: signToken({ wi: 0, k: 'walkin' }), created_ts: Date.now() });
  return c.json({ id, rank, etaMin: rank * 15 });
});
adminApi.post('/walkins/:id/:action', async (c) => {
  const { ctx } = await requireAdmin(c);
  const id = Number(c.req.param('id'));
  const action = c.req.param('action');
  const q = db();
  if (action === 'seat') await q.update('walkins', id, { status: 'seated', seated_ts: Date.now() });
  if (action === 'done') await q.update('walkins', id, { status: 'done', done_ts: Date.now() });
  if (action === 'book') {
    const w = await q.one<any>(`SELECT * FROM walkins WHERE id = :i`, { i: id });
    if (!ctx.services[0]) return c.json({ error: 'service_requis', message: 'Aucune prestation publiée pour ce salon.' }, 409);
    const svc = ctx.services.find((s) => s.id === (w.service_id ?? ctx.services[0].id))!;
    const now = Date.now() + 2 * MIN;
    const d = await computeDay(ctx, { serviceId: svc.id, durationMin: svc.base_duration_min + svc.cleanup_min, prepMin: svc.prep_min, cleanupMin: svc.cleanup_min, day: dateKey(now), now: now - 60_000, staffIds: ctx.staff.map((s) => s.id), window: null, respectStep: false });
    const slot = d.slots[0];
    if (!slot) return c.json({ error: 'aucun créneau libre' }, 409);
    const out = await adminQuickBook(ctx, { name: w.name, phone: w.phone ?? '', offeringId: ctx.offerings.find((o) => o.service_id === svc.id)!.id, start: slot.start, staffId: slot.staffIds[0], skipPayment: true, isWalkin: true });
    await q.update('walkins', id, { status: 'booked', done_ts: Date.now() });
    return c.json(out);
  }
  return c.json({ ok: true });
});

adminApi.post('/tasks/:id/:decision', async (c) => {
  const { ctx, user } = await requireAdmin(c, 'manager');
  await resolvePendingAction(ctx, Number(c.req.param('id')), c.req.param('decision') === 'approve', user.userId);
  return c.json({ ok: true });
});

adminApi.post('/assistant/ask', async (c) => {
  const { ctx } = await requireAdmin(c);
  const body = z.object({ question: z.string().min(2).max(400) }).parse(await c.req.json());
  const t0 = Date.now();
  const answer = await askAssistant(ctx, body.question);
  await observe('assistant', answer.intent, Date.now() - t0, 'ok', {}, ctx.locId);
  return c.json({ ...answer, parsed: parseQuery(body.question, ctx) });
});

adminApi.post('/assistant/confirm', async (c) => {
  const { ctx, user } = await requireAdmin(c, 'manager');
  const body = z.object({ token: z.string().min(10) }).parse(await c.req.json());
  const out = await confirmAndRun(ctx, body.token, user.userId);
  return c.json(out);
});

adminApi.get('/media', async (c) => {
  const { ctx } = await requireAdmin(c);
  return c.json(await db().all<any>(`SELECT * FROM media WHERE location_id = :l ORDER BY ts DESC LIMIT 60`, { l: ctx.locId }));
});

adminApi.post('/media', async (c) => {
  const { ctx, user } = await requireAdmin(c, 'manager');
  const body = z.object({ path: z.string().max(300), alt: z.string().max(200).optional(), label: z.string().max(80).optional(), serviceKey: z.string().max(40).optional(), kind: z.string().max(20).default('photo'), priceCents: z.number().int().min(0).optional(), durationMin: z.number().int().min(0).optional(), aspect: z.string().max(10).optional() }).parse(await c.req.json());
  if (!/^(\/|https:\/\/)/.test(body.path)) return c.json({ error: 'chemin_invalide' }, 422);
  const id = await db().insert('media', { location_id: ctx.locId, path: body.path, alt: body.alt ?? null, kind: body.kind, label: body.label ?? null, service_key: body.serviceKey ?? null, price_cents: body.priceCents ?? null, duration_min: body.durationMin ?? null, before_after: 0, aspect: body.aspect ?? '4/5', ts: Date.now(), like_count: 0 });
  await audit(ctx.locId, 'owner', user.userId, 'media.create', 'media', id, body);
  return c.json({ id });
});
adminApi.post('/media/:id/delete', async (c) => {
  const { ctx } = await requireAdmin(c, 'manager');
  await db().del('media', Number(c.req.param('id')));
  return c.json({ ok: true });
});

adminApi.get('/onboarding', async (c) => {
  const { ctx } = await requireAdmin(c);
  const q = db();
  const done = new Set<string>((await q.all<any>(`SELECT step FROM onboarding WHERE location_id = :l`, { l: ctx.locId })).map((r: any) => r.step));
  const steps = [
    { key: 'identity', label: 'Nom, adresse, réseaux', ok: !!ctx.brand.name && !!ctx.address.street },
    { key: 'services', label: 'Prestations et prix', ok: ctx.services.length >= 3 },
    { key: 'hours', label: 'Horaires et pauses', ok: (await q.num(`SELECT COUNT(*) FROM working_hours WHERE location_id = :l`, { l: ctx.locId })) > 0 },
    { key: 'staff', label: 'Équipe et compétences', ok: ctx.staff.length > 0 && (await q.num(`SELECT COUNT(*) FROM staff_skills ss JOIN staff st ON st.id = ss.staff_id WHERE st.location_id = :l`, { l: ctx.locId })) > 0 },
    { key: 'policy', label: 'Acompte, annulation, rappels', ok: Object.keys(j(ctx.loc.policy_json, {})).length > 3 },
    { key: 'automations', label: 'Automatisations actives', ok: (await q.num(`SELECT COUNT(*) FROM automations WHERE location_id = :l AND is_active = 1`, { l: ctx.locId })) >= 6 },
    { key: 'notifications', label: 'Template et expéditeur prêts', ok: (await q.num(`SELECT COUNT(*) FROM templates WHERE location_id = :l`, { l: ctx.locId })) >= 5 },
    { key: 'booking', label: 'Premier créneau proposé au public', ok: !!ctx.services[0] && (await nextAvailable(ctx, { serviceId: ctx.services[0].id, durationMin: ctx.services[0].base_duration_min, prepMin: 0, cleanupMin: 5, staffIds: ctx.staff.map((s) => s.id) })) != null },
  ];
  return c.json({ steps, progress: steps.filter((s) => s.ok).length, total: steps.length });
});
adminApi.post('/onboarding/:step', async (c) => {
  const { ctx } = await requireAdmin(c);
  await db().insert('onboarding', { location_id: ctx.locId, step: c.req.param('step'), done_json: sj({ at: Date.now() }), ts: Date.now() });
  return c.json({ ok: true });
});

/* ══════════════════════════════════════════════════════════════════
   Interne : cron (Vercel Cron), webhooks, master SaaS
   ══════════════════════════════════════════════════════════════════ */

export const internalApi = new Hono();

/* Vercel Cron déclenche les tâches en **GET** (et GitHub Actions aussi, si on utilise `curl`).
   Ne servir que POST faisait échouer silencieusement tous les automatisations en production : le
   tick répondait 404, rien n'était alarmé, et le salon ne recevait plus ni rappel ni offre waitlist.
   GET et POST partagent exactement le même corps. */
internalApi.get('/cron', runCron);
internalApi.post('/cron', runCron);
async function runCron(c: Context) {
  const secret = c.req.header('x-cron-secret') || c.req.header('authorization')?.replace('Bearer ', '') || c.req.query('secret');
  if (!safeEqual(String(secret ?? ''), env.cronSecret)) return c.json({ error: 'forbidden' }, 403);
  const t0 = Date.now();
  const out: any[] = [];
  const slugs = await db().all<any>(`SELECT slug FROM locations WHERE plan_status = 'active'`);
  for (const s of slugs.slice(0, 20)) {
    try {
      const ctx = await loadCtx(s.slug);
      out.push({ slug: s.slug, ...(await tick({ ctx, full: Number(process.env.CRON_FULL_EVERY_MIN ?? 60) ? true : false })) });
    } catch (e: any) {
      const msg = String(e.message).slice(0, 160);
      console.error(`[cron] salon ${s.slug} :`, e?.stack ?? msg);
      await observe('cron', 'tick:error', null, 'error', { slug: s.slug, error: msg });
      out.push({ slug: s.slug, error: msg });
    }
  }
  const tickFailed = out.some((o) => o.error);
  await observe('cron', 'tick', Date.now() - t0, tickFailed ? 'error' : 'ok', {
    locations: out.length,
    ...(tickFailed ? { failed: out.filter((o) => o.error).map((o) => o.slug) } : {}),
  });
  return c.json({ ok: true, ms: Date.now() - t0, out });
}

internalApi.post('/webhooks/stripe', async (c) => {
  const raw = await c.req.text();
  const sig = c.req.header('stripe-signature') ?? '';
  try {
    return c.json(await (await import('./domain/payments.ts')).handleStripeWebhook(raw, sig));
  } catch (e: any) {
    await observe('payment', 'webhook', null, 'error', { error: String(e.message) });
    return c.json({ error: 'webhook_rejeté' }, 400);
  }
});

export const masterApi = new Hono();
async function requireMaster(c: Context) {
  const user = await readSession(c.req);
  if (!user || user.role !== 'owner') throw Object.assign(new Error('Accès plateforme requis'), { status: 403 });
  return user;
}
masterApi.get('/tenants', async (c) => {
  await requireMaster(c);
  const rows = await db().all<any>(`SELECT l.id, l.slug, l.name, l.plan_status, t.plan, t.name AS tenant FROM locations l JOIN tenants t ON t.id = l.tenant_id ORDER BY l.id`);
  const stats = [];
  for (const r of rows) {
    stats.push({ ...r, customers: await db().num(`SELECT COUNT(*) FROM customers WHERE location_id = :i`, { i: r.id }), appointments30: await db().num(`SELECT COUNT(*) FROM appointments WHERE location_id = :i AND start_ts > :n`, { i: r.id, n: Date.now() - 30 * DAY }), revenue30: await db().num(`SELECT COALESCE(SUM(price_cents),0) FROM appointments WHERE location_id = :i AND status='completed' AND start_ts > :n`, { i: r.id, n: Date.now() - 30 * DAY }) });
  }
  return c.json(stats);
});
masterApi.post('/locations', async (c) => {
  await requireMaster(c);
  const body = z.object({ name: z.string().min(2).max(80), slug: z.string().max(40).optional(), tenantName: z.string().max(80).optional(), plan: z.enum(['free', 'pro', 'premium']).default('pro') }).parse(await c.req.json());
  const q = db();
  const tenantId = await q.insert('tenants', { name: body.tenantName ?? body.name, plan: body.plan, status: 'active', created_ts: Date.now() });
  const slug = (body.slug ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 40);
  const id = await q.insert('locations', { tenant_id: tenantId, slug, name: cleanText(body.name, 80), brand_json: sj({ name: body.name }), address_json: sj({}), hours_json: sj({}), policy_json: sj({}), features_json: sj({}), holidays_json: sj([]), created_ts: Date.now(), updated_ts: Date.now() });
  return c.json({ id, slug }, 201);
});

function pageShell(title: string, body: string) {
  return pageResult(title, body);
}
void pageShell;
