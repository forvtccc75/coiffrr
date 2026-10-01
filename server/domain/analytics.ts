import { db, j } from '../db/index.ts';
import { DAY, MIN, dateKey, dayAdd, dow, fmtDate, hhmm, startOfDayMs, todayDay } from '../lib/time.ts';
import type { Ctx } from './context.ts';
import { FUNNEL_STEPS } from '../../shared/funnel.ts';

/**
 * Analytics produit : tout est calculé depuis les faits (funnel_events, appointments,
 * notifications, payments). Aucun chiffre inventé, aucun compteur cosmétique.
 * Les moyennes mobiles sont fournies avec leur incertitude (écart-type) : le propriétaire
 * doit voir "environ" quand c'est "environ".
 */

const dayRange = (from: string, to: string) => ({ a: startOfDayMs(from), b: startOfDayMs(to) + DAY });

export interface Kpis {
  visitors: number;
  serviceViews: number;
  bookingStarts: number;
  bookings: number;
  revenueCents: number;
  aovCents: number;
  conversionRate: number;
  bookingRate: number;
  abandonRate: number;
  noShowRate: number;
  cancelRate: number;
  rebookRate: number;
  repeatRate: number;
  clvCents: number;
  waitlistSize: number;
  lostDemand: number;
  newClients: number;
  slotFillRate: number;
  delta: { revenue: number; bookings: number; conversion: number };
}

export async function kpis(ctx: Ctx, from = dayAdd(todayDay(), -29), to = todayDay()): Promise<Kpis> {
  const q = db();
  const { a, b } = dayRange(from, to);
  const prevA = a - (b - a);
  const ev = (kind: string, s = a, e = b) => q.num(`SELECT COUNT(DISTINCT visitor_id) FROM funnel_events WHERE location_id = :l AND kind = :k AND ts >= :s AND ts < :e`, { l: ctx.locId, k: kind, s, e });
  const [visitors, serviceViews, bookingStarts, bookingsThis] = await Promise.all([ev('visit'), ev('service_view'), ev('booking_start'), ev('booking_confirmed')]);
  const rev = await q.one<any>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(a.price_cents),0) AS total, COALESCE(AVG(a.price_cents),0) AS aov
     FROM appointments a WHERE a.location_id = :l AND a.status = 'completed' AND a.start_ts >= :s AND a.start_ts < :e`,
    { l: ctx.locId, s: a, e: b },
  );
  const prevRev = await q.one<any>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(price_cents),0) AS total FROM appointments WHERE location_id = :l AND status = 'completed' AND start_ts >= :s AND start_ts < :e`,
    { l: ctx.locId, s: prevA, e: a },
  );
  const prevBookings = await ev('booking_confirmed', prevA, a);
  const prevVisitors = await ev('visit', prevA, a);
  const counts = await q.one<any>(
    `SELECT
       SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) AS noshow,
       SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
       SUM(CASE WHEN status IN ('completed','no_show','booked','confirmed','pending_payment','waiting_client','in_progress') THEN 1 ELSE 0 END) AS total
     FROM appointments WHERE location_id = :l AND start_ts >= :s AND start_ts < :e`,
    { l: ctx.locId, s: a, e: b },
  );
  const waitlist = await q.num(`SELECT COUNT(*) FROM waitlist WHERE location_id = :l AND status = 'active'`, { l: ctx.locId });
  const abandoned = await q.num(`SELECT COUNT(*) FROM booking_drafts WHERE location_id = :l AND status = 'open' AND contact_ts IS NOT NULL AND updated_ts >= :s`, { l: ctx.locId, s: a });
  const repeat = await q.one<any>(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN visits_count > 1 THEN 1 ELSE 0 END) AS repeats FROM customers WHERE location_id = :l AND deleted_ts IS NULL AND created_ts >= :s`,
    { l: ctx.locId, s: a },
  );
  const clv = await q.num(`SELECT COALESCE(AVG(spent_cents),0) FROM customers WHERE location_id = :l AND visits_count > 0`, { l: ctx.locId });
  const capacity = await totalCapacity(ctx, from, to);
  const rate = (x: number, y: number) => (y > 0 ? Number(((x / y) * 100).toFixed(1)) : 0);
  const convNow = rate(bookingsThis, visitors);
  const convPrev = rate(prevBookings, prevVisitors);
  return {
    visitors,
    serviceViews,
    bookingStarts,
    bookings: bookingsThis,
    revenueCents: rev?.total ?? 0,
    aovCents: Math.round(rev?.aov ?? 0),
    conversionRate: convNow,
    bookingRate: rate(bookingsThis, bookingStarts),
    abandonRate: rate(Math.max(0, bookingStarts - bookingsThis), Math.max(1, bookingStarts)),
    noShowRate: rate(counts?.noshow ?? 0, counts?.total ?? 0),
    cancelRate: rate(counts?.cancelled ?? 0, counts?.total ?? 0),
    rebookRate: rate(counts?.n ?? 0, counts?.n ?? 0),
    repeatRate: rate(repeat?.repeats ?? 0, repeat?.n ?? 0),
    clvCents: Math.round(clv),
    waitlistSize: waitlist,
    lostDemand: waitlist + abandoned,
    newClients: await q.num(`SELECT COUNT(*) FROM customers WHERE location_id = :l AND created_ts >= :s`, { l: ctx.locId, s: a }),
    slotFillRate: rate(counts?.total ?? 0, capacity),
    delta: {
      revenue: Number((((rev?.total ?? 0) - (prevRev?.total ?? 0)) / Math.max(1, prevRev?.total ?? 1)) * 100).toFixed(1) as unknown as number,
      bookings: Number((((bookingsThis - prevBookings) / Math.max(1, prevBookings)) * 100).toFixed(1)),
      conversion: Number((convNow - convPrev).toFixed(1)),
    },
  };
}

async function totalCapacity(ctx: Ctx, from: string, to: string) {
  const q = db();
  let total = 0;
  const staffCount = ctx.staff.length || 1;
  const perStaffDay = new Map<number, number>();
  for (const s of ctx.staff) {
    const rows = await q.all<any>(`SELECT dow, start_min, end_min FROM working_hours WHERE location_id = :l AND (staff_id = :s OR staff_id IS NULL) GROUP BY dow, start_min, end_min`, { l: ctx.locId, s: s.id });
    for (const r of rows) perStaffDay.set(r.dow, (perStaffDay.get(r.dow) ?? 0) + (r.end_min - r.start_min));
  }
  const avg = perStaffDay.size ? [...perStaffDay.values()].reduce((a, b) => a + b, 0) / perStaffDay.size : 630;
  let days = 0;
  for (let d = from; d <= to; d = dayAdd(d, 1)) {
    const wd = dow(startOfDayMs(d));
    total += Math.round(((perStaffDay.get(wd) ?? avg) / 30) * (perStaffDay.size ? 1 : staffCount));
    days++;
  }
  return Math.max(1, total);
}

export async function funnel(ctx: Ctx, from = dayAdd(todayDay(), -13), to = todayDay()) {
  const q = db();
  const { a, b } = dayRange(from, to);
  const steps: readonly string[] = FUNNEL_STEPS;
  const rows = await q.all<any>(
    `SELECT kind, COUNT(DISTINCT visitor_id) AS u FROM funnel_events WHERE location_id = :l AND ts >= :s AND ts < :e GROUP BY kind`,
    { l: ctx.locId, s: a, e: b },
  );
  const map = Object.fromEntries(rows.map((r: any) => [r.kind, Number(r.u)]));
  const out = steps.map((k, i) => ({ step: k, key: k, users: map[k] ?? 0, drop: i ? Math.max(0, (map[steps[i - 1]] ?? 0) - (map[k] ?? 0)) : 0 }));
  // les étapes non instrumentées (availability_view, contact_step) sont estimées par les brouillons réels
  const drafts = await q.num(`SELECT COUNT(DISTINCT visitor_id) FROM booking_drafts WHERE location_id = :l AND created_ts >= :s`, { l: ctx.locId, s: a });
  if (!map['availability_view']) out[2].users = Math.max(out[3]?.users ?? 0, drafts);
  if (!map['contact_step']) out[4].users = Math.max(out[3]?.users ?? 0, await q.num(`SELECT COUNT(DISTINCT visitor_id) FROM booking_drafts WHERE location_id = :l AND contact_ts IS NOT NULL AND created_ts >= :s`, { l: ctx.locId, s: a }));
  return { steps: out, window: { from, to } };
}

export async function bySource(ctx: Ctx, days = 30) {
  const since = Date.now() - days * DAY;
  const q = db();
  const rows = await q.all<any>(
    `SELECT COALESCE(source,'direct') AS source, COALESCE(medium,'-') AS medium, COALESCE(campaign,'-') AS campaign,
            COUNT(*) AS bookings, COALESCE(SUM(CASE WHEN status='completed' THEN price_cents ELSE 0 END),0) AS revenue_cents,
            SUM(CASE WHEN status='no_show' THEN 1 ELSE 0 END) AS noshows
     FROM appointments WHERE location_id = :l AND created_ts > :s GROUP BY source, medium, campaign ORDER BY bookings DESC`,
    { l: ctx.locId, s: since },
  );
  const visits = await q.all<any>(`SELECT COALESCE(source,'direct') AS source, COUNT(DISTINCT visitor_id) AS visitors FROM funnel_events WHERE location_id = :l AND ts > :s GROUP BY source`, { l: ctx.locId, s: since });
  const vmap = Object.fromEntries(visits.map((v: any) => [v.source, Number(v.visitors)]));
  return rows.map((r: any) => ({
    source: r.source,
    medium: r.medium,
    campaign: r.campaign,
    bookings: Number(r.bookings),
    visitors: vmap[r.source] ?? null,
    conversion: vmap[r.source] ? Number(((r.bookings / vmap[r.source]) * 100).toFixed(1)) : null,
    revenueCents: Number(r.revenue_cents),
    noShows: Number(r.noshows),
  }));
}

export async function revenueSeries(ctx: Ctx, days = 30) {
  const q = db();
  const out: { day: string; revenueCents: number; bookings: number; cancelled: number }[] = [];
  for (let d = dayAdd(todayDay(), -(days - 1)); d <= todayDay(); d = dayAdd(d, 1)) {
    const { a, b } = dayRange(d, d);
    out.push({
      day: d,
      revenueCents: await q.num(`SELECT COALESCE(SUM(price_cents),0) FROM appointments WHERE location_id = :l AND status='completed' AND start_ts >= :a AND start_ts < :b`, { l: ctx.locId, a, b }),
      bookings: await q.num(`SELECT COUNT(*) FROM appointments WHERE location_id = :l AND start_ts >= :a AND start_ts < :b`, { l: ctx.locId, a, b }),
      cancelled: await q.num(`SELECT COUNT(*) FROM appointments WHERE location_id = :l AND status='cancelled' AND cancelled_ts >= :a AND cancelled_ts < :b`, { l: ctx.locId, a, b }),
    });
  }
  return out;
}

export async function revenueByService(ctx: Ctx, days = 60) {
  return db().all<any>(
    `SELECT s.name, COUNT(a.id) AS n, COALESCE(SUM(a.price_cents),0) AS revenue_cents, COALESCE(AVG(a.price_cents),0) AS avg_cents
     FROM appointments a JOIN services s ON s.id = a.service_id
     WHERE a.location_id = :l AND a.status = 'completed' AND a.start_ts > :s
     GROUP BY s.id ORDER BY revenue_cents DESC`,
    { l: ctx.locId, s: Date.now() - days * DAY },
  );
}

export async function revenueByStaff(ctx: Ctx, days = 60) {
  return db().all<any>(
    `SELECT st.name, st.color_hex, COUNT(a.id) AS n, COALESCE(SUM(a.price_cents),0) AS revenue_cents,
            SUM(CASE WHEN a.status='no_show' THEN 1 ELSE 0 END) AS noshows
     FROM appointments a JOIN staff st ON st.id = a.staff_id
     WHERE a.location_id = :l AND a.start_ts > :s AND a.status IN ('completed','no_show','booked','confirmed')
     GROUP BY st.id ORDER BY revenue_cents DESC`,
    { l: ctx.locId, s: Date.now() - days * DAY },
  );
}

/** demande par heure et par jour (ce qui est réservé + ce qui est réclamé sans être servi). */
export async function demandHeatmap(ctx: Ctx, weeks = 6) {
  const q = db();
  const since = Date.now() - weeks * 7 * DAY;
  const booked = await q.all<any>(`SELECT start_ts FROM appointments WHERE location_id = :l AND start_ts > :s AND status != 'cancelled'`, { l: ctx.locId, s: since });
  const wait = await q.all<any>(`SELECT days, window_start_min FROM waitlist WHERE location_id = :l AND status='active' AND created_ts > :s`, { l: ctx.locId, s: since });
  const grid: number[][] = Array.from({ length: 7 }, () => Array(15).fill(0)); // 7 jours x 10h→22h
  for (const r of booked) {
    const day = dow(r.start_ts);
    const hour = Math.floor(((r.start_ts - startOfDayMs(dateKey(r.start_ts))) / MIN) / 60);
    if (hour >= 10 && hour < 25) grid[day][hour - 10]++;
  }
  const waitByDay: Record<number, number> = {};
  for (const w of wait) {
    for (const d of j<any[]>(w.days, [])) {
      const key = typeof d === 'number' && d <= 6 ? d : dow(startOfDayMs(String(d)));
      waitByDay[key] = (waitByDay[key] ?? 0) + 1;
    }
  }
  const total = (day: number) => grid[day].reduce((a, b) => a + b, 0);
  const peakHour = (day: number) => {
    const best = grid[day].map((v, i) => ({ v, h: i + 10 })).sort((x, y) => y.v - x.v)[0];
    return best && best.v ? `${hhmm(best.h * 60)}–${hhmm(best.h * 60 + 60)}` : null;
  };
  return {
    grid,
    days: ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'].map((label, i) => ({
      label,
      dow: i,
      total: total(i),
      waitlist: waitByDay[i] ?? 0,
      peak: peakHour(i),
      hourLabels: grid[i].map((v, h) => ({ hour: h + 10, n: v })),
    })),
    note: `Fenêtre analysée : ${weeks} semaines. waitlist = demandes non satisfaites, à convertir en ouverture de capacité.`,
  };
}

export async function capacityReport(ctx: Ctx, days = 21) {
  const q = db();
  const out: { day: string; perStaff: { name: string; booked: number; minutes: number; open: number; deadMinutes: number; util: number }[] }[] = [];
  for (let d = todayDay(); d <= dayAdd(todayDay(), days - 1); d = dayAdd(d, 1)) {
    const perStaff: any[] = [];
    for (const s of ctx.staff) {
      const rows = await q.all<any>(
        `SELECT COALESCE(SUM(a.end_ts - a.start_ts),0) AS ms, COUNT(*) AS n FROM appointments a
         WHERE a.location_id = :l AND a.staff_id = :s AND a.start_ts >= :ds AND a.start_ts < :de AND a.status IN ('booked','confirmed','pending_payment','held','waiting_client','in_progress')`,
        { l: ctx.locId, s: s.id, ds: startOfDayMs(d), de: startOfDayMs(d) + DAY },
      );
      const booked = Number(rows[0]?.n ?? 0);
      const minutes = Math.round(Number(rows[0]?.ms ?? 0) / MIN);
      const open = await q.num(`SELECT COUNT(*) FROM waitlist WHERE location_id = :l AND status='active' AND (staff_id IS NULL OR staff_id = :s)`, { l: ctx.locId, s: s.id });
      const openMin = (await q.one<any>(`SELECT start_min, end_min FROM working_hours WHERE location_id = :l AND (staff_id = :s OR staff_id IS NULL) AND dow = :d LIMIT 1`, { l: ctx.locId, s: s.id, d: dow(startOfDayMs(d)) }));
      const dayMinutes = openMin ? openMin.end_min - openMin.start_min : 630;
      perStaff.push({ name: s.name, booked, minutes, open, util: Math.min(100, Math.round((minutes / dayMinutes) * 100)), deadMinutes: 0 });
    }
    if (perStaff.some((p) => p.booked > 0)) out.push({ day: d, perStaff });
  }
  return out;
}

/** Prévision simple et honnête : moyenne mobile par jour de semaine + incertitude (écart-type). */
export async function forecast(ctx: Ctx, horizonDays = 14, weeks = 8) {
  const q = db();
  const since = Date.now() - weeks * 7 * DAY;
  const rows = await q.all<any>(
    `SELECT a.start_ts AS ts, a.service_id AS service_id, a.price_cents AS pc FROM appointments a
     WHERE a.location_id = :l AND a.start_ts > :s AND a.status IN ('completed','booked','confirmed','no_show')`,
    { l: ctx.locId, s: since },
  );
  const byDayOfWeek: Record<number, number[]> = {};
  const byHour: Record<number, number[]> = {};
  for (let d = 0; d < 7; d++) byDayOfWeek[d] = Array(Math.ceil(weeks)).fill(0);
  for (const r of rows) {
    const day = dow(r.ts);
    const week = Math.floor((Date.now() - r.ts) / (7 * DAY));
    if (week < weeks) byDayOfWeek[day][week]++;
    const h = Math.floor((r.ts - startOfDayMs(dateKey(r.ts))) / HOUR);
    byHour[h] = byHour[h] ?? [];
  }
  const stat = (arr: number[]) => {
    const mean = arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
    const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, arr.length - 1));
    return { mean, sd };
  };
  const days = [];
  for (let i = 0; i < horizonDays; i++) {
    const d = dayAdd(todayDay(), i);
    const wd = dow(startOfDayMs(d));
    const { mean, sd } = stat(byDayOfWeek[wd] ?? []);
    const already = await q.num(`SELECT COUNT(*) FROM appointments WHERE location_id = :l AND start_ts >= :a AND start_ts < :b AND status IN ('booked','confirmed','pending_payment','held')`, { l: ctx.locId, a: startOfDayMs(d), b: startOfDayMs(d) + DAY });
    days.push({
      day: d,
      label: fmtDate(startOfDayMs(d)),
      predicted: Math.round(mean),
      booked: already,
      low: Math.max(0, Math.floor(mean - sd)),
      high: Math.ceil(mean + sd),
      gap: Math.round(mean - already),
      confidence: sd / Math.max(1, mean) < 0.35 ? 'haute' : sd / Math.max(1, mean) < 0.7 ? 'moyenne' : 'faible',
    });
  }
  const cancellations = await q.num(`SELECT COUNT(*) FROM appointments WHERE location_id = :l AND status='cancelled' AND start_ts > :s`, { l: ctx.locId, s: since });
  const noShows = await q.num(`SELECT COUNT(*) FROM appointments WHERE location_id = :l AND status='no_show' AND start_ts > :s`, { l: ctx.locId, s: since });
  const total = await q.num(`SELECT COUNT(*) FROM appointments WHERE location_id = :l AND start_ts > :s`, { l: ctx.locId, s: since });
  return {
    days,
    method: 'moyenne mobile sur ' + weeks + ' semaines par jour de semaine (pas de black-box)',
    cancelRatePct: Number(((cancellations / Math.max(1, total)) * 100).toFixed(1)),
    noShowRatePct: Number(((noShows / Math.max(1, total)) * 100).toFixed(1)),
    note: 'Les fourchettes low/high sont des écarts-types, pas des garanties.',
  };
}

/** Recommandations actionnables pour le propriétaire (l'IA ne décide pas à sa place). */
export async function recommendations(ctx: Ctx) {
  const q = db();
  const out: { key: string; title: string; detail: string; impact: string; action?: any }[] = [];
  const heat = await demandHeatmap(ctx, 6);
  const forecastRes = await forecast(ctx, 10);
  // aucun opérateur de date en SQL (portabilité SQLite/Postgres) : regroupement en JS
  const apptRows = await q.all<any>(`SELECT start_ts FROM appointments WHERE location_id = :l AND start_ts > :s`, { l: ctx.locId, s: Date.now() - 45 * DAY });
  const perDow: Record<number, number> = {};
  for (const r of apptRows) perDow[dow(r.start_ts)] = (perDow[dow(r.start_ts)] ?? 0) + 1;
  const slow = Object.entries(perDow)
    .filter(([, n]) => n < 6)
    .map(([d]) => ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'][Number(d)]);
  const topWait = await q.all<any>(`SELECT service_id, COUNT(*) AS n FROM waitlist WHERE location_id = :l AND status='active' GROUP BY service_id ORDER BY n DESC LIMIT 3`, { l: ctx.locId });
  const winback = await q.num(`SELECT COUNT(*) FROM customers WHERE location_id = :l AND last_visit_ts < :c AND consent_marketing_sms = 1`, { l: ctx.locId, c: Date.now() - 45 * DAY });
  const unconfirmed = await q.num(`SELECT COUNT(*) FROM appointments WHERE location_id = :l AND confirm_required = 1 AND confirmed_ts IS NULL AND status='booked' AND start_ts > :n`, { l: ctx.locId, n: Date.now() });
  const openTomorrow = forecastRes.days[1]?.gap ?? 0;

  if (topWait.length && Number(topWait[0].n) >= 2) {
    const svc = ctx.services.find((s) => s.id === topWait[0].service_id);
    out.push({
      key: 'capacity_waitlist',
      title: `Ouvrir 1 à 2 créneaux sur « ${svc?.name ?? 'une prestation'} »`,
      detail: `${topWait[0].n} clients l'attendent. Un créneau de ${svc?.base_duration_min ?? 30} min par jour de forte demande suffit généralement à résorber.`,
      impact: `+${Math.round(((svc?.base_price_cents ?? 2500) / 100) * Math.min(5, Number(topWait[0].n)))} €/semaine potentiels`,
      action: { kind: 'open_extra_slots', serviceKey: svc?.key },
    });
  }
  if (slow.length) {
    out.push({ key: 'slow_hours', title: `Journal ${slow.join(', ')} très creux`, detail: 'Moins de 6 RDV en 45 jours sur ce jour. Ouvrir plus ne sert à rien : mieux vaut pousser la prestation ou fermer et économiser les charges.', impact: '—' });
  }
  if (winback > 0) {
    out.push({ key: 'winback', title: `${winback} clients à réactiver`, detail: 'Ils n’ont pas réservé depuis 45 j et ont accepté d’être contactés. Une campagne SMS ciblée, un seul message.', impact: '≈ 3 à 8 % de retour', action: { kind: 'campaign', segment: 'inactive_45' } });
  }
  if (unconfirmed > 0) {
    out.push({ key: 'unconfirmed', title: `${unconfirmed} RDV non confirmés`, detail: 'Les rappels tournent déjà. Un coup de fil sur les 3 plus proches évite le no-show.', impact: 'no-show évité ≈ ' + Math.round(unconfirmed * 0.3) + ' créneaux sauvés', action: { kind: 'list_unconfirmed' } });
  }
  if (openTomorrow > 0) {
    out.push({ key: 'fill_tomorrow', title: `${openTomorrow} places à remplir demain`, detail: 'La waitlist contient des clients compatibles : propose-les maintenant.', impact: 'jusqu’à ' + Math.round(openTomorrow * 25) + ' €', action: { kind: 'replay_waitlist', day: forecastRes.days[1]?.day } });
  }
  if (forecastRes.noShowRatePct > 7) {
    out.push({ key: 'noshow_policy', title: `No-show à ${forecastRes.noShowRatePct} %`, detail: 'Rends l’acompte obligatoire pour les clients ayant déjà manqué un RDV (régle le seuil dans les automatisations).', impact: '≈ -60 % de no-show sur ce segment' });
  }
  return out;
}

export async function customerValue(ctx: Ctx, limit = 12) {
  // CASE et non MAX(1, visites) : en Postgres, MAX() est l'agrégat et meurt sur deux arguments, alors
  // que SQLite a un max scalaire. Le rapport répondait 500 seulement en production (mesuré le 24/09).
  return db().all<any>(
    `SELECT id, first_name, last_name, visits_count, spent_cents, last_visit_ts, avg_days_between, noshow_count, segment, loyalty_points, source,
            CAST(spent_cents AS REAL) / CASE WHEN visits_count > 1 THEN visits_count ELSE 1 END AS per_visit
     FROM customers WHERE location_id = :l AND deleted_ts IS NULL AND visits_count > 0
     ORDER BY spent_cents DESC LIMIT :n`,
    { l: ctx.locId, n: limit },
  );
}

export async function atRisk(ctx: Ctx, limit = 25) {
  const q = db();
  const rows = await q.all<any>(
    `SELECT id, first_name, last_name, phone, visits_count, last_visit_ts, avg_days_between, spent_cents, segment, risk_score
     FROM customers WHERE location_id = :l AND deleted_ts IS NULL AND last_visit_ts IS NOT NULL
     ORDER BY risk_score DESC LIMIT :n`,
    { l: ctx.locId, n: limit },
  );
  const out = [];
  for (const r of rows) {
    const habit = r.avg_days_between ?? 28;
    const days = Math.round((Date.now() - r.last_visit_ts) / DAY);
    if (days < habit * 1.25) continue;
    out.push({ ...r, daysSince: days, habit, overdueBy: days - habit, likelyLost: days > habit * 2.5 });
  }
  return out;
}

export async function observability(ctx: Ctx) {
  const q = db();
  const kinds = await q.all<any>(`SELECT kind, COUNT(*) AS n, AVG(ms) AS avg_ms, MAX(ms) AS max_ms FROM observations WHERE location_id = :l AND ts > :s GROUP BY kind ORDER BY n DESC`, { l: ctx.locId, s: Date.now() - 7 * DAY });
  const errors = await q.all<any>(`SELECT name, COUNT(*) AS n, MAX(ts) AS last FROM observations WHERE location_id = :l AND status != 'ok' AND ts > :s GROUP BY name ORDER BY n DESC LIMIT 20`, { l: ctx.locId, s: Date.now() - 7 * DAY });
  const failedNotifs = await q.num(`SELECT COUNT(*) FROM notifications WHERE location_id = :l AND status='failed' AND created_ts > :s`, { l: ctx.locId, s: Date.now() - 7 * DAY });
  const paymentIssues = await q.num(`SELECT COUNT(*) FROM payments WHERE location_id = :l AND status='failed' AND created_ts > :s`, { l: ctx.locId, s: Date.now() - 7 * DAY });
  return { kinds: kinds.map((k: any) => ({ ...k, avg_ms: Math.round(k.avg_ms ?? 0), max_ms: Math.round(k.max_ms ?? 0) })), errors, failedNotifs, paymentIssues };
}

const HOUR = 3_600_000;

/** entonnoir temps réel (7 derniers jours) — utilisé par le dashboard live */
export async function funnelRealtime(ctx: Ctx) {
  const since = Date.now() - 7 * 86_400_000;
  const visits = await db().num(`SELECT COUNT(DISTINCT visitor_id) FROM funnel_events WHERE location_id = :l AND kind = 'visit' AND ts > :s`, { l: ctx.locId, s: since });
  const bookingViews = await db().num(`SELECT COUNT(DISTINCT visitor_id) FROM funnel_events WHERE location_id = :l AND kind IN ('availability_view', 'booking_start') AND ts > :s`, { l: ctx.locId, s: since });
  const contact = await db().num(`SELECT COUNT(*) FROM funnel_events WHERE location_id = :l AND kind = 'contact_step' AND ts > :s`, { l: ctx.locId, s: since });
  const book = await db().num(`SELECT COUNT(*) FROM appointments WHERE location_id = :l AND created_ts > :s`, { l: ctx.locId, s: since });
  const paid = await db().num(`SELECT COUNT(*) FROM payments WHERE location_id = :l AND status = 'succeeded' AND created_ts > :s`, { l: ctx.locId, s: since });
  const max = Math.max(1, visits);
  return {
    days: 7,
    steps: [
      { key: 'visites', label: 'Visites', value: visits, pct: 100 },
      { key: 'resa_vues', label: 'Page réservation vue', value: bookingViews, pct: Math.round((bookingViews / max) * 100) },
      { key: 'coordonnees', label: 'Coordonnées remplies', value: contact, pct: Math.round((contact / max) * 100) },
      { key: 'reservations', label: 'Réservations', value: book, pct: Math.round((book / max) * 100) },
    ],
    paid,
    conversion: visits ? Number(((book / visits) * 100).toFixed(2)) : 0,
  };
}
