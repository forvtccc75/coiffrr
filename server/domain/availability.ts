import { db } from '../db/index.ts';
import { MIN, dateKey, dayAfter, fmtTime, isAligned, minutesOfDay, roundToStep, startOfDayMs, todayDay } from '../lib/time.ts';
import { subtract, staffDayBreaks, staffDayWindows, type Ctx, type OfferingRow } from './context.ts';

/**
 * Moteur de disponibilité — source de vérité unique, côté serveur.
 * Le front n'assemble jamais de créneaux : il demande, le moteur répond.
 *
 * Occupation réelle du fauteuil = préparation + prestation + nettoyage, donc un créneau
 * est libre uniquement si l'intervalle complet est vide pour AU MOINS UN coiffeur capable.
 */

export const BLOCKING = ['booked', 'confirmed', 'pending_payment', 'held', 'waiting_client', 'in_progress'];
/**
 * « Le fauteuil est occupé » ne se réduit pas aux statuts ouverts. Un rendez-vous passé à
 * `completed` alors que sa fenêtre n'est pas terminée (sans-rendez-vous réglé d'avance, « terminer »
 * cliqué trop tôt, reprise d'un autre logiciel) laissait le créneau réservable : deux fiches au même
 * créneau dans l'agenda, et un taux de remplissage que personne ne sait expliquer. La règle est donc :
 * statut ouvert, OU rendez-vous terminé dont la fin est encore à venir.
 * `occupying()` construit le SQL, `occupyingValues()` les paramètres — les deux doivent voyager ensemble.
 */
export const occupying = (alias = 'a') =>
  `(${alias}.status IN (${BLOCKING.map((_, i) => `:occ${i}`).join(',')}) OR (${alias}.status = 'completed' AND ${alias}.end_ts > :nowOcc))`;
export const occupyingValues = () => Object.fromEntries(BLOCKING.map((b, i) => [`occ${i}`, b]));
export const OPEN_STATUSES = ['booked', 'confirmed', 'pending_payment', 'waiting_client', 'in_progress', 'held'];

export interface Slot {
  start: number;
  end: number;
  staffIds: number[];
  score?: number;
  reason?: string;
  tight?: boolean;
}

export interface DaySlots {
  day: string;
  closedReason: string | null;
  slots: Slot[];
  freeMin: number;
  gaps: { start: number; end: number; usable: boolean; min: number }[];
  bookedCount: number;
}

interface ComputeOpts {
  /** Réservation déjà autorisée par le serveur, exclue uniquement lors de sa modification. */
  excludeAppointmentId?: number;
  serviceId: number;
  durationMin: number;
  prepMin: number;
  cleanupMin: number;
  day: string;
  now: number;
  staffIds: number[];
  window?: [number, number] | null;
  respectStep?: boolean;
  /** pas d'affichage client (sinon on inonde l'utilisateur de créneaux quasi identiques) */
  presentStepMin?: number;
}

let epoch = 0;
const memo = new Map<string, { exp: number; val: DaySlots }>();
export function bumpAvailabilityCache() {
  epoch++;
  if (memo.size > 400) memo.clear();
}

export async function computeDay(ctx: Ctx, o: ComputeOpts): Promise<DaySlots> {
  const key = `${ctx.locId}:${epoch}:${o.day}:${o.serviceId}:${o.durationMin}:${o.staffIds.join(',')}:${o.window?.join('-') ?? ''}:${o.respectStep === false ? 0 : 1}:${o.presentStepMin ?? 0}:${o.excludeAppointmentId ?? 0}`;
  const hit = memo.get(key);
  if (hit && hit.exp > o.now && o.now < hit.exp) return hit.val;

  const q = db();
  const dayStart = startOfDayMs(o.day);
  const dayEnd = dayStart + 24 * 60 * MIN;
  const p = ctx.policy;

  const [appts, blocks] = await Promise.all([
    q.all(
      `SELECT a.staff_id AS s, a.start_ts AS st, a.end_ts AS en, s.prep_min AS prep, s.cleanup_min AS clean
       FROM appointments a JOIN services s ON s.id = a.service_id
       WHERE a.location_id = :l AND a.start_ts < :de AND a.end_ts > :ds
         AND a.id != :exclude AND ${occupying('a')}`,
      { l: ctx.locId, ds: dayStart, de: dayEnd, exclude: o.excludeAppointmentId ?? 0, nowOcc: o.now ?? Date.now(), ...occupyingValues() },
    ),
    q.all(
      `SELECT staff_id AS s, start_ts AS st, end_ts AS en FROM blocks
       WHERE location_id = :l AND (staff_id IS NULL OR staff_id IN (${o.staffIds.length ? o.staffIds.map((_, i) => `:sid${i}`).join(',') : '-1'})) AND end_ts > :ds AND start_ts < :de`,
      Object.fromEntries([['l', ctx.locId], ['ds', dayStart], ['de', dayEnd], ...o.staffIds.map((s, i) => [`sid${i}`, s])]),
    ),
  ]);

  interface StaffDay {
    busy: [number, number][];
    booked: number;
    free: [number, number][];
  }
  const perStaff = new Map<number, StaffDay>();
  const gapCollector: { start: number; end: number; usable: boolean; min: number }[] = [];
  let anyOpen = false;

  // génération des créneaux
  const earliest = Math.max(dayStart, roundToStep(o.now + p.leadTimeMin * MIN, p.slotStepMin));
  const byStart = new Map<number, Slot>();

  for (const sid of o.staffIds) {
    const { windows } = await staffDayWindows(ctx, sid, o.day);
    if (!windows.length) continue;
    anyOpen = true;
    const mine = appts.filter((a: any) => a.s === sid);
    const cuts = await cutsFor(ctx, sid, o.day, appts, blocks);
    const free = subtract(
      windows.filter(([x, y]) => y > x),
      cuts,
    );
    perStaff.set(sid, { busy: mine.map((a: any) => [a.st, a.en] as [number, number]), booked: mine.length, free });
    for (const [a, b] of free) {
      const min = Math.round((b - a) / MIN);
      if (min > 0) gapCollector.push({ start: a, end: b, usable: min >= o.durationMin, min });
    }
    for (const [a, b] of free) {
      let t = Math.max(a, earliest);
      if (o.respectStep !== false && !isAligned(t, p.slotStepMin)) t = roundToStep(t, p.slotStepMin);
      for (; t + o.durationMin * MIN <= b; t += p.slotStepMin * MIN) {
        if (t < dayStart || t + o.durationMin * MIN > dayEnd) continue;
        if (o.window && (minutesOfDay(t) < o.window[0] || minutesOfDay(t + o.durationMin * MIN) > o.window[1])) continue;
        const prev = byStart.get(t);
        if (prev) {
          if (!prev.staffIds.includes(sid)) prev.staffIds.push(sid);
        } else {
          byStart.set(t, { start: t, end: t + o.durationMin * MIN, staffIds: [sid] });
        }
      }
    }
  }

  if (!byStart.size && !anyOpen) {
    const reason = await firstClosedReason(ctx, o.staffIds, o.day);
    if (reason) return { day: o.day, closedReason: reason, slots: [], freeMin: 0, gaps: [], bookedCount: 0 };
  }

  // score : proximité + compacité (on préfère coller un RDV existant, pour ne pas créer de trou mort)
  const slots = [...byStart.values()].sort((x, y) => x.start - y.start);
  for (const s of slots) {
    const prox = (s.start - earliest) / MIN;
    let adjacency = 0;
    for (const sid of s.staffIds) {
      const busy = perStaff.get(sid)?.busy ?? [];
      for (const [a, b] of busy) {
        if (Math.abs(b - s.start) <= 45 * MIN || Math.abs(a - s.end) <= 45 * MIN) adjacency++;
      }
    }
    s.score = Math.round(Math.max(0, 1000 - prox / 6) + adjacency * 40 + (isPrimeHour(s.start) ? 12 : 0));
    s.tight = s.tight === true || s.staffIds.length === 1;
  }

  const freeMin = gapCollector.reduce((acc, g) => acc + (g.usable ? g.min : 0), 0);
  const bookedCount = [...perStaff.values()].reduce((acc, v) => acc + v.booked, 0);
  const val: DaySlots = {
    day: o.day,
    closedReason: slots.length ? null : !anyOpen ? (await firstClosedReason(ctx, o.staffIds, o.day)) ?? 'Fermé' : 'Aucun créneau assez long',
    slots,
    freeMin,
    gaps: gapCollector.sort((a, b) => a.start - b.start),
    bookedCount,
  };
  memo.set(key, { exp: Date.now() + 10_000, val });
  return val;
}

function isPrimeHour(ms: number) {
  const m = minutesOfDay(ms);
  return m % 60 === 0 && m >= 600 && m <= 1320;
}

async function cutsFor(ctx: Ctx, sid: number, day: string, appts: any[], blocks: any[]) {
  const base = startOfDayMs(day);
  const breaks = await staffDayBreaks(ctx, sid, day);
  return [
    ...breaks,
    ...(blocks.filter((b: any) => b.s === sid || b.s === null) as any[]).map((b: any) => [b.st, b.en] as [number, number]),
    ...appts
      .filter((a: any) => a.s === sid)
      .map((a: any) => [a.st - (a.prep ?? 0) * MIN, a.en + (a.clean ?? 0) * MIN] as [number, number]),
  ];
}

async function firstClosedReason(ctx: Ctx, staffIds: number[], day: string): Promise<string | null> {
  const q = db();
  const holiday = ctx.holidays[day];
  if (holiday) return `Jour férié — ${holiday}`;
  const ov = await q.one(`SELECT * FROM day_overrides WHERE location_id = :l AND day = :d AND kind = 'closed' AND (staff_id IS NULL OR staff_id IN (${staffIds.length ? staffIds.join(',') : '-1'})) LIMIT 1`, { l: ctx.locId, d: day });
  if (ov) return (ov as any).reason || 'Indisponible';
  const { windows, closedReason } = await staffDayWindows(ctx, staffIds[0] ?? -1, day);
  if (!windows.length) return closedReason ?? 'Fermé';
  return null;
}

/** Coiffeurs capables de réaliser le service (compétences + nouveaux clients). */
export function capableStaff(ctx: Ctx, serviceId: number, opts: { staffId?: number | null; newClient?: boolean } = {}): number[] {
  if (opts.staffId != null) return [opts.staffId];
  return ctx.staff
    .filter((s) => (s.service_ids.length ? s.service_ids.includes(serviceId) : true))
    .filter((s) => (opts.newClient ? s.accept_new_clients : true))
    .map((s) => s.id);
}

/** Résolution d'une prestation (+ suppléments) et de ses durées/prix effectifs. */
export function resolveOffering(ctx: Ctx, offering: OfferingRow, addonIds: number[] = []) {
  const svc = ctx.services.find((s) => s.id === offering.service_id)!;
  const chosenAddons = ctx.addons.filter((a: any) => addonIds.includes(a.id));
  const duration = offering.duration_min + chosenAddons.reduce((acc, a: any) => acc + a.duration_min, 0);
  const price = offering.price_cents + chosenAddons.reduce((acc, a: any) => acc + a.price_cents, 0);
  const staffIds = capableStaff(ctx, svc.id);
  return {
    service: svc,
    offering,
    addons: chosenAddons,
    durationMin: duration,
    priceCents: price,
    prepMin: svc.prep_min ?? 0,
    cleanupMin: svc.cleanup_min ?? 0,
    staffIds,
  };
}

export async function dayList(ctx: Ctx, fromDay = todayDay(), count = ctx.policy.horizonDays): Promise<string[]> {
  const out: string[] = [];
  let d = fromDay;
  for (let i = 0; i < count; i++) {
    out.push(d);
    d = dayAfter(d);
  }
  return out;
}

export interface AvailabilityResult {
  days: DaySlots[];
  best: Slot | null;
  nearest: Slot | null;
  totalCount: number;
  byDay: Record<string, number>;
}


/**
 * Le pas de présentation des listes client. Les trois chemins qui acceptent un créneau
 * (liste, réservation, décalage/changement de prestation) DOIVENT l'utiliser : sinon le
 * client clique un créneau affiché et se fait refuser — le pire bug possible pour un moteur de réservation.
 */
export function presentStepFor(durationMin: number) {
  const d = Number(durationMin);
  if (!Number.isFinite(d) || d <= 0) return 30;
  return Math.min(30, Math.max(15, Math.round(d / 2)));
}

/** créneau acceptable : dans la liste, OU dans un trou de la journée assez long (derniers créneaux « serrés ») */
export function slotOfferable(day: { slots: { start: number }[]; gaps: { start: number; end: number }[] }, start: number, end: number) {
  if (day.slots.some((s) => s.start === start)) return true;
  return (day.gaps ?? []).some((g) => start >= g.start && end <= g.end);
}

export async function availability(ctx: Ctx, opts: { serviceId: number; durationMin: number; prepMin: number; cleanupMin: number; staffIds: number[]; days: string[]; window?: [number, number] | null; now?: number; limitPerDay?: number; presentStepMin?: number }): Promise<AvailabilityResult> {
  const now = opts.now ?? Date.now();
  const days: DaySlots[] = [];
  for (const day of opts.days) {
    const r = await computeDay(ctx, {
      serviceId: opts.serviceId,
      durationMin: opts.durationMin,
      prepMin: opts.prepMin,
      cleanupMin: opts.cleanupMin,
      day,
      now,
      staffIds: opts.staffIds,
      window: opts.window ?? null,
      presentStepMin: opts.presentStepMin,
    });
    if (opts.limitPerDay) r.slots = r.slots.slice(0, opts.limitPerDay);
    days.push(r);
  }
  const flat = days.flatMap((d) => d.slots);
  const best = flat.length ? flat.reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a)) : null;
  return {
    days,
    best: best ? { ...best } : null,
    nearest: flat[0] ?? null,
    totalCount: days.reduce((acc, d) => acc + d.slots.length, 0),
    byDay: Object.fromEntries(days.map((d) => [d.day, d.slots.length])),
  };
}

/** "Prochaine dispo réelle" : premier créneau sur l'horizon, sans mentir. */
export async function nextAvailable(ctx: Ctx, opts: { serviceId: number; durationMin: number; prepMin: number; cleanupMin: number; staffIds: number[]; fromDay?: string; days?: number; window?: [number, number] | null }): Promise<Slot | null> {
  const days = await dayList(ctx, opts.fromDay ?? todayDay(), opts.days ?? ctx.policy.horizonDays);
  for (const day of days) {
    const r = await computeDay(ctx, {
      serviceId: opts.serviceId,
      durationMin: opts.durationMin,
      prepMin: opts.prepMin,
      cleanupMin: opts.cleanupMin,
      day,
      now: Date.now(),
      staffIds: opts.staffIds,
      window: opts.window ?? null,
    });
    if (r.slots.length) return r.slots[0];
  }
  return null;
}

/** Suggestions intelligentes quand la demande > l'offre. Ne renvoie JAMAIS juste "complet". */
export async function smartAlternatives(
  ctx: Ctx,
  opts: { serviceId: number; durationMin: number; prepMin: number; cleanupMin: number; requestedDay: string; requestedStaffId: number | null; window?: [number, number] | null; limit?: number },
) {
  const now = Date.now();
  const allStaff = ctx.staff.filter((s) => (s.service_ids.length ? s.service_ids.includes(opts.serviceId) : true)).map((s) => s.id);
  const out: { kind: 'same_day_other_staff' | 'same_day_other_time' | 'other_day' | 'other_staff_other_day'; slot: Slot; staffId: number; label: string }[] = [];
  const horizon = await dayList(ctx, opts.requestedDay, Math.min(7, ctx.policy.horizonDays));

  for (const day of horizon) {
    for (const sid of allStaff) {
      const r = await computeDay(ctx, {
        serviceId: opts.serviceId,
        durationMin: opts.durationMin,
        prepMin: opts.prepMin,
        cleanupMin: opts.cleanupMin,
        day,
        now,
        staffIds: [sid],
        window: day === opts.requestedDay ? opts.window ?? null : null,
      });
      const s = r.slots[0];
      if (!s) continue;
      const staff = ctx.staff.find((x) => x.id === sid)!;
      const sameDay = day === opts.requestedDay;
      out.push({
        kind: sameDay ? (opts.requestedStaffId != null ? 'same_day_other_staff' : 'same_day_other_time') : opts.requestedStaffId != null ? 'other_staff_other_day' : 'other_day',
        slot: s,
        staffId: sid,
        label: `${sameDay ? 'Même jour' : dateKey(s.start)} · ${fmtTime(s.start)} · ${staff.name}`,
      });
    }
  }
  return out.slice(0, opts.limit ?? 5);
}

/** Analyse des trous du planning (smart scheduling) : ce qui est vendable ou mort. */
export function gapReport(day: DaySlots, minUsableMin = 25) {
  const usable = day.gaps.filter((g) => g.min >= minUsableMin);
  const dead = day.gaps.filter((g) => g.min < minUsableMin);
  return {
    usableSlots: usable.length,
    deadMinutes: dead.reduce((a, g) => a + g.min, 0),
    usableMinutes: usable.reduce((a, g) => a + g.min, 0),
    holes: day.gaps.map((g) => ({ start: g.start, end: g.end, min: g.min, usable: g.min >= minUsableMin })),
  };
}
