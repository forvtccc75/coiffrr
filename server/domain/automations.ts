import { db, j, sj } from '../db/index.ts';
import { DAY, MIN, dateKey, fmtDate, fmtTime, humanWhen, minutesOfDay, startOfDayMs, todayDay } from '../lib/time.ts';
import { appLink } from '../lib/inputs.ts';
import type { Ctx } from './context.ts';
import { notify } from './notify.ts';
import { audit, refreshSegment } from './customers.ts';
import { bumpAvailabilityCache } from './availability.ts';

/**
 * Automatisations + tick horloger.
 * Tout est configurable depuis l'admin (activation, délais, canaux, plafond hebdo, heures silencieuses).
 * Les actions irréversibles (crédit client, politique d'acompte) ne s'appliquent jamais sans validation du propriétaire :
 * elles créent une `pending_actions` que le salon voit dans sa liste de tâches.
 */

export async function listAutomations(ctx: Ctx) {
  const rows = await db().all<any>(`SELECT * FROM automations WHERE location_id = :l ORDER BY id`, { l: ctx.locId });
  return rows.map((r: any) => ({ ...r, config: j(r.config_json, {}), quiet: j(r.quiet_hours, {}), is_active: !!r.is_active, requires_owner_approval: !!r.requires_owner_approval }));
}

export async function updateAutomation(ctx: Ctx, key: string, patch: { is_active?: boolean; config?: any; cooldown_hours?: number; max_per_week?: number; quiet_hours?: any; requires_owner_approval?: boolean }) {
  const q = db();
  const row = await q.one<any>(`SELECT * FROM automations WHERE location_id = :l AND key = :k`, { l: ctx.locId, k: key });
  if (!row) throw Object.assign(new Error('Automatisation inconnue'), { status: 404, code: 'introuvable' });
  await q.update('automations', row.id, {
    is_active: patch.is_active === undefined ? undefined : patch.is_active ? 1 : 0,
    cooldown_hours: patch.cooldown_hours,
    max_per_week: patch.max_per_week,
    quiet_hours: patch.quiet_hours ? sj(patch.quiet_hours) : undefined,
    requires_owner_approval: patch.requires_owner_approval === undefined ? undefined : patch.requires_owner_approval ? 1 : 0,
    config_json: patch.config ? sj({ ...j(row.config_json, {}), ...patch.config }) : undefined,
    updated_ts: Date.now(),
  });
  await audit(ctx.locId, 'owner', null, 'automation.update', 'automations', row.id, patch);
  return true;
}

async function findActive(ctx: Ctx, trigger: string) {
  return db().all<any>(`SELECT * FROM automations WHERE location_id = :l AND trigger_key = :t AND is_active = 1`, { l: ctx.locId, t: trigger });
}

/** Le déclencheur d'événement : un seul point d'entrée, utilisé par booking/waitlist/cron. */
export async function fireAutomation(ctx: Ctx, trigger: string, payload: Record<string, any> = {}) {
  const rows = await findActive(ctx, trigger);
  const fired: string[] = [];
  for (const a of rows) {
    const cfg = j<any>(a.config_json, {});
    if (a.cooldown_hours && a.last_run_ts && Date.now() - a.last_run_ts < a.cooldown_hours * 3600 * 1000) continue;
    const q = db();
    try {
      switch (a.action_type) {
        case 'send_notification': {
          const template = cfg.template ?? trigger;
          const sendAfter = cfg.delayMin ? Date.now() + cfg.delayMin * MIN : payload.sendAfter ?? undefined;
          const ids = await notify(ctx, template, {
            appointmentId: payload.appointmentId ?? null,
            customerId: payload.customerId ?? null,
            vars: { ...(cfg.vars ?? {}), ...(payload.vars ?? {}) },
            sendAfter,
            idem: cfg.idem,
          });
          if (ids.length) fired.push(`${a.key}:${ids.length}`);
          break;
        }
        case 'require_confirmation': {
          if (!payload.appointmentId) break;
          await q.update('appointments', payload.appointmentId, { confirm_required: 1, needs_action: 0 });
          await notify(ctx, 'confirm_needed', { appointmentId: payload.appointmentId, customerId: payload.customerId ?? (await q.one<any>(`SELECT customer_id FROM appointments WHERE id = :i`, { i: payload.appointmentId }))?.customer_id, sendAfter: payload.sendAfter });
          fired.push(a.key);
          break;
        }
        case 'notify_waitlist': {
          if (!payload.slot) break;
          const { replayWaitlist } = await import('./waitlist.ts');
          const out = await replayWaitlist(ctx, payload.slot);
          fired.push(`${a.key}:${out.offers}`);
          break;
        }
        case 'apply_policy': {
          if (!payload.customerId) break;
          const after = cfg.forceDepositAfter ?? 2;
          const c = await q.one<any>(`SELECT noshow_count FROM customers WHERE id = :i`, { i: payload.customerId });
          if ((c?.noshow_count ?? 0) >= after) {
            if (a.requires_owner_approval) {
              await q.insert('pending_actions', { location_id: ctx.locId, kind: 'policy_deposit', payload_json: sj({ customerId: payload.customerId, noshow: c.noshow_count }), reason: `Client avec ${c.noshow_count} no-shows : rendre l'acompte obligatoire ?`, status: 'pending', created_ts: Date.now() });
            } else {
              const tags = new Set([...j<string[]>(c.tags, []), 'acompte_obligatoire']);
              await q.update('customers', payload.customerId, { tags: sj([...tags]) });
            }
            fired.push(a.key);
          }
          break;
        }
        case 'loyalty_bonus': {
          if (!payload.customerId) break;
          const { grantPoints } = await import('./loyalty.ts');
          await grantPoints(ctx, payload.customerId, cfg.points ?? 10, cfg.label ?? 'bonus');
          fired.push(a.key);
          break;
        }
        case 'grant_reward': {
          await q.insert('pending_actions', { location_id: ctx.locId, kind: 'reward', payload_json: sj(payload), reason: `Récompense à valider (${cfg.referrerCents ?? 0} € parrain / ${cfg.refereeCents ?? 0} € filleul)`, status: 'pending', created_ts: Date.now() });
          fired.push(`${a.key}:pending`);
          break;
        }
        default:
          break;
      }
      await q.update('automations', a.id, { runs_count: a.runs_count + 1, last_run_ts: Date.now() });
    } catch (e: any) {
      console.error(`[automation ${a.key}]`, e?.message);
      await q.insert('observations', { location_id: ctx.locId, kind: 'automation', name: a.key, ms: null, status: 'error', meta_json: sj({ error: String(e?.message).slice(0, 200), payload }), ts: Date.now() });
    }
  }
  return fired;
}

/** File "qui demande une action humaine" — le back-office ne doit jamais avoir à chercher. */
export async function requiresAction(ctx: Ctx, limit = 30) {
  const q = db();
  const appts = await q.all<any>(
    `SELECT a.*, s.name AS service_name, c.first_name, c.last_name, c.phone, st.name AS staff_name
     FROM appointments a JOIN services s ON s.id = a.service_id JOIN customers c ON c.id = a.customer_id JOIN staff st ON st.id = a.staff_id
     WHERE a.location_id = :l AND a.needs_action = 1 AND a.start_ts > :n ORDER BY a.start_ts LIMIT :lim`,
    { l: ctx.locId, n: Date.now() - 2 * MIN, lim: limit },
  );
  const pending = await q.all<any>(`SELECT * FROM pending_actions WHERE location_id = :l AND status = 'pending' ORDER BY created_ts DESC LIMIT 20`, { l: ctx.locId });
  const unconfirmed = await q.all<any>(
    `SELECT a.id, a.start_ts, a.confirm_required, c.first_name, c.last_name, c.phone, s.name AS service_name
     FROM appointments a JOIN customers c ON c.id = a.customer_id JOIN services s ON s.id = a.service_id
     WHERE a.location_id = :l AND a.status = 'booked' AND a.confirm_required = 1 AND a.confirmed_ts IS NULL AND a.start_ts BETWEEN :n AND :h ORDER BY a.start_ts LIMIT 20`,
    { l: ctx.locId, n: Date.now(), h: Date.now() + 3 * DAY },
  );
  return { appts, pending: pending.map((p: any) => ({ ...p, payload: j(p.payload_json, {}) })), unconfirmed };
}

export async function resolvePendingAction(ctx: Ctx, id: number, approve: boolean, actorId: number | null) {
  const q = db();
  const p = await q.one<any>(`SELECT * FROM pending_actions WHERE id = :i`, { i: id });
  if (!p) throw new Error('Introuvable');
  await q.update('pending_actions', p.id, { status: approve ? 'approved' : 'rejected', decided_ts: Date.now(), decided_by: actorId });
  if (approve) {
    const payload = j<any>(p.payload_json, {});
    if (p.kind === 'policy_deposit' && payload.customerId) {
      const c = await q.one<any>(`SELECT tags FROM customers WHERE id = :i`, { i: payload.customerId });
      await q.update('customers', payload.customerId, { tags: sj([...new Set([...j<string[]>(c?.tags, []), 'acompte_obligatoire'])]) });
    }
    if (p.kind === 'unhappy_client' && payload.reviewId) {
      await q.update('reviews', payload.reviewId, { status: 'to_contact' });
    }
  }
  await audit(ctx.locId, 'owner', actorId, approve ? 'pending.approve' : 'pending.reject', 'pending_actions', p.id, { kind: p.kind });
  return true;
}

/** ── LE TICK : tout ce qui doit se passer sans que personne n'y touche ───────── */
export interface TickReport {
  dispatched: number;
  expiredOffers: number;
  noShows: number;
  autoComplete: number;
  rebook: number;
  winback: number;
  birthdays: number;
  draftsRecovered: number;
  /** brouillons abandonnés qu'on n'a pas su traiter (aucun ne doit geler le tick) */
  draftErrors: number;
  unconfirmedReleased: number;
  segmentsRefreshed: number;
  ts: number;
}

export async function tick(opts: { ctx?: Ctx; full?: boolean } = {}): Promise<TickReport> {
  const ctx = opts.ctx ?? (await (await import('./context.ts')).loadCtx());
  const q = db();
  const now = Date.now();
  const rep: TickReport = { dispatched: 0, expiredOffers: 0, noShows: 0, autoComplete: 0, rebook: 0, winback: 0, birthdays: 0, draftsRecovered: 0, draftErrors: 0, unconfirmedReleased: 0, segmentsRefreshed: 0, ts: now };

  // 1) notifications dues
  const { dispatchNow } = await import('./notify.ts');
  const d = await dispatchNow(ctx, 60);
  rep.dispatched = d.sent;

  // 2) offres waitlist expirées → proposition au suivant
  const { expireStaleOffers } = await import('./waitlist.ts');
  rep.expiredOffers = (await expireStaleOffers(ctx)).expired;

  // 3) no-shows : fin de grâce dépassée, on libère + on recycle en waitlist
  const grace = ctx.policy.noShowGraceMin * MIN;
  const late = await q.all<any>(`SELECT id FROM appointments WHERE location_id = :l AND status IN ('booked','confirmed','waiting_client') AND end_ts < :n LIMIT 40`, { l: ctx.locId, n: now - grace });
  for (const a of late) {
    const { markNoShow } = await import('./booking.ts');
    await markNoShow(ctx, a.id, 'system');
    rep.noShows++;
  }

  // 4) clôture automatique des RDV terminés non saisis (fidélité + demande d'avis continuent de tourner)
  const autoAfter = (ctx.policy as any).autoCompleteAfterMin ?? 0;
  if (autoAfter > 0) {
    const toClose = await q.all<any>(`SELECT id FROM appointments WHERE location_id = :l AND status IN ('booked','confirmed') AND end_ts < :n LIMIT 40`, { l: ctx.locId, n: now - autoAfter * MIN });
    for (const a of toClose) {
      const { completeBooking } = await import('./booking.ts');
      await completeBooking(ctx, a.id);
      rep.autoComplete++;
    }
  }

  // 5) non-confirmés à J-1 : dernier appel, puis le créneau redevient vendable
  const confirmDeadline = ctx.policy.confirmOffsets[0] ?? 1440;
  // Le calcul se fait en JS, pas en SQL : `:deadline * :min` échouait sur Postgres
  // (« operator is not unique: unknown * unknown », deux paramètres liés en texte), et le
  // rappel de confirmation du J-1 ne partait jamais en production.
  const horizonMs = confirmDeadline * MIN;
  const stale = await q.all<any>(
    `SELECT a.id, a.customer_id, a.start_ts FROM appointments a
     WHERE a.location_id = :l AND a.status = 'booked' AND a.confirm_required = 1 AND a.confirmed_ts IS NULL AND a.start_ts > :n AND a.start_ts - :n < :horizon LIMIT 20`,
    { l: ctx.locId, n: now, horizon: horizonMs },
  );
  for (const a of stale) {
    const already = await q.one(`SELECT id FROM notifications WHERE appointment_id = :i AND kind = 'confirm_needed' AND created_ts > :s`, { i: a.id, s: now - 6 * 3600 * 1000 });
    if (already) continue;
    await notify(ctx, 'confirm_needed', { appointmentId: a.id, customerId: a.customer_id, sendAfter: now, idem: `appt:${a.id}:last_call` });
    rep.dispatched++;
  }

  // 6) rebooking intelligent : habitude dépassée → suggestion (1 seule fois par cycle)
  const rebookCfg = await q.one<any>(`SELECT * FROM automations WHERE location_id = :l AND key = 'auto_rebook' AND is_active = 1`, { l: ctx.locId });
  if (rebookCfg && (await rateOk(ctx, 'rebook_suggestion', 1))) {
    const due = await q.all<any>(
      `SELECT id, last_visit_ts, avg_days_between, preferred_staff_id, preferred_service_id FROM customers
       WHERE location_id = :l AND deleted_ts IS NULL AND last_visit_ts IS NOT NULL AND visits_count > 0
         AND last_visit_ts < :cut
         AND id NOT IN (SELECT customer_id FROM notifications WHERE kind = 'rebook_suggestion' AND created_ts > :recent)
       ORDER BY last_visit_ts DESC LIMIT 12`,
      { l: ctx.locId, cut: now - DAY * 20, recent: now - 21 * DAY },
    );
    for (const c of due) {
      const habit = c.avg_days_between ?? 28;
      if (now - c.last_visit_ts < habit * DAY) continue;
      await notify(ctx, 'rebook_suggestion', { customerId: c.id, vars: { jours: String(Math.round((now - c.last_visit_ts) / DAY)) } });
      rep.rebook++;
    }
  }

  // 7) win-back (clients endormis) — plafonné, jamais de spam
  const winCfg = await q.one<any>(`SELECT * FROM automations WHERE location_id = :l AND key = 'auto_winback' AND is_active = 1`, { l: ctx.locId });
  if (winCfg && (await rateOk(ctx, 'winback', 1))) {
    const afterDays = j<any>(winCfg.config_json, {}).afterDays ?? 45;
    const rows = await q.all<any>(
      `SELECT id FROM customers WHERE location_id = :l AND deleted_ts IS NULL AND consent_marketing_sms = 1
         AND last_visit_ts IS NOT NULL AND last_visit_ts < :cut
         AND id NOT IN (SELECT customer_id FROM notifications WHERE kind = 'winback' AND created_ts > :recent)
       ORDER BY last_visit_ts DESC LIMIT 10`,
      { l: ctx.locId, cut: now - afterDays * DAY, recent: now - 90 * DAY },
    );
    for (const r of rows) {
      await notify(ctx, 'winback', { customerId: r.id });
      rep.winback++;
    }
  }

  // 8) anniversaires
  const today = todayDay().slice(5);
  const bdays = await q.all<any>(`SELECT id FROM customers WHERE location_id = :l AND birth_day LIKE :p AND deleted_ts IS NULL LIMIT 25`, { l: ctx.locId, p: `%${today}` });
  for (const b of bdays) {
    const { maybeGiftBirthday } = await import('./loyalty.ts');
    if (await maybeGiftBirthday(ctx, b.id)) rep.birthdays++;
  }

  // 9) paniers abandonnés : uniquement email fourni + opt-in, après le délai, une fois
  const draftCfg = await q.one<any>(`SELECT * FROM automations WHERE location_id = :l AND key = 'auto_draft_recover' AND is_active = 1`, { l: ctx.locId });
  if (draftCfg && ctx.features.abandonRecovery) {
    const afterMin = j<any>(draftCfg.config_json, {}).afterMin ?? 40;
    const drafts = await q.all<any>(
      `SELECT * FROM booking_drafts WHERE location_id = :l AND status = 'open' AND contact_ts IS NOT NULL AND email IS NOT NULL
         AND updated_ts < :cut AND recovered_ts IS NULL ORDER BY updated_ts DESC LIMIT 15`,
      { l: ctx.locId, cut: now - afterMin * MIN },
    );
    for (const dr of drafts) {
      // Un brouillon peut très bien venir d'un inconnu (personne ne s'est inscrit) : `cust` est
      // alors null. L'ancien garde (`cust?.consent || {}`, toujours vrai à cause du `{}`) laissait
      // passer le `cust.id` suivant et faisait tomber TOUT le tick du salon — donc aussi le
      // rattrapage de la waitlist, les segments et les anniversaires. Mesuré : un seul brouillon
      // sans client gelait toutes les automatisations. Ici : on marque, on passe, on ne meurt pas.
      let mailOptIn = false;
      try {
        // Le brouillon garde le téléphone SAISI (« 06 97 21 23 45 »), les clients gardent la forme
        // normalisée (« 33697212345 ») : comparer les deux bruts ne matchait jamais, et toute la
        // relance de panier abandonné était morte en silence. On normalise, et on tente aussi l'e-mail.
        const { normalizePhone, normalizeEmail } = await import('../lib/inputs.ts');
        const pn = dr.phone ? normalizePhone(String(dr.phone)) : '';
        const en = dr.email ? normalizeEmail(String(dr.email)) : '';
        const cust =
          (pn ? await q.one<any>(`SELECT id, first_name, consent_marketing_email FROM customers WHERE location_id = :l AND phone_norm = :p AND deleted_ts IS NULL`, { l: ctx.locId, p: pn }) : null) ??
          (en ? await q.one<any>(`SELECT id, first_name, consent_marketing_email FROM customers WHERE location_id = :l AND email_norm = :e AND deleted_ts IS NULL`, { l: ctx.locId, e: en }) : null);
        if (!cust) {
          await q.update('booking_drafts', dr.id, { status: 'skipped_no_customer', recovered_ts: now });
          continue;
        }
        mailOptIn = !!cust.consent_marketing_email;
        if (!mailOptIn) {
          await q.update('booking_drafts', dr.id, { status: 'skipped_no_consent', recovered_ts: now });
          continue;
        }
        await notify(ctx, 'draft_abandon', {
          customerId: cust.id,
          vars: { slot: dr.slot_start_ts ? humanWhen(dr.slot_start_ts) : '', prenom: dr.first_name ?? cust.first_name, draftToken: `d${dr.id}-${String(dr.visitor_id ?? '').slice(0, 6)}` },
        });
        await q.update('booking_drafts', dr.id, { status: 'recovered', recovered_ts: now });
        rep.draftsRecovered++;
      } catch (e: any) {
        // Un panier abandonné cassé ne doit jamais geler le reste du tick.
        await q.update('booking_drafts', dr.id, { status: 'skipped_error', recovered_ts: now }).catch(() => undefined);
        rep.draftErrors = (rep.draftErrors ?? 0) + 1;
        console.error(`[cron draft ${dr.id}]`, e?.message);
      }
    }
  }

  // 10) promesses waitlist : capacité nouvelle → on rappelle ceux qui attendent
  const { fulfillPromises } = await import('./waitlist.ts');
  await fulfillPromises(ctx);
  if (opts.full) {
    const segs = await q.all<any>(`SELECT id FROM customers WHERE location_id = :l AND updated_ts < :old LIMIT 25`, { l: ctx.locId, old: now - 2 * DAY });
    for (const s of segs) {
      await refreshSegment(s.id);
      rep.segmentsRefreshed++;
    }
  }

  const repErrors = rep.draftErrors;
  await q.insert('observations', { location_id: ctx.locId, kind: 'cron', name: 'tick', ms: Date.now() - now, status: repErrors ? 'warn' : 'ok', meta_json: sj(rep), ts: now });
  await q.exec(`INSERT INTO scheduler_state (key, value, updated_ts) VALUES ('last_tick', :v, :t) ON CONFLICT(key) DO UPDATE SET value = :v2, updated_ts = :t2`, { v: now, t: now, v2: now, t2: now });
  void fmtDate;
  void bumpAvailabilityCache;
  void dateKey;
  void startOfDayMs;
  void todayDay;
  return rep;
}

async function rateOk(ctx: Ctx, kind: string, maxPerWeek: number) {
  const n = await db().num(`SELECT COUNT(*) FROM notifications WHERE location_id = :l AND kind = :k AND created_ts > :s AND status != 'cancelled'`, { l: ctx.locId, k: kind, s: Date.now() - 7 * DAY });
  return n < Math.max(1, maxPerWeek) * 40; // plafond global doux par salon/semaine (par client : throttle dans notify)
}

export { minutesOfDay };
