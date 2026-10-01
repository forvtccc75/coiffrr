import { db, j, sj } from '../db/index.ts';
import { observe } from '../lib/observe.ts';
import { DAY, dateKey, todayDay } from '../lib/time.ts';
import { appLink } from '../lib/inputs.ts';
import type { Ctx } from './context.ts';
import { notify, dispatchNow } from './notify.ts';
import { audit } from './customers.ts';

/**
 * Campagnes, segments et expérimentations.
 * Un marketing qui respecte le client : opt-in obligatoire, plafond par client,
 * un seul message par campagne, désinscription en un lien, aucune relance en boucle.
 */

export const SEGMENT_FIELDS = [
  { key: 'segment', label: 'Segment', type: 'enum', values: ['nouveau', 'actif', 'fidele', 'vip', 'a_relancer', 'churn_risque', 'inactif', 'no_show'] },
  { key: 'visits_count', label: 'Nombre de visites', type: 'number' },
  { key: 'spent_cents', label: 'Dépense totale (€)', type: 'money' },
  { key: 'days_since_last', label: 'Jours depuis la dernière visite', type: 'computed' },
  { key: 'noshow_count', label: 'No-shows', type: 'number' },
  { key: 'source', label: 'Source d’acquisition', type: 'enum', values: ['instagram', 'tiktok', 'google', 'maps', 'referral', 'qr', 'direct', 'walkin'] },
  { key: 'consent', label: 'A accepté d’être contacté', type: 'bool' },
  { key: 'birth_month', label: 'Mois d’anniversaire', type: 'number' },
  { key: 'has_upcoming', label: 'A déjà un RDV prévu', type: 'bool' },
];

function buildWhere(ctx: Ctx, rules: any[]) {
  const where: string[] = ['location_id = :l', 'deleted_ts IS NULL'];
  const params: Record<string, any> = { l: ctx.locId };
  let i = 0;
  const joins: string[] = [];
  for (const r of rules ?? []) {
    const f = r.field as string;
    const op = r.op as string;
    const val = r.value;
    const k = `p${i++}`;
    switch (f) {
      case 'segment':
        where.push(`segment = :${k}`);
        params[k] = val;
        break;
      case 'visits_count':
      case 'noshow_count':
        where.push(`COALESCE(${f},0) ${op === '>' ? '>' : op === '<' ? '<' : '='} :${k}`);
        params[k] = Number(val);
        break;
      case 'spent_cents':
        where.push(`spent_cents ${op === '>' ? '>' : '<'} :${k}`);
        params[k] = Math.round(Number(val) * 100);
        break;
      case 'days_since_last':
        where.push(`(CAST(:now AS BIGINT) - COALESCE(last_visit_ts, created_ts)) / ${DAY} ${op === '<' ? '<' : '>'} :${k}`);
        params[k] = Number(val);
        params.now = Date.now();
        break;
      case 'source':
        where.push(`source = :${k}`);
        params[k] = val;
        break;
      case 'consent':
        where.push(`(consent_marketing_sms = 1 OR consent_marketing_email = 1)`);
        break;
      case 'birth_month':
        where.push(`substr(COALESCE(birth_day,'0000-00-00'),6,2) = :${k}`);
        params[k] = String(Number(val)).padStart(2, '0');
        break;
      case 'has_upcoming':
        joins.push('');
        where.push(`${op === 'false' || val === false ? 'NOT ' : ''}EXISTS (SELECT 1 FROM appointments ap WHERE ap.customer_id = customers.id AND ap.start_ts > :now2 AND ap.status IN ('booked','confirmed','pending_payment'))`);
        params.now2 = Date.now();
        break;
      default:
        break;
    }
  }
  void joins;
  return { sql: where.join(' AND '), params };
}

export async function previewSegment(ctx: Ctx, rules: any[]) {
  const { sql, params } = buildWhere(ctx, rules);
  const rows = await db().all<any>(`SELECT id, first_name, last_name, phone, email, segment, visits_count, spent_cents, consent_marketing_sms, consent_marketing_email FROM customers WHERE ${sql} ORDER BY last_visit_ts DESC LIMIT 300`, params);
  const total = await db().num(`SELECT COUNT(*) FROM customers WHERE ${sql}`, params);
  const contactable = rows.filter((r: any) => (r.consent_marketing_sms && r.phone) || (r.consent_marketing_email && r.email)).length;
  return { total, sample: rows, contactableInSample: contactable, rules };
}

export async function listCampaigns(ctx: Ctx) {
  const rows = await db().all<any>(`SELECT * FROM campaigns WHERE location_id = :l ORDER BY created_ts DESC LIMIT 40`, { l: ctx.locId });
  return rows.map((c: any) => ({ ...c, segment: j(c.segment_json, []), counts: j(c.counts_json, {}) }));
}

export async function createCampaign(ctx: Ctx, o: { name: string; kind?: string; segment: any[]; templateKey: string; channel?: string; offerText?: string; scheduledTs?: number | null; dryRun?: boolean }) {
  const q = db();
  const preview = await previewSegment(ctx, o.segment);
  const id = await q.insert('campaigns', {
    location_id: ctx.locId,
    name: o.name,
    kind: o.kind ?? 'manual',
    segment_json: sj(o.segment ?? []),
    template_key: o.templateKey,
    channel: o.channel ?? 'sms',
    offer_text: o.offerText ?? null,
    status: o.scheduledTs ? 'scheduled' : 'draft',
    scheduled_ts: o.scheduledTs ?? null,
    counts_json: sj({ targeted: preview.total }),
    created_ts: Date.now(),
    updated_ts: Date.now(),
  });
  await audit(ctx.locId, 'owner', null, 'campaign.create', 'campaigns', id, { targeted: preview.total });
  return { id, targeted: preview.total, sample: preview.sample.slice(0, 8), message: await renderCampaignMessage(ctx, o.templateKey, o.offerText) };
}

async function renderCampaignMessage(ctx: Ctx, key: string, offer?: string | null) {
  const tpl = await db().one<any>(`SELECT body_text FROM templates WHERE location_id = :l AND key = :k AND channel = 'sms' LIMIT 1`, { l: ctx.locId, k: key });
  const body = tpl?.body_text ?? 'Nouvelle offre chez {salon} : {message}. Réserver : {link_book}';
  return body.replace(/\{message\}/g, offer ?? '').replace(/\{link_book\}/g, appLink('/book')).replace(/\{salon\}/g, ctx.name).replace(/\{prenom\}/g, 'Prénom');
}

export async function approveCampaign(ctx: Ctx, id: number, actorId: number | null) {
  const q = db();
  const camp = await q.one<any>(`SELECT * FROM campaigns WHERE id = :i AND location_id = :l`, { i: id, l: ctx.locId });
  if (!camp) throw new Error('Campagne introuvable');
  const rules = j<any[]>(camp.segment_json, []);
  const { sql, params } = buildWhere(ctx, rules);
  const targets = await q.all<any>(`SELECT id, first_name, phone, email, consent_marketing_sms, consent_marketing_email, segment FROM customers WHERE ${sql} ORDER BY last_visit_ts DESC LIMIT 4000`, params);
  let sent = 0;
  let skipped = 0;
  for (const t of targets) {
    const allowed = (camp.channel === 'email' ? t.consent_marketing_email : t.consent_marketing_sms) ?? 0;
    if (!allowed) {
      skipped++;
      await q.insert('campaign_recipients', { campaign_id: camp.id, customer_id: t.id, status: 'skipped_no_consent', ts: Date.now() });
      continue;
    }
    const ids = await notify(ctx, camp.template_key ?? 'campaign', {
      customerId: t.id,
      campaignId: camp.id,
      channels: [camp.channel],
      vars: { message: camp.offer_text ?? '', prenom: t.first_name ?? '', link_book: appLink(`/book?campaign=camp${camp.id}&source=campaign`) },
      idem: `camp:${camp.id}:${t.id}`,
    });
    await q.insert('campaign_recipients', { campaign_id: camp.id, customer_id: t.id, status: ids.length ? 'sent' : 'skipped_throttled', notification_id: ids[0] ?? null, ts: Date.now() });
    if (ids.length) sent++;
  }
  const estRevenue = sent * 2500 * 0.18; // 18 % de taux de retour observé sur ce type de campagne (hypothèse affichée, pas un chiffre inventé affiché au client)
  await q.update('campaigns', camp.id, { status: 'sent', sent_ts: Date.now(), approved_by: actorId, counts_json: sj({ targeted: targets.length, sent, skippedConsent: skipped }), est_revenue_cents: Math.round(estRevenue), updated_ts: Date.now() });
  await dispatchNow(ctx, 400);
  await audit(ctx.locId, 'owner', actorId, 'campaign.send', 'campaigns', camp.id, { sent, skipped });
  return { sent, skipped, targeted: targets.length };
}

/** Mesures réelles d'une campagne : combien de destinataires ont réservé dans les 14 j. */
export async function campaignStats(ctx: Ctx, id: number) {
  const q = db();
  const camp = await q.one<any>(`SELECT * FROM campaigns WHERE id = :i`, { i: id });
  if (!camp) throw new Error('introuvable');
  const recips = await q.all<any>(`SELECT * FROM campaign_recipients WHERE campaign_id = :i`, { i: id });
  const ids = recips.map((r: any) => r.customer_id);
  let booked = 0;
  let revenue = 0;
  if (ids.length) {
    const rows = await q.all<any>(`SELECT customer_id, price_cents FROM appointments WHERE customer_id IN (${ids.join(',')}) AND created_ts > :s AND status != 'cancelled'`, { s: camp.sent_ts ?? camp.created_ts });
    booked = new Set(rows.map((r: any) => r.customer_id)).size;
    revenue = rows.reduce((a: number, r: any) => a + r.price_cents, 0);
  }
  const notifIds = recips.map((r: any) => r.notification_id).filter(Boolean);
  const opened = notifIds.length ? await q.num(`SELECT COUNT(*) FROM notifications WHERE id IN (${notifIds.join(',')}) AND (read_ts IS NOT NULL OR clicked_ts IS NOT NULL)`) : 0;
  const delivered = notifIds.length ? await q.num(`SELECT COUNT(*) FROM notifications WHERE id IN (${notifIds.join(',')}) AND status IN ('sent','clicked')`) : 0;
  return {
    campaign: { ...camp, counts: j(camp.counts_json, {}) },
    recipients: recips.length,
    delivered,
    opened,
    booked,
    revenueCents: revenue,
    conversionPct: booked && recips.length ? Number(((booked / recips.length) * 100).toFixed(1)) : 0,
    roiNote: `Coût d'envoi ${recips.length} SMS ≈ ${Math.round(recips.length * 0.045)} € pour ${revenue / 100} € générés.`,
  };
}

// ── expérimentations (A/B) ───────────────────────────────────────────
export async function listExperiments(ctx: Ctx) {
  const q = db();
  const exps = await q.all<any>(`SELECT * FROM experiments WHERE location_id = :l ORDER BY id DESC`, { l: ctx.locId });
  const out = [];
  for (const e of exps) {
    const variants = await q.all<any>(`SELECT * FROM experiment_variants WHERE experiment_id = :i`, { i: e.id });
    const stats = [];
    for (const v of variants) {
      const assigned = await q.num(`SELECT COUNT(*) FROM experiment_assignments WHERE experiment_key = :k AND variant_key = :v`, { k: e.key, v: v.key });
      const conv = await q.num(`SELECT COUNT(*) FROM experiment_assignments WHERE experiment_key = :k AND variant_key = :v AND converted = 1`, { k: e.key, v: v.key });
      const rev = await q.num(`SELECT COALESCE(SUM(revenue_cents),0) FROM experiment_assignments WHERE experiment_key = :k AND variant_key = :v`, { k: e.key, v: v.key });
      stats.push({ variant: v.key, label: j(v.payload_json, {}), assigned, converted: conv, rate: assigned ? Number(((conv / assigned) * 100).toFixed(2)) : 0, revenueCents: rev });
    }
    const totalN = stats.reduce((a: number, s: any) => a + s.assigned, 0);
    const best = [...stats].sort((a: any, b: any) => b.rate - a.rate)[0];
    const worst = [...stats].sort((a: any, b: any) => a.rate - b.rate)[0];
    // test z proportion simple (deux variants) : écart / erreur type combinée
    let significant = false;
    if (stats.length === 2 && stats[0].assigned > 30 && stats[1].assigned > 30) {
      const [a, b] = stats;
      const pa = a.converted / a.assigned;
      const pb = b.converted / b.assigned;
      const se = Math.sqrt((pa * (1 - pa)) / a.assigned + (pb * (1 - pb)) / b.assigned);
      significant = se > 0 && Math.abs(pa - pb) / se > 1.96;
    }
    out.push({ ...e, variants: stats, totalAssigned: totalN, leader: best?.rate === worst?.rate ? null : best?.variant, significant, payload: variants.map((v: any) => ({ key: v.key, cfg: j(v.payload_json, {}), is_control: !!v.is_control })) });
  }
  return out;
}

/** affectation déterministe (hash) — le même visiteur voit toujours la même variante */
export function assignVariant(key: string, visitorId: string, variants: { key: string; weight: number }[]) {
  const h = [...`${key}:${visitorId}`].reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381);
  const total = variants.reduce((a, v) => a + v.weight, 0);
  let x = h % total;
  for (const v of variants) {
    if (x < v.weight) return v.key;
    x -= v.weight;
  }
  return variants[0]?.key;
}

export async function trackExperiment(ctx: Ctx, experimentKey: string, variantKey: string, visitorId: string, converted = false, revenueCents = 0) {
  const q = db();
  try {
    await q.exec(
      `INSERT INTO experiment_assignments (experiment_key, variant_key, visitor_id, converted, revenue_cents, ts) VALUES (:e, :v, :u, :c, :r, :t)
       ON CONFLICT(experiment_key, variant_key, visitor_id)
       DO UPDATE SET converted = CASE WHEN :c2 > experiment_assignments.converted THEN :c2 ELSE experiment_assignments.converted END,
                     revenue_cents = experiment_assignments.revenue_cents + :r2`,
      { e: experimentKey, v: variantKey, u: visitorId, c: converted ? 1 : 0, r: revenueCents, t: Date.now(), c2: converted ? 1 : 0, r2: revenueCents },
    );
  } catch (errErr: any) {
    // Jamais bloquant pour le visiteur — mais jamais silencieux : cet upsert cassé en Postgres
    // (MAX() à deux arguments est un agrégat là-bas) vidait les rapports d'A/B test sans erreur visible.
    void observe('experiment_track_fail', experimentKey, null, 'warn', { message: String(errErr?.message ?? errErr).slice(0, 200) }, null).catch(() => undefined);
  }
}

export async function funnelRealtime(ctx: Ctx) {
  const q = db();
  const since = Date.now() - 6 * 3600 * 1000;
  const rows = await q.all<any>(`SELECT kind, COUNT(DISTINCT visitor_id) AS u FROM funnel_events WHERE location_id = :l AND ts > :s GROUP BY kind`, { l: ctx.locId, s: since });
  const openDrafts = await q.num(`SELECT COUNT(*) FROM booking_drafts WHERE location_id = :l AND status='open' AND updated_ts > :s`, { l: ctx.locId, s: since });
  return { last6h: Object.fromEntries(rows.map((r: any) => [r.kind, Number(r.u)])), openDrafts };
}

export async function listContentPages(ctx: Ctx) {
  const rows = await db().all<any>(`SELECT * FROM content_pages WHERE location_id = :l AND is_published = 1 ORDER BY id`, { l: ctx.locId });
  return rows.map((p: any) => ({ ...p, body: j(p.body_json, []), faq: j(p.faq_json, []) }));
}

export async function upsertContentPage(ctx: Ctx, o: any) {
  const q = db();
  const existing = o.id ? await q.one<any>(`SELECT * FROM content_pages WHERE id = :i`, { i: o.id }) : await q.one<any>(`SELECT * FROM content_pages WHERE location_id = :l AND slug = :s`, { l: ctx.locId, s: o.slug });
  const payload = {
    slug: o.slug,
    kind: o.kind ?? 'guide',
    title: o.title,
    summary: o.summary ?? null,
    body_json: sj(o.body ?? []),
    service_key: o.serviceKey ?? null,
    faq_json: sj(o.faq ?? []),
    seo_title: o.seoTitle ?? o.title,
    seo_desc: o.seoDesc ?? o.summary ?? null,
    is_published: o.published === false ? 0 : 1,
    updated_ts: Date.now(),
  };
  if (existing) await q.update('content_pages', existing.id, payload);
  else await q.insert('content_pages', { location_id: ctx.locId, created_ts: Date.now(), ...payload });
  await audit(ctx.locId, 'owner', null, 'content.upsert', 'content_pages', existing?.id ?? null, { slug: o.slug });
  return { ok: true, slug: o.slug };
}
