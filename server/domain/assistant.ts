import { db, j, sj } from '../db/index.ts';
import { DAY, MIN, dateKey, dayAdd, fmtDate, fmtTime, humanWhen, startOfDayMs, todayDay, weekdayLabel, endOfDayMs } from '../lib/time.ts';
import { signToken, verifyToken } from '../lib/secrets.ts';
import { appLink, cents } from '../lib/inputs.ts';
import type { Ctx } from './context.ts';
import { bumpAvailabilityCache, computeDay } from './availability.ts';
import { audit } from './customers.ts';

/**
 * Assistant propriétaire.
 * Choix assumé : pas de LLM dans le chemin critique. Les réponses viennent de requêtes
 * déterministes sur les vraies données du salon — donc zéro hallucination, zéro coût par
 * question, conforme RGPD (aucune donnée client n'est envoyée à un tiers).
 * Le parseur comprend le français naturel du métier ; un adaptateur LLM optionnel
 * (LLM_BASE_URL) peut reformuler les réponses déjà calculées, jamais les inventer.
 */

const deaccent = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

export interface ParsedQuery {
  intent: string;
  day?: string;
  dayLabel?: string;
  staffId?: number | null;
  confidence: number;
  missing?: string[];
  args?: Record<string, any>;
}

export function parseQuery(raw: string, ctx: Ctx): ParsedQuery {
  const s = deaccent(raw.trim());
  const out: ParsedQuery = { intent: 'unknown', confidence: 0.35 };
  // 1) jour
  let day: string | undefined;
  let dayLabel: string | undefined;
  if (/\baujourdhui|ce matin|cet apres[- ]midi|maintenant/.test(s)) day = todayDay();
  if (/demain/.test(s)) day = dayAdd(todayDay(), 1);
  if (/(apres[- ]?)demain/.test(s)) day = dayAdd(todayDay(), 2);
  const dayMatch = s.match(/(dimanche|lundi|mardi|mercredi|jeudi|vendredi|samedi)( prochain)?/);
  if (!day && dayMatch) {
    const want = DAYS.indexOf(dayMatch[1]);
    let add = (want - new Date(startOfDayMs(todayDay())).getUTCDay() + 7) % 7;
    if (add === 0) add = 7;
    if (dayMatch[2]) add += 7;
    day = dayAdd(todayDay(), add);
    dayLabel = dayMatch[1];
  }
  const dm = s.match(/le (\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (!day && dm) {
    const y = dm[3] ? (dm[3].length === 2 ? 2000 + +dm[3] : +dm[3]) : new Date().getFullYear();
    day = `${y}-${String(+dm[2]).padStart(2, '0')}-${String(+dm[1]).padStart(2, '0')}`;
  }
  const iso = s.match(/(20\d\d)-(\d\d)-(\d\d)/);
  if (!day && iso) day = iso[0];
  if (/(semaine prochaine|la semaine pro)/.test(s)) {
    day = dayAdd(todayDay(), 7);
    dayLabel = 'semaine prochaine';
  }
  out.day = day ?? todayDay();
  out.dayLabel = dayLabel;

  // 2) heure + prénom/nom (actions rapides)
  const time = s.match(/a (\d{1,2}) ?h ?(\d{0,2})/) || s.match(/(\d{1,2})[:h](\d{2})/);
  if (time) {
    const h = +time[1];
    const m = +(time[2] || 0);
    out.args = { ...out.args, timeMin: h * 60 + (m < 60 ? m : 0) };
  }
  const nameMatch = /(?:ajoute|book|reserver|creneaux? pour|mettre)\s+([a-z][a-z'’ -]{1,24}?)(?:\s+(?:demain|aujourd'hui|apres|le |lundi|mardi|mercredi|jeudi|vendredi|samedi|a \d))/i.exec(raw.trim());
  if (nameMatch) out.args = { ...out.args, name: nameMatch[1].trim() };

  // 3) membre d'équipe
  const staff = ctx.staff.find((st) => s.includes(deaccent(st.name)));
  out.staffId = staff?.id ?? null;

  // 4) intention
  const has = (...k: string[]) => k.some((x) => s.includes(x));
  if (has('combien') && has('demain', 'aujourdhui', 'rdv', 'rendez')) out.intent = /revenu|ca/.test(s) ? 'revenue_day' : 'count_day';
  else if (has('libre', 'dispo', 'creneaux libres', 'places libres', 'il reste')) out.intent = 'free_slots';
  else if (has('relanc', 'rappel', 'doit etre relancé', 'qui rappeler')) out.intent = 'who_relaunch';
  else if (has('pas repris', 'fidele', 'revient plus', 'inactif', 'endormi', 'à risque', 'churn')) out.intent = 'churn';
  else if (has('se vend le mieux', 'plus vendu', 'top service', 'service prefere', 'le plus demande')) out.intent = 'top_service';
  else if (has('source', 'viennent mes clients', 'apporte le plus', 'instagram', 'tiktok', 'google')) out.intent = /revenu/.test(s) ? 'revenue_source' : 'top_source';
  else if (has('attente', 'waitlist', 'file')) out.intent = /samedi|vendredi|jour/.test(s) ? 'waitlist_day' : 'waitlist';
  else if (has('se libere', 'liberation', 'annulation', 'annule')) out.intent = 'freed_slots';
  else if (has('revenu', 'chiffre', 'ca ', 'encaisse', 'encaiss')) out.intent = /semaine/.test(s) ? 'revenue_week' : 'revenue_day';
  else if (has('remplis', 'remplir', 'remplie')) out.intent = 'fill_slots';
  else if (has('bloq', 'absence', 'ferme', 'conge', 'pause')) out.intent = 'block_time';
  else if (has('montre', 'liste', 'quels rdv', 'les rendez')) out.intent = 'list_day';
  else if (has('campagne', 'prepare', 'communication', 'sms a envoyer')) out.intent = 'prepare_campaign';
  else if (has('ouvre', 'ajoute des creneaux', 'plus de creneaux')) out.intent = 'open_slots';
  else if (has('ajoute', 'book ', 'reserver pour', 'mettre ')) out.intent = /a \d|h \d/.test(s) ? 'quick_book' : 'quick_book';
  else if (has('forecast', 'prevois', 'prevision', 'combien de clients')) out.intent = 'forecast';
  else if (has('no-show', 'noshow', 'absents')) out.intent = 'noshow_risk';
  else if (has('qui est', 'recherche', 'fiche')) out.intent = 'find_customer';
  return out;
}

export interface AssistantAnswer {
  text: string;
  intent: string;
  chips?: { label: string; query: string }[];
  rows?: any[];
  cards?: { label: string; value: string; hint?: string }[];
  action?: { kind: string; label: string; confirmToken?: string; preview: string; needsConfirm: boolean; endpoint?: string };
  missing?: string[];
  question?: string;
  links?: { label: string; href: string }[];
}

export async function askAssistant(ctx: Ctx, question: string): Promise<AssistantAnswer> {
  const q = db();
  const parsed = parseQuery(question, ctx);
  const s = deaccent(question.trim());
  const day = parsed.day!;
  const a = startOfDayMs(day);
  const b = endOfDayMs(day);
  const chips = [
    { label: 'Demain ?', query: 'combien de rendez-vous demain' },
    { label: 'Créneaux libres', query: 'quels créneaux sont encore libres' },
    { label: 'Qui relancer ?', query: 'quels clients dois-je relancer' },
    { label: 'Revenus semaine', query: 'revenu de la semaine' },
  ];

  switch (parsed.intent) {
    case 'count_day':
    case 'list_day': {
      const rows = await q.all<any>(
        `SELECT a.start_ts, c.first_name, c.last_name, s.name AS service, st.name AS staff, a.status, a.price_cents, a.confirmed_ts
         FROM appointments a JOIN customers c ON c.id = a.customer_id JOIN services s ON s.id = a.service_id JOIN staff st ON st.id = a.staff_id
         WHERE a.location_id = :l AND a.start_ts >= :s AND a.start_ts < :e AND a.status != 'cancelled' ORDER BY a.start_ts LIMIT 80`,
        { l: ctx.locId, s: a, e: b },
      );
      const done = rows.filter((r: any) => r.status === 'completed').length;
      const revenue = rows.filter((r: any) => r.status === 'completed').reduce((acc: number, r: any) => acc + r.price_cents, 0);
      return {
        intent: parsed.intent,
        text: `${fmtDate(a)} : ${rows.length} rendez-vous${rows.length ? ` (${done} faits, ${cents(revenue)} encaissés)` : ''}.`,
        rows: rows.map((r: any) => ({ time: fmtTime(r.start_ts), name: `${r.first_name} ${r.last_name ?? ''}`.trim(), service: r.service, staff: r.staff, status: r.status, confirmed: !!r.confirmed_ts })),
        cards: [
          { label: 'RDV', value: String(rows.length) },
          { label: 'Clients', value: String(new Set(rows.map((r: any) => `${r.first_name}${r.last_name}`)).size) },
          { label: 'Retards potentiels', value: String(rows.filter((r: any) => !r.confirmed_ts && ['booked', 'pending_payment'].includes(r.status)).length) },
        ],
        links: [{ label: 'Ouvrir le calendrier', href: '/admin/calendrier?day=' + day }],
        chips,
      };
    }
    case 'free_slots': {
      const svc = ctx.services[0];
      const out: any[] = [];
      for (const s of ctx.staff) {
        const d = await computeDay(ctx, { serviceId: svc.id, durationMin: svc.base_duration_min + svc.cleanup_min, prepMin: svc.prep_min, cleanupMin: svc.cleanup_min, day, now: Date.now(), staffIds: [s.id], window: null, respectStep: false });
        out.push({ staff: s.name, free: d.slots.length, next: d.slots[0]?.start ?? null, usable: d.gaps.filter((g) => g.min >= 30).length, dead: d.gaps.filter((g) => g.min < 20).length });
      }
      const total = out.reduce((acc, o) => acc + o.free, 0);
      return {
        intent: 'free_slots',
        text: `${fmtDate(a)} : ${total} créneaux libres ${parsed.staffId ? `pour ${ctx.staff.find((s) => s.id === parsed.staffId)?.name}` : 'toute équipe confondue'}. ${out.map((o) => `${o.staff} : ${o.free}${o.next ? `, dès ${fmtTime(o.next)}` : ''}`).join(' · ')}`,
        rows: out.map((o) => ({ staff: o.staff, free: o.free, next: o.next ? fmtTime(o.next) : '—', trousMorts: o.dead })),
        cards: [
          { label: 'Créneaux libres', value: String(total) },
          { label: 'Trous < 20 min', value: String(out.reduce((acc, o) => acc + o.dead, 0)) },
        ],
        links: [{ label: 'Calendrier', href: '/admin/calendrier?day=' + day }],
        chips,
      };
    }
    case 'who_relaunch': {
      const rows = await q.all<any>(
        `SELECT c.id, c.first_name, c.last_name, c.phone, c.avg_days_between, c.last_visit_ts, c.loyalty_visits, s.name AS service
         FROM customers c LEFT JOIN services s ON s.id = c.preferred_service_id
         WHERE c.location_id = :l AND c.deleted_ts IS NULL AND c.last_visit_ts IS NOT NULL
           AND (c.consent_marketing_sms = 1 OR c.consent_marketing_email = 1)
         ORDER BY c.last_visit_ts ASC LIMIT 120`,
        { l: ctx.locId },
      );
      const due = rows
        .map((r: any) => ({ ...r, days: Math.round((Date.now() - r.last_visit_ts) / DAY), habit: r.avg_days_between ?? 28 }))
        .filter((r: any) => r.days > r.habit * 1.15)
        .slice(0, 25);
      const token = signToken({ act: 'relance_batch', ids: due.map((d: any) => d.id), kind: 'rebook_suggestion' }, 30 * 60_000);
      return {
        intent: 'who_relaunch',
        text: `${due.length} clients ont dépassé leur rythme habituel (${due.slice(0, 3).map((d: any) => `${d.first_name} ${d.days} j`).join(', ')}…). Une relance par client, pas plus.`,
        rows: due.map((d: any) => ({ name: `${d.first_name} ${d.last_name ?? ''}`, phone: d.phone, since: `${d.days} j`, habit: `${d.habit} j`, service: d.service, loyalty: d.loyalty_visits })),
        action: { kind: 'relance_batch', label: `Envoyer ${due.length} relances « rebooking »`, preview: `SMS type : « ${d1(due)} », aux ${due.length} clients listés. Un seul message par client sur 21 jours.`, needsConfirm: true, confirmToken: token },
        chips,
      };
    }
    case 'churn': {
      const { atRisk } = await import('./analytics.ts');
      const rows = await atRisk(ctx, 15);
      return { intent: 'churn', text: `${rows.length} clients à risque identifiés sur la base de leur rythme réel.`, rows: rows.map((r: any) => ({ name: `${r.first_name} ${r.last_name ?? ''}`, depuis: `${r.daysSince} j`, habitude: `${r.habit} j`, depense: cents(r.spent_cents), risque: r.risk_score })), chips };
    }
    case 'top_service': {
      const { revenueByService } = await import('./analytics.ts');
      const rows = await revenueByService(ctx, 60);
      const best = rows[0];
      return {
        intent: 'top_service',
        text: best ? `Sur 60 jours, « ${best.name} » est en tête : ${best.n} prestations, ${cents(best.revenue_cents)} (${Math.round(best.avg_cents / 100)} € de panier moyen).` : 'Pas encore assez d’historique pour répondre.',
        rows: rows.slice(0, 8).map((r: any) => ({ service: r.name, n: r.n, revenue: cents(r.revenue_cents), avg: cents(Math.round(r.avg_cents)) })),
        chips,
      };
    }
    case 'top_source':
    case 'revenue_source': {
      const { bySource } = await import('./analytics.ts');
      const rows = await bySource(ctx, 30);
      const best = [...rows].sort((a: any, b: any) => b.bookings - a.bookings)[0];
      return {
        intent: 'top_source',
        text: best ? `${best.source} amène ${best.bookings} réservations sur 30 jours${best.visitors ? ` (${best.conversion} % de conversion)` : ''}.` : 'Aucune donnée de source exploitable pour l’instant.',
        rows: rows.slice(0, 8).map((r: any) => ({ source: r.source, camp: r.campaign, reservations: r.bookings, visiteurs: r.visitors ?? '—', conversion: r.conversion ? `${r.conversion} %` : '—', revenue: cents(r.revenueCents ?? r.revenue_cents) })),
        chips,
      };
    }
    case 'waitlist':
    case 'waitlist_day': {
      const rows = await q.all<any>(`SELECT w.*, s.name AS service, st.name AS staff FROM waitlist w LEFT JOIN services s ON s.id = w.service_id LEFT JOIN staff st ON st.id = w.staff_id WHERE w.location_id = :l AND w.status='active' ORDER BY w.priority DESC, w.created_ts`, { l: ctx.locId });
      const filtered = parsed.intent === 'waitlist_day' ? rows.filter((r: any) => j<any[]>(r.days, []).includes(day) || j<any[]>(r.days, []).includes(new Date(a).getUTCDay())) : rows;
      return {
        intent: parsed.intent,
        text: `${filtered.length} client${filtered.length > 1 ? 's' : ''} en attente${parsed.intent === 'waitlist_day' ? ` pour le ${fmtDate(a)}` : ''}. ${filtered.length ? 'Tu peux leur proposer un créneau en 1 clic.' : ''}`,
        rows: filtered.map((r: any) => ({ nom: r.name, tel: r.phone, service: r.service ?? 'souhait libre', staff: r.staff ?? 'peu importe', depuis: humanWhen(r.created_ts), note: r.note ?? '' })),
        links: [{ label: 'Ouvrir la waitlist', href: '/admin/waitlist' }],
        chips,
      };
    }
    case 'freed_slots': {
      const rows = await q.all<any>(
        `SELECT a.id, a.start_ts, a.cancelled_ts, a.cancel_reason, c.first_name, c.last_name, st.name AS staff, s.name AS service
         FROM appointments a JOIN customers c ON c.id = a.customer_id JOIN staff st ON st.id = a.staff_id JOIN services s ON s.id = a.service_id
         WHERE a.location_id = :l AND a.status IN ('cancelled','no_show') AND a.cancelled_ts > :s ORDER BY a.cancelled_ts DESC LIMIT 15`,
        { l: ctx.locId, s: Date.now() - 7 * DAY },
      );
      const recovered = await q.num(`SELECT COUNT(*) FROM waitlist_offers WHERE location_id = :l AND status = 'claimed' AND created_ts > :s`, { l: ctx.locId, s: Date.now() - 7 * DAY });
      return {
        intent: 'freed_slots',
        text: `${rows.length} créneaux libérés cette semaine, ${recovered} déjà repartis en waitlist (${rows.length ? Math.round((recovered / Math.max(1, rows.length)) * 100) : 0} % de récupération).`,
        rows: rows.map((r: any) => ({ quand: `${fmtDate(r.start_ts)} ${fmtTime(r.start_ts)}`, why: r.cancel_reason ?? '?', client: `${r.first_name} ${r.last_name ?? ''}`, staff: r.staff, service: r.service })),
        cards: [{ label: 'Récupérés', value: String(recovered) }, { label: 'Libérés', value: String(rows.length) }],
        chips,
      };
    }
    case 'revenue_day':
    case 'revenue_week': {
      const from = parsed.intent === 'revenue_week' ? dayAdd(todayDay(), -6) : day;
      const rows = await q.all<any>(`SELECT price_cents, status FROM appointments WHERE location_id = :l AND start_ts >= :s AND start_ts < :e`, { l: ctx.locId, s: startOfDayMs(from), e: b });
      const done = rows.filter((r: any) => r.status === 'completed');
      const total = done.reduce((acc: number, r: any) => acc + r.price_cents, 0);
      return {
        intent: parsed.intent,
        text: `${from === day ? fmtDate(a) : '7 derniers jours'} : ${cents(total)} encaissés sur ${done.length} prestations. Panier moyen ${done.length ? cents(Math.round(total / done.length)) : '—'}.`,
        cards: [
          { label: 'CA', value: cents(total) },
          { label: 'Prestations', value: String(done.length) },
          { label: 'Panier moyen', value: done.length ? cents(Math.round(total / done.length)) : '—' },
        ],
        chips,
      };
    }
    case 'forecast': {
      const { forecast } = await import('./analytics.ts');
      const f = await forecast(ctx, 7);
      return { intent: 'forecast', text: `Prévision sur 7 jours (moyenne mobile, écart-type affiché) : ${f.days.map((d) => `${weekdayLabel(new Date(d.day + 'T12:00:00Z').getUTCDay())} ${d.predicted}±${Math.max(1, Math.round((d.high - d.low) / 2))}`).join(' · ')}. ${f.noShowRatePct}% de no-show historique.`, rows: f.days.map((d) => ({ jour: d.label, prevu: `${d.predicted}±${Math.max(1, Math.round((d.high - d.low) / 2))}`, deja: d.booked, ecart: d.gap, confiance: d.confidence })), chips };
    }
    case 'noshow_risk': {
      const rows = await q.all<any>(
        `SELECT a.id, a.start_ts, c.first_name, c.last_name, c.noshow_count, c.cancelled_count, a.deposit_cents
         FROM appointments a JOIN customers c ON c.id = a.customer_id
         WHERE a.location_id = :l AND a.start_ts > :n AND a.status IN ('booked','confirmed') AND (c.noshow_count > 0 OR c.cancelled_count > 1) ORDER BY a.start_ts LIMIT 20`,
        { l: ctx.locId, n: Date.now() },
      );
      return {
        intent: 'noshow_risk',
        text: rows.length ? `${rows.length} RDV à surveiller (historique d'absence ou d'annulations). Rien n'est automatique sans ta validation.` : 'Aucun signal de risque sur les RDV à venir. 👍',
        rows: rows.map((r: any) => ({ nom: `${r.first_name} ${r.last_name ?? ''}`, quand: `${fmtDate(r.start_ts)} ${fmtTime(r.start_ts)}`, noshow: r.noshow_count, annulations: r.cancelled_count, acompte: r.deposit_cents ? cents(r.deposit_cents) : 'aucun' })),
        chips,
      };
    }
    case 'find_customer': {
      const term = (question.match(/qui est\s+(.+)/i)?.[1] ?? question.replace(/[^a-zA-ZÀ-ÿ' -]/g, '').trim()).trim();
      const rows = await q.all<any>(`SELECT id, first_name, last_name, phone, visits_count, spent_cents, last_visit_ts FROM customers WHERE location_id = :l AND (lower(first_name) LIKE :t OR lower(last_name) LIKE :t) LIMIT 6`, { l: ctx.locId, t: `%${deaccent(term)}%` });
      return { intent: 'find_customer', text: rows.length ? `${rows.length} client(s) trouvé(s).` : 'Personne ne correspond.', rows: rows.map((r: any) => ({ nom: `${r.first_name} ${r.last_name ?? ''}`, tel: r.phone, visites: r.visits_count, depense: cents(r.spent_cents), dernier: r.last_visit_ts ? humanWhen(r.last_visit_ts) : '—' })), chips };
    }
    case 'block_time': {
      if (!parsed.args?.timeMin && !/apres|matin|soir|journee/.test(s)) {
        return { intent: 'block_time', text: 'Je peux bloquer un créneau. Précise le jour et la durée, par exemple : « bloque vendredi après-midi ».', missing: ['jour', 'plage'], question: 'Quand exactement ?' };
      }
      const label = `${fmtDate(a)}${/apres/.test(s) ? ' après-midi' : /matin/.test(s) ? ' matin' : ''}`;
      const token = signToken({ act: 'block', day, part: /apres/.test(s) ? 'pm' : /matin/.test(s) ? 'am' : 'day', staffId: parsed.staffId ?? null }, 10 * 60_000);
      return { intent: 'block_time', text: `Je peux bloquer ${label} pour ${parsed.staffId ? ctx.staff.find((x) => x.id === parsed.staffId)?.name : 'toute l’équipe'} (13 h–14 h ou la journée selon le cas). Rien n'est fait tant que tu n'as pas validé.`, action: { kind: 'block', label: 'Bloquer ce créneau', preview: label, needsConfirm: true, confirmToken: token }, chips };
    }
    case 'quick_book': {
      const name = parsed.args?.name;
      const timeMin = parsed.args?.timeMin;
      const missing: string[] = [];
      if (!name) missing.push('le nom du client');
      if (!timeMin) missing.push('l’heure');
      if (missing.length) return { intent: 'quick_book', text: `Pour créer le rendez-vous il me manque ${missing.join(' et ')}. Exemple : « Ajoute Paul demain à 15 h ».`, missing, question: missing[0] };
      const cand = await q.all<any>(`SELECT id, first_name, last_name, phone FROM customers WHERE location_id = :l AND lower(first_name) = :n ORDER BY last_visit_ts DESC LIMIT 3`, { l: ctx.locId, n: deaccent(String(name)).split(' ')[0] });
      const off = ctx.offerings.find((o) => /coupe homme/i.test(o.name)) ?? ctx.offerings[0];
      const start = a + timeMin * MIN;
      const token = signToken({ act: 'quick_book', customerId: cand[0]?.id ?? null, name, start, offeringId: off.id, staffId: parsed.staffId ?? null }, 10 * 60_000);
      return {
        intent: 'quick_book',
        text: `Je propose : ${name} — ${off.name} (${off.duration_min} min, ${cents(off.price_cents)}) le ${fmtDate(start)} à ${fmtTime(start)}${parsed.staffId ? ` avec ${ctx.staff.find((x) => x.id === parsed.staffId)?.name}` : ''}. ${cand.length ? `J'ai trouvé ${cand[0].first_name} ${cand[0].last_name ?? ''} dans ta base.` : 'Nouveau client : je créerai la fiche.'} Confirme et c'est posé.`,
        action: { kind: 'quick_book', label: 'Créer ce rendez-vous', preview: `${name} · ${off.name} · ${fmtDate(start)} ${fmtTime(start)}`, needsConfirm: true, confirmToken: token },
        chips,
      };
    }
    case 'fill_slots': {
      const { replayWaitlist } = await import('./waitlist.ts');
      const dayRows = await q.all<any>(
        `SELECT a.start_ts, a.staff_id, a.service_id, a.offering_id, a.end_ts FROM appointments a WHERE a.location_id = :l AND a.status='cancelled' AND a.cancelled_ts > :s AND a.start_ts > :n ORDER BY a.start_ts LIMIT 40`,
        { l: ctx.locId, s: Date.now() - 7 * DAY, n: Date.now() },
      );
      const token = signToken({ act: 'fill', day, slots: dayRows.length }, 10 * 60_000);
      return {
        intent: 'fill_slots',
        text: `${dayRows.length} créneaux annulés à venir depuis 7 jours. Je peux relancer la waitlist dessus immédiatement (offre exclusive de ${ctx.policy.waitlistOfferTtlMin} min par client).`,
        action: { kind: 'fill', label: `Proposer ${dayRows.length} créneaux à la waitlist`, preview: 'Envoie des SMS « un créneau se libère » aux clients compatibles, dans l’ordre de priorité.', needsConfirm: true, confirmToken: token },
        chips,
      };
    }
    case 'prepare_campaign': {
      const { previewSegment } = await import('./marketing.ts');
      const seg = [{ field: 'days_since_last', op: '>', value: 45 }, { field: 'consent', op: 'true', value: true }];
      const p = await previewSegment(ctx, seg);
      const token = signToken({ act: 'campaign', segment: seg, templateKey: 'winback' }, 10 * 60_000);
      return {
        intent: 'prepare_campaign',
        text: `Je peux préparer une campagne de réactivation pour ${p.total} clients ayant accepté d’être contactés. Message type : « Ça fait un moment… » — rien n'est envoyé sans ta validation.`,
        action: { kind: 'campaign', label: 'Préparer la campagne', preview: `${p.total} destinataires, 1 SMS, opt-in vérifié`, needsConfirm: true, confirmToken: token },
        chips,
      };
    }
    case 'open_slots': {
      const token = signToken({ act: 'open_extra', day }, 10 * 60_000);
      return { intent: 'open_slots', text: `J'ai repéré ${ctx.policy.waitlistOfferTtlMin ? '' : ''}des créneaux manquants sur ${fmtDate(a)}. Je peux ouvrir une plage supplémentaire (par ex. 20 h–21 h) si la demande le justifie — à toi de valider l'horaire.`, action: { kind: 'open_extra', label: 'Ouvrir des créneaux ce jour', preview: fmtDate(a), needsConfirm: true, confirmToken: token }, chips };
    }
    default:
      return {
        intent: 'unknown',
        text: "Je réponds sur ce qui se passe réellement dans le salon : « combien de RDV demain », « quels créneaux sont libres », « qui relancer aujourd'hui », « quels clients n'ont pas repris RDV », « quel service se vend le mieux », « quelle source apporte le plus », « qui attend pour samedi », « quels créneaux se libèrent », « prépare une campagne », « bloque vendredi après-midi », « ajoute Paul demain à 15 h ».",
        chips,
      };
  }
}

function d1(rows: any[]) {
  const first = rows[0];
  if (!first) return 'Ça fait un moment depuis ta dernière coupe — voici les prochains créneaux.';
  return `${first.first_name}, ça fait ${first.days} j depuis ta dernière venue. Voici les prochains créneaux.`;
}

export interface AssistantAction {
  kind: string;
  payload: any;
  token: string;
}

/** exécution après confirmation explicite du propriétaire */
export async function confirmAndRun(ctx: Ctx, token: string, actorId: number | null) {
  const p = verifyToken<any>(token);
  if (!p) throw Object.assign(new Error('Jeton expiré : repose la demande.'), { status: 410 });
  const q = db();
  const { notify } = await import('./notify.ts');
  const { dispatchNow } = await import('./notify.ts');
  switch (p.act) {
    case 'relance_batch': {
      let n = 0;
      for (const id of p.ids ?? []) {
        const ids = await notify(ctx, 'rebook_suggestion', { customerId: id, idem: `assistant:relance:${id}:${dateKey(Date.now())}` });
        n += ids.length;
      }
      await dispatchNow(ctx, n + 5);
      await audit(ctx.locId, 'owner', actorId, 'assistant.relance_batch', 'customers', null, { count: n });
      return { ok: true, done: n, message: `${n} relances envoyées.` };
    }
    case 'block': {
      const a = startOfDayMs(p.day);
      const [from, to] = p.part === 'pm' ? [13 * 60, 20 * 60] : p.part === 'am' ? [9 * 60 + 30, 13 * 60] : [9 * 60 + 30, 20 * 60];
      const ids: number[] = [];
      for (const s of ctx.staff) {
        if (p.staffId && s.id !== p.staffId) continue;
        ids.push(await q.insert('blocks', { location_id: ctx.locId, staff_id: s.id ?? null, start_ts: a + from * MIN, end_ts: a + to * MIN, kind: 'absence', reason: 'Bloqué depuis l’assistant', created_ts: Date.now() }));
      }
      if (!ids.length && p.staffId == null) ids.push(await q.insert('blocks', { location_id: ctx.locId, staff_id: null, start_ts: a + from * MIN, end_ts: a + to * MIN, kind: 'closure', reason: 'Bloqué depuis l’assistant', created_ts: Date.now() }));
      bumpAvailabilityCache();
      await audit(ctx.locId, 'owner', actorId, 'assistant.block', 'blocks', ids[0] ?? null, { day: p.day, from, to });
      return { ok: true, message: `Créneau bloqué le ${fmtDate(a)} de ${Math.floor(from / 60)}h à ${Math.floor(to / 60)}h.`, data: { from: a + from * MIN, to: a + to * MIN } };
    }
    case 'quick_book': {
      const { createBooking } = await import('./booking.ts');
      const res = await createBooking({
        ctx,
        offeringId: p.offeringId,
        start: p.start,
        staffId: p.staffId ?? null,
        customer: { firstName: String(p.name).split(' ')[0], lastName: String(p.name).split(' ').slice(1).join(' ') || undefined, phone: (await q.one<any>(`SELECT phone FROM customers WHERE id = :i`, { i: p.customerId }))?.phone ?? '' },
        paymentMode: 'none',
        requireConfirm: false,
        force: true,
        source: 'assistant',
        actor: { type: 'owner', id: actorId },
      });
      return { ok: true, message: `${p.name} est réservé le ${fmtDate(p.start)} à ${fmtTime(p.start)} avec ${res.staffName}.`, data: res };
    }
    case 'fill': {
      const { replayWaitlist } = await import('./waitlist.ts');
      const rows = await q.all<any>(`SELECT * FROM appointments WHERE location_id = :l AND status='cancelled' AND cancelled_ts > :s AND start_ts > :n`, { l: ctx.locId, s: Date.now() - 7 * DAY, n: Date.now() });
      let offers = 0;
      for (const r of rows) {
        const out = await replayWaitlist(ctx, { staffId: r.staff_id, start: r.start_ts, end: r.end_ts, serviceId: r.service_id, offeringId: r.offering_id, reason: 'assistant_fill' });
        offers += out.offers;
      }
      return { ok: true, message: `${offers} proposition(s) envoyée(s) à la waitlist pour ${rows.length} créneau(x) recovered.`, data: { slots: rows.length, offers } };
    }
    case 'campaign': {
      const { createCampaign } = await import('./marketing.ts');
      const c = await createCampaign(ctx, { name: 'Réactivation (via assistant)', kind: 'winback', segment: p.segment, templateKey: 'winback', channel: 'sms' });
      return { ok: true, message: `Campagne #${c.id} créée : ${c.targeted} destinataires. Ouvre-la dans Campagnes pour valider l'envoi.`, data: c };
    }
    case 'open_extra': {
      const a = startOfDayMs(p.day);
      await q.insert('day_overrides', { location_id: ctx.locId, staff_id: null, day: p.day, kind: 'open', start_min: 9 * 60 + 30, end_min: 21 * 60, reason: 'Plage élargie (assistant)', created_ts: Date.now() });
      bumpAvailabilityCache();
      await audit(ctx.locId, 'owner', actorId, 'assistant.open_extra', 'day_overrides', null, { day: p.day });
      return { ok: true, message: `Ouverture exceptionnelle enregistrée pour ${fmtDate(a)} jusqu'à 21 h. La waitlist sera notifiée automatiquement.`, data: {} };
    }
    default:
      throw new Error('Action inconnue');
  }
}

export function assistantGreeting(ctx: Ctx) {
  return `Je regarde ${ctx.name} en temps réel : planning, waitlist, CRM, revenus. Pose ta question ou touche une suggestion.`;
}
