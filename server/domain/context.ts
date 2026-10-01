import { db, j, type Q } from '../db/index.ts';
import { env } from '../lib/env.ts';
import { DAY, MIN, atLocal, dateKey, dow, hhmm, minFromHHMM, startOfDayMs } from '../lib/time.ts';

/**
 * Contexte salon = tout ce qui détermine l'offre et les règles.
 * Chargé une fois par requête, mis en cache 20 s (serverless-friendly) et invalidé
 * à chaque écriture admin. En cas de doute, la vérité vient de la base.
 */

export interface Policy {
  slotStepMin: number;
  leadTimeMin: number;
  horizonDays: number;
  cancelCutoffMin: number;
  noShowGraceMin: number;
  confirmRequired: boolean;
  confirmOffsets: number[];
  reminderOffsets: number[];
  deposit: { mode: 'none' | 'fixed' | 'percent' | 'full'; amountCents: number; percent: number; aboveCents: number };
  requireDepositForServices: string[];
  maxActivePerCustomer: number;
  blockSameDaySameService: boolean;
  bufferMin: number;
  prepDefaultMin: number;
  cleanupDefaultMin: number;
  waitlistOfferTtlMin: number;
  waitlistOfferMaxActive: number;
  escalationAfterMin: number;
  noShowDepositEscalation: number;
  maxConcurrentSlotsPerVisitor: number;
}

export interface Features {
  waitlist: boolean;
  loyalty: boolean;
  referrals: boolean;
  giftCards: boolean;
  membership: boolean;
  priorityBooking: boolean;
  deposits: boolean;
  reviews: boolean;
  walkin: boolean;
  upsell: boolean;
  smartReminders: boolean;
  abandonRecovery: boolean;
  calendarSync: boolean;
}

export const DEFAULT_POLICY: Policy = {
  slotStepMin: 10,
  leadTimeMin: 25,
  horizonDays: 21,
  cancelCutoffMin: 4 * 3600,
  noShowGraceMin: 12,
  confirmRequired: true,
  confirmOffsets: [1440],
  reminderOffsets: [4320, 1440, 180],
  deposit: { mode: 'percent', amountCents: 1000, percent: 30, aboveCents: 4500 },
  requireDepositForServices: [],
  maxActivePerCustomer: 3,
  blockSameDaySameService: true,
  bufferMin: 0,
  prepDefaultMin: 0,
  cleanupDefaultMin: 5,
  waitlistOfferTtlMin: 12,
  waitlistOfferMaxActive: 1,
  escalationAfterMin: 45,
  noShowDepositEscalation: 2,
  maxConcurrentSlotsPerVisitor: 2,
};

export const DEFAULT_FEATURES: Features = {
  waitlist: true,
  loyalty: true,
  referrals: true,
  giftCards: true,
  membership: false,
  priorityBooking: true,
  deposits: true,
  reviews: true,
  walkin: true,
  upsell: true,
  smartReminders: true,
  abandonRecovery: true,
  calendarSync: false,
};

export interface ServiceRow {
  id: number;
  key: string;
  name: string;
  category: string;
  short_desc?: string | null;
  description?: string | null;
  base_price_cents: number;
  base_duration_min: number;
  prep_min: number;
  cleanup_min: number;
  level: string;
  gender: string;
  age: string;
  price_from_label?: string | null;
  problem?: string | null;
  solution?: string | null;
  faq: { q: string; a: string }[];
  popular_rank: number;
  seo_title?: string | null;
  seo_desc?: string | null;
}

export interface OfferingRow {
  id: number;
  service_id: number;
  staff_id: number | null;
  name: string;
  description?: string | null;
  duration_min: number;
  price_cents: number;
  is_popular: boolean;
  addon_ids: number[];
  display_order: number;
}

export interface StaffRow {
  id: number;
  name: string;
  slug: string;
  role_key: string;
  bio?: string | null;
  title?: string | null;
  avatar_url?: string | null;
  color_hex: string;
  is_active: boolean;
  accept_new_clients: boolean;
  service_ids: number[];
  commission_pct: number;
}

export interface Ctx {
  loc: any;
  locId: number;
  slug: string;
  name: string;
  brand: any;
  address: any;
  hours: Record<string, [string, string][]>;
  policy: Policy;
  features: Features;
  holidays: Record<string, string>;
  staff: StaffRow[];
  services: ServiceRow[];
  offerings: OfferingRow[];
  addons: any[];
  /** coordonnées pratiques, exposées tels que les notifications et le front les consomment */
  phone: string | null;
  quietFrom: string;
  quietTo: string;
  loadedAt: number;
}

let cache: { key: string; ctx: Ctx; exp: number } | null = null;
export function invalidateCtx() {
  cache = null;
}

export async function loadCtx(slugOrId: string | number = env.demoSlug): Promise<Ctx> {
  const key = String(slugOrId);
  if (cache && cache.key === key && cache.exp > Date.now()) return cache.ctx;
  const q: Q = db();
  const loc =
    (await q.one(`SELECT * FROM locations WHERE slug = :k`, { k: key })) ??
    (await q.one(`SELECT * FROM locations WHERE id = :k`, { k: Number(slugOrId) || 1 }));
  if (!loc) throw new Error('Salon introuvable');

  const [staffRaw, services, offerings, addonsRaw] = await Promise.all([
    q.all(`SELECT * FROM staff WHERE location_id = :l AND is_active = 1 ORDER BY display_order, id`, { l: loc.id }),
    q.all(`SELECT * FROM services WHERE location_id = :l AND is_active = 1 ORDER BY display_order, id`, { l: loc.id }),
    q.all(`SELECT * FROM offerings WHERE location_id = :l AND is_active = 1 ORDER BY display_order, id`, { l: loc.id }),
    q.all(`SELECT * FROM addons WHERE location_id = :l AND is_active = 1 ORDER BY display_order, id`, { l: loc.id }),
  ]);

  const skills = await q.all(`SELECT staff_id, service_id FROM staff_skills WHERE staff_id IN (${staffRaw.map((s: any) => s.id).join(',') || '0'})`, {});
  const staff: StaffRow[] = staffRaw.map((s: any) => ({
    id: s.id,
    name: s.name,
    slug: s.slug,
    role_key: s.role_key,
    bio: s.bio,
    title: s.title,
    avatar_url: s.avatar_url,
    color_hex: s.color_hex,
    is_active: !!s.is_active,
    accept_new_clients: !!s.accept_new_clients,
    commission_pct: s.commission_pct,
    service_ids: skills.filter((k: any) => k.staff_id === s.id).map((k: any) => k.service_id),
  }));

  const ctx: Ctx = {
    loc,
    locId: loc.id,
    slug: loc.slug,
    name: loc.name,
    brand: j(loc.brand_json, {}),
    address: j(loc.address_json, {}),
    hours: j(loc.hours_json, {}),
    policy: { ...DEFAULT_POLICY, ...j(loc.policy_json, {}) },
    features: { ...DEFAULT_FEATURES, ...j(loc.features_json, {}) },
    holidays: Object.fromEntries((j(loc.holidays_json, []) as any[]).map((h) => [h.day, h.name])),
    staff,
    addons: addonsRaw.map((a: any) => ({ ...a, price_cents: a.price_cents, duration_min: a.duration_min })),
    phone: loc.phone ?? null,
    quietFrom: j<any>(loc.policy_json, {})?.quietHours?.from ?? '21:00',
    quietTo: j<any>(loc.policy_json, {})?.quietHours?.to ?? '08:30',
    services: services.map(mapService),
    offerings: offerings.map((o: any) => ({
      id: o.id,
      service_id: o.service_id,
      staff_id: o.staff_id ?? null,
      name: o.name,
      description: o.description,
      duration_min: o.duration_min,
      price_cents: o.price_cents,
      is_popular: !!o.is_popular,
      addon_ids: j(o.addon_ids, [] as number[]),
      display_order: o.display_order,
    })),
    loadedAt: Date.now(),
  };
  cache = { key, ctx, exp: Date.now() + 20_000 };
  return ctx;
}

function mapService(s: any): ServiceRow {
  return {
    id: s.id,
    key: s.key,
    name: s.name,
    category: s.category,
    short_desc: s.short_desc,
    description: s.description,
    base_price_cents: s.base_price_cents,
    base_duration_min: s.base_duration_min,
    prep_min: s.prep_min,
    cleanup_min: s.cleanup_min,
    level: s.level,
    gender: s.gender,
    age: s.age,
    price_from_label: s.price_from_label,
    problem: s.problem,
    solution: s.solution,
    faq: j(s.faq_json, []),
    popular_rank: s.display_order,
    seo_title: s.seo_title ?? null,
    seo_desc: s.seo_desc ?? null,
  };
}

export const serviceByKey = (ctx: Ctx, key: string) => ctx.services.find((s) => s.key === key);
export const offeringById = (ctx: Ctx, id: number) => ctx.offerings.find((o) => o.id === id);
export const serviceById = (ctx: Ctx, id: number) => ctx.services.find((s) => s.id === id);
export const staffById = (ctx: Ctx, id: number | null) => (id == null ? null : ctx.staff.find((s) => s.id === id) ?? null);
export const addonById = (ctx: Ctx, id: number) => ctx.addons.find((a: any) => a.id === id);

/** Créneaux ouverts par un membre de l'équipe : horaires individuels sinon horaires du salon. */
export async function staffDayWindows(ctx: Ctx, staffId: number, day: string): Promise<{ windows: [number, number][]; closedReason: string | null }> {
  const q = db();
  const base = startOfDayMs(day);
  const wd = dow(base);
  const override = await q.one(
    `SELECT * FROM day_overrides WHERE location_id = :l AND (staff_id = :s OR staff_id IS NULL) AND day = :d ORDER BY staff_id DESC LIMIT 1`,
    { l: ctx.locId, s: staffId, d: day },
  );
  const holiday = ctx.holidays[day];
  if (holiday || override?.kind === 'closed') return { windows: [], closedReason: holiday ? `Férié — ${holiday}` : override?.reason || 'Fermé' };
  if (override?.kind === 'open' || override?.kind === 'extra') {
    return {
      windows: [[atLocal(day, override.start_min ?? 0), atLocal(day, override.end_min ?? 0)]],
      closedReason: null,
    };
  }
  const own = await q.all(`SELECT * FROM working_hours WHERE location_id = :l AND staff_id = :s AND dow = :d`, { l: ctx.locId, s: staffId, d: wd });
  if (own.length) return { windows: own.map((r: any) => [atLocal(day, r.start_min), atLocal(day, r.end_min)]), closedReason: null };
  const locRows = await q.all(`SELECT * FROM working_hours WHERE location_id = :l AND staff_id IS NULL AND dow = :d`, { l: ctx.locId, d: wd });
  if (locRows.length) return { windows: locRows.map((r: any) => [atLocal(day, r.start_min), atLocal(day, r.end_min)]), closedReason: null };
  const fromHours = (ctx.hours[String(wd)] ?? []) as [string, string][];
  if (!fromHours.length) return { windows: [], closedReason: 'Fermé ce jour' };
  return { windows: fromHours.map(([a, b]) => [atLocal(day, minFromHHMM(a)), atLocal(day, minFromHHMM(b))]), closedReason: null };
}

export async function staffDayBreaks(ctx: Ctx, staffId: number, day: string): Promise<[number, number][]> {
  const q = db();
  const base = startOfDayMs(day);
  const wd = dow(base);
  const own = await q.all(`SELECT * FROM shift_breaks WHERE location_id = :l AND staff_id = :s AND dow = :d`, { l: ctx.locId, s: staffId, d: wd });
  const rows = own.length ? own : await q.all(`SELECT * FROM shift_breaks WHERE location_id = :l AND staff_id IS NULL AND dow = :d`, { l: ctx.locId, d: wd });
  return rows.map((r: any) => [atLocal(day, r.start_min), atLocal(day, r.end_min)]);
}

export function subtract(intervals: [number, number][], cuts: [number, number][]): [number, number][] {
  let out = intervals.filter(([a, b]) => b > a).map(([a, b]) => [a, b] as [number, number]);
  for (const [c0, c1] of cuts) {
    if (!(c1 > c0)) continue;
    const next: [number, number][] = [];
    for (const [a, b] of out) {
      if (c1 <= a || c0 >= b) {
        next.push([a, b]);
        continue;
      }
      if (c0 > a) next.push([a, c0]);
      if (c1 < b) next.push([c1, b]);
    }
    out = next;
  }
  return out;
}

/** Durée d'occupation réelle du fauteuil = RDV + préparation avant + nettoyage après. */
export function occupancy(a: { start_ts: number; end_ts: number; prep_min?: number; cleanup_min?: number }): [number, number] {
  return [a.start_ts - (a.prep_min ?? 0) * MIN, a.end_ts + (a.cleanup_min ?? 0) * MIN];
}

export function windowLabel(w: [number, number]) {
  return `${hhmm(Math.floor((w[0] - startOfDayMs(dateKey(w[0]))) / MIN))}–${hhmm(Math.floor((w[1] - startOfDayMs(dateKey(w[1]))) / MIN))}`;
}

export { DAY, MIN };
