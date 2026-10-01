import { publicMapsUrl } from '../../shared/salon.ts';
import { buildEmail } from '../lib/email-template.ts';
import { db, j, sj } from '../db/index.ts';
import { DAY, MIN, fmtDate, fmtTime, humanWhen, startOfDayMs } from '../lib/time.ts';
void fmtDate; void fmtTime; void startOfDayMs;
import { appLink, cents, displayPhone } from '../lib/inputs.ts';
import { env } from '../lib/env.ts';
import { signToken } from '../lib/secrets.ts';
import type { Ctx } from './context.ts';
import { audit } from './customers.ts';
import { observe } from '../lib/observe.ts';

/**
 * Moteur de notifications.
 * - un seul chemin : `notify()` écrit dans l'outbox (idempotent), le dispatcher envoie.
 * - le canal dépend des consentements : transactionnel = toujours (c'est le service rendu),
 *   marketing = uniquement si opt-in explicite, jamais la nuit, max par semaine.
 * - provider réel branchable (Resend / Twilio / WhatsApp Cloud API) sans toucher au reste.
 */

export const TX_KINDS = new Set(['login_code', 'booking_confirmed', 'reminder_d3', 'reminder_d1', 'reminder_h3', 'confirm_needed', 'cancelled', 'rescheduled', 'waitlist_offer', 'waitlist_joined', 'waitlist_promised', 'deposit_paid', 'noshow_notice', 'gift_card_received', 'appointment_today']);
export const MARKETING_KINDS = new Set(['review_request', 'review_thanks', 'rebook_suggestion', 'winback', 'birthday', 'welcome', 'campaign', 'referral_success', 'draft_abandon', 'loyalty_reward']);

export interface NotifyOpts {
  appointmentId?: number | null;
  customerId?: number | null;
  vars?: Record<string, string | number | null | undefined>;
  channels?: ('sms' | 'email' | 'whatsapp' | 'web')[];
  sendAfter?: number;
  idem?: string;
  waitlistOfferId?: number | null;
  campaignId?: number | null;
  force?: boolean;
  emailTo?: string; // destinataire transactionnel explicite (carte cadeau au comptoir)
}

const FALLBACK_TEMPLATES: Record<string, { subject?: string; sms?: string; email?: string }> = {
  login_code: { subject: 'Ton code de connexion Z.YASS', sms: '{message}', email: '{message}' },
  booking_confirmed: {
    subject: 'Rendez-vous confirmé — {date}',
    sms: '{prenom}, c’est booké ✔ {service} — {jour} {date} à {heure} avec {staff}. Z.YASS, 20 bd Roy. Modifier : {link_manage}',
    email: 'Bonjour {prenom},\n\n{service} confirmé le {jour} {date} à {heure} avec {staff} (durée {duree}, {prix}).\nAdresse : {adresse} — {maps}\nModifier ou annuler en 1 clic : {link_manage}\n\nÀ vite, l’équipe Z.YASS',
  },
  reminder_d1: { sms: 'Demain {heure}, c’est toi ({service}). Confirmer : {link_confirm} — Décaler : {link_reschedule}', subject: 'Rappel : rendez-vous demain à {heure}' },
  reminder_d3: { sms: 'Rappel : {service} {jour} {date} à {heure}. OK ? {link_confirm} — Décaler : {link_reschedule}' },
  reminder_h3: { sms: 'On t’attend à {heure} ({service}). Un souci : {phone}' },
  confirm_needed: { sms: '{prenom}, confirme ton RDV {jour} {date} à {heure} (1 clic) : {link_confirm}. Reporter : {link_reschedule}' },
  cancelled: { sms: 'RDV du {date} {heure} annulé. {deposit_msg} Reprendre : {link_book}' },
  rescheduled: { sms: 'C’est noté : {service} décalé au {jour} {date} à {heure}. Détails : {link_manage}' },
  waitlist_joined: { subject: 'Ta demande est enregistrée — Z.YASS', email: 'Ta demande de liste d’attente est enregistrée. Ce n’est pas encore un rendez-vous. Une offre te sera proposée si un créneau compatible est disponible.\nSuivre ou retirer ta demande : {link_manage}' },
  waitlist_offer: { subject: 'Un créneau pour toi — {date} à {heure}', email: '{prenom}, un créneau est disponible : {service}, {date} à {heure}. Cette offre est valable {ttl} minutes.\nConsulter et confirmer : {link_claim}\nRefuser uniquement cette proposition : {link_decline}', sms: 'Un créneau se libère pour toi : {service} {jour} {date} à {heure}. Réserve en 1 clic (valide {ttl} min) : {link_claim}. Non merci : {link_decline}' },
  waitlist_promised: { sms: 'Dispo trouvée sur ton horizon ! Accès prioritaire : {link_book}' },
  review_request: { sms: '{prenom}, comment c’était ? 10 secondes ici : {link_review} — ça compte beaucoup pour nous.' },
  review_thanks: { sms: 'Merci ! 20 secondes de plus et ça aide plus qu’une pub : un avis Google → {link_google}' },
  rebook_suggestion: { sms: '{prenom}, ça fait {jours} depuis ta dernière {service}. Prochains créneaux : {link_book}' },
  winback: { sms: 'Ça fait un moment. Il reste des places cette semaine chez Z.YASS : {link_book} (STOP pour ne plus recevoir)' },
  birthday: { sms: 'Joyeux anniversaire {prenom} ! Un cadeau sur ta prochaine venue : {link_book}' },
  welcome: { subject: 'Bienvenue chez Z.YASS', email: 'Salut {prenom},\n\n1. Viens 5 minutes avant, on démarre à l’heure.\n2. Envoie la photo de ton inspiration, on tranche ensemble.\n3. Annuler/décaler = 1 clic : {link_manage}\n\nL’équipe' },
  deposit_paid: { sms: 'Acompte de {deposit} reçu ✔ RDV {date} {heure} bloqué. Solde sur place : {balance}.' },
  noshow_notice: { sms: 'On t’a attendu à {heure}. Reprendre un créneau : {link_book}' },
  referral_success: { sms: '{parrain}, ton filleul a réservé ! Ta récompense est débloquée : {link_book}' },
  draft_abandon: { subject: 'Tu n’as pas terminé ta réservation', email: 'Bonjour {prenom},\n\nTon créneau {slot} n’est pas réservé, personne ne l’a pris.\nReprendre : {link_resume}\n\nZ.YASS' },
  gift_card_received: { subject: 'Une carte cadeau Z.YASS pour toi', email: '{message}\n\nMontant : {montant}. Code : {code}\nÀ utiliser : {link_book}' },
  campaign: { sms: '{message} — Z.YASS. Réserver : {link_book} (STOP : se désinscrire)' },
};

async function render(ctx: Ctx, key: string, channel: string, vars: Record<string, string>) {
  const q = db();
  // WhatsApp = texte court, mêmes contraintes que le SMS : s'il n'a pas de gabarit propre,
  // il reprend celui du SMS. Sans ce repli, le message hériterait du corps d'e-mail
  // (trois paragraphes, signature) et dépasserait les limites de l'opérateur.
  const shortMsg = channel === 'sms' || channel === 'whatsapp';
  const row =
    (await q.one<any>(`SELECT * FROM templates WHERE location_id = :l AND key = :k AND channel = :c AND lang = 'fr'`, { l: ctx.locId, k: key, c: channel })) ??
    (channel === 'whatsapp' ? await q.one<any>(`SELECT * FROM templates WHERE location_id = :l AND key = :k AND channel = 'sms' AND lang = 'fr'`, { l: ctx.locId, k: key }) : null);
  const tpl = row?.body_text ?? (shortMsg ? FALLBACK_TEMPLATES[key]?.sms : FALLBACK_TEMPLATES[key]?.email) ?? `{prenom}, {service} — {jour} {date} à {heure}. {link_manage}`;
  const subject = row?.subject ?? FALLBACK_TEMPLATES[key]?.subject ?? `${ctx.name} — {service} {date} {heure}`;
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '') as string);
  return { body: fill(tpl), subject: fill(subject) };
}

export async function varsFor(ctx: Ctx, appointmentId: number | null | undefined, customerId: number | null | undefined, extra: Record<string, any> = {}) {
  const q = db();
  let c: any = null;
  let a: any = null;
  if (customerId) c = await q.one<any>(`SELECT * FROM customers WHERE id = :i`, { i: customerId });
  if (appointmentId) a = await q.one<any>(`SELECT a.*, s.name AS service_name, st.name AS staff_name FROM appointments a JOIN services s ON s.id = a.service_id JOIN staff st ON st.id = a.staff_id WHERE a.id = :i`, { i: appointmentId });
  const start = a?.start_ts ?? null;
  const token = a ? signToken({ a: a.id, c: a.customer_id, k: 'manage' }, 120 * DAY) : '';
  // Le lien de réclamation d'une offre waitlist vient de la ligne d'offre elle-même :
  // sans lui, le SMS « réserve en 1 clic » ne mène nulle part (bug qui rendait la
  // récupération de créneau inutilisable). On le résout ici pour que tous les appelants
  // soient corrects, pas seulement le chemin qui pensait à le passer.
  let wlToken: string | null = extra.waitlistToken ?? null;
  if (!wlToken && extra.waitlistOfferId) {
    const offer = await q.one<any>(`SELECT token FROM waitlist_offers WHERE id = :i`, { i: Number(extra.waitlistOfferId) });
    wlToken = offer?.token ? String(offer.token) : null;
  }
  const vars: Record<string, string> = {
    prenom: c?.first_name ?? 'Bonjour',
    nom: `${c?.first_name ?? ''} ${c?.last_name ?? ''}`.trim(),
    telephone: displayPhone(c?.phone),
    service: a?.service_name ?? '',
    staff: a?.staff_name ?? 'un barbier',
    date: start ? fmtDate(start, { short: true }) : '',
    jour: start ? fmtDate(start, { weekday: true }).split(' ')[0] : '',
    heure: start ? fmtTime(start) : '',
    duree: a ? `${a.duration_min} min` : '',
    prix: a ? cents(a.price_cents) : '',
    balance: a ? cents(Math.max(0, a.price_cents - a.paid_cents)) : '',
    deposit: a ? cents(a.deposit_cents) : '',
    adresse: `${ctx.address.street ?? ''}, ${ctx.address.postalCode ?? ''} ${ctx.address.city ?? ''}`.trim(),
    phone: ctx.phone ?? '',
    maps: publicMapsUrl(ctx.brand),
    salon: ctx.name,
    link_book: appLink('/book'),
    link_manage: a ? appLink(`/rdv/${a.id}?token=${token}`) : appLink('/espace'),
    // un lien « # » dans un message parti chez l'opérateur est une impasse : sans rendez-vous
    // identifié (relance manuelle, client sans RDV), on pointe sur l'espace client, pas sur le vide.
    link_confirm: a ? appLink(`/api/public/actions/confirm?token=${token}`) : appLink('/espace'),
    link_reschedule: a ? appLink(`/rdv/${a.id}/decaler?token=${token}`) : appLink('/espace'),
    link_cancel: a ? appLink(`/rdv/${a.id}/annuler?token=${token}`) : '#',
    link_review: a ? appLink(`/avis/${a.id}?token=${token}`) : appLink('/espace'),
    link_google: env.googleReviewUrl || ctx.brand.reviewUrl || appLink('/infos'),
    link_claim: wlToken ? appLink(`/waitlist/reserver?token=${wlToken}`) : appLink('/book'),
    link_decline: wlToken ? appLink(`/waitlist/refuser?token=${wlToken}`) : '#',
    link_resume: extra.draftToken ? appLink(`/book?draft=${extra.draftToken}`) : appLink('/book'),
    link_ical: a ? appLink(`/api/public/actions/ics?token=${token}`) : '#',
    ttl: String(ctx.policy.waitlistOfferTtlMin),
    slot: typeof extra.slot === 'number' ? humanWhen(extra.slot) : String(extra.slot ?? ''),
    jours: extra.jours != null ? String(extra.jours) : 'quelques semaines',
    parrain: extra.parrain ?? '',
    reward: extra.reward ?? '',
    message: extra.message ?? '',
    montant: extra.montant ?? '',
    code: extra.code ?? '',
    deposit_msg: extra.deposit_msg ?? '',
    destinateur: 'Z.YASS Barber Shop',
    ...Object.fromEntries(Object.entries(extra).filter(([, v]) => typeof v === 'string' || typeof v === 'number').map(([k, v]) => [k, String(v)])),
  };
  return vars;
}

function pickChannels(ctx: Ctx, customer: any, kind: string, forced?: string[]): ('sms' | 'email' | 'whatsapp' | 'web')[] {
  if (forced?.length) return forced as any;
  const isMarketing = MARKETING_KINDS.has(kind);
  const out: ('sms' | 'email' | 'whatsapp' | 'web')[] = [];
  const smsOk = isMarketing ? !!customer?.consent_marketing_sms : true;
  const mailOk = isMarketing ? !!customer?.consent_marketing_email : true;
  /* Rappels et confirmations suivent le canal que le salon a réellement branché : WhatsApp dès
     qu'un fournisseur WhatsApp est configuré (c'est ce que lisent les clients du quartier),
     SMS sinon. Une campagne marketing reste sur le canal choisi par le client. */
  if (customer?.phone && smsOk) out.push(isMarketing && String(customer.preferred_channel) === 'sms' ? 'sms' : textChannel());
  if (customer?.email && mailOk) out.push('email');
  if (!out.length) out.push('web');
  return [...new Set(out)];
}

function dateKeySafe(ts: number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: env.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}

/** déplace l'envoi hors des horaires de nuit (21h–8h30 par défaut) */
function respectQuietHours(ctx: Ctx, ts: number) {
  const mins = minutesOfDayLocal(ts);
  const from = toMin(ctx.quietFrom);
  const to = toMin(ctx.quietTo);
  const inQuiet = from > to ? mins >= from || mins < to : mins >= from && mins < to;
  if (!inQuiet) return ts;
  const base = startOfDayMs(dateKeySafe(ts));
  return mins >= from ? base + to * MIN + 5 * MIN : base + to * MIN + 5 * MIN;
}
function toMin(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}
function minutesOfDayLocal(ts: number) {
  return Math.floor((ts - startOfDayMs(dateKeySafe(ts))) / MIN);
}

/** contexte quiet-hours global (par salon, première automation configurée) */
const ctxQuiet = new WeakMap<Ctx, { quietFrom: string; quietTo: string }>();
async function ensureQuiet(ctx: Ctx) {
  if (ctxQuiet.has(ctx)) return;
  const row = await db().one<any>(`SELECT quiet_hours FROM automations WHERE location_id = :l ORDER BY id LIMIT 1`, { l: ctx.locId });
  const q = j(row?.quiet_hours, { from: '21:00', to: '08:30' });
  (ctx as any).quietFrom = q.from ?? '21:00';
  (ctx as any).quietTo = q.to ?? '08:30';
  ctxQuiet.set(ctx, { quietFrom: (ctx as any).quietFrom, quietTo: (ctx as any).quietTo });
}

/**
 * Prospection = consentement explicite, par canal. Un SMS « rappelle-nous vite » envoyé à un
 * client qui n'a rien autorisé n'est pas du service, c'est une faute (RGPD + LCEN) — et le
 * meilleur moyen de faire bloquer le numéro du salon. `web` reste autorisé : c'est l'espace
 * du client, pas une sollicitation.
 */
export function marketingConsentOk(customer: any, channel: string) {
  if (!customer) return false;
  if (channel === 'web' || channel === 'in-app') return true;
  if (channel === 'email') return Number(customer.consent_marketing_email ?? 0) === 1;
  return Number(customer.consent_marketing_sms ?? 0) === 1;
}

async function marketingThrottleOk(ctx: Ctx, customerId: number | null, kind: string) {
  if (!MARKETING_KINDS.has(kind) || !customerId) return true;
  const since = Date.now() - 7 * DAY;
  const q = db();
  const count = await q.num(
    `SELECT COUNT(*) FROM notifications WHERE customer_id = :c AND created_ts > :s AND status != 'cancelled'
     AND kind IN ('review_request','review_thanks','rebook_suggestion','winback','birthday','campaign','loyalty_reward','referral_success','draft_abandon')`,
    { c: customerId, s: since },
  );
  const perWeek = await q.num(`SELECT COALESCE(MAX(max_per_week), 4) FROM automations WHERE location_id = :l AND action_type = 'send_notification'`, { l: ctx.locId });
  return count < Math.max(1, perWeek || 4);
}

export async function notify(ctx: Ctx, kind: string, o: NotifyOpts = {}) {
  await ensureQuiet(ctx);
  const q = db();
  const customer = o.customerId ? await q.one<any>(`SELECT * FROM customers WHERE id = :i`, { i: o.customerId }) : null;
  if (!customer && o.customerId) return [];
  const channels = pickChannels(ctx, customer, kind, o.channels as any);
  const created: number[] = [];
  for (const ch of channels) {
    if (MARKETING_KINDS.has(kind) && !marketingConsentOk(customer, ch)) continue;
    if (MARKETING_KINDS.has(kind) && !(await marketingThrottleOk(ctx, o.customerId ?? null, kind))) continue;
    if (MARKETING_KINDS.has(kind) && o.sendAfter === undefined && customer?.segment === 'inactif' && kind === 'review_request') {
      // pas de relance avis sur un client inactif : on garde la place pour la relance de retour
    }
    const vars = await varsFor(ctx, o.appointmentId ?? null, o.customerId ?? null, { waitlistOfferId: o.waitlistOfferId ?? null, ...(o.vars ?? {}) });
    const { body, subject } = await render(ctx, kind, ch, vars);
    const recipient = ch === 'email' ? (o.emailTo || customer?.email) : ch === 'sms' || ch === 'whatsapp' ? customer?.phone : 'in-app';
    if (!recipient) continue;
    let sendTs = o.sendAfter ?? Date.now();
    if (kind !== 'login_code' && (ch === 'sms' || ch === 'whatsapp')) sendTs = respectQuietHours(ctx, sendTs);
    // une seule clé canonique par (rdv, kind, canal) : deux chemins qui veulent dire la
    // même chose ne peuvent plus créer deux messages. Les relances volontairement
    // répétées passent par `o.idem` (ex. `appt:<id>:last_call`).
    const idem = o.idem ?? (o.appointmentId ? `appt:${o.appointmentId}:${kind}:${ch}:${o.waitlistOfferId ?? ''}` : `${kind}:${o.customerId ?? 0}:${ch}:${Math.floor(Date.now() / DAY)}`);
      try {
      const id = await q.insert('notifications', {
        location_id: ctx.locId,
        customer_id: o.customerId ?? null,
        appointment_id: o.appointmentId ?? null,
        waitlist_offer_id: o.waitlistOfferId ?? null,
        template_key: kind,
        kind,
        channel: ch,
        recipient: recipient ?? 'web',
        subject: subject || null,
        body_text: body,
        status: 'queued',
        idempotency_key: idem,
        action_token: o.appointmentId ? signToken({ a: o.appointmentId, k: ch === 'email' ? 'open' : 'manage' }) : null,
        meta_json: sj({ vars }),
        send_ts: sendTs,
        created_ts: Date.now(),
        campaign_id: o.campaignId ?? null,
      });
      created.push(id);
    } catch (e: any) {
      if (!/UNIQUE/i.test(String(e?.message))) throw e; // doublon idempotent : on ignore
    }
  }
  return created;
}

/** planifie confirmation + rappels aux offsets configurés (J-7/J-3/J-1/H-3…) */
export async function scheduleAppointmentNotifications(ctx: Ctx, appt: any, opts: { customer?: any; isNew?: boolean } = {}) {
  const q = db();
  const customer = opts.customer ?? (await q.one<any>(`SELECT * FROM customers WHERE id = :i`, { i: appt.customer_id }));
  await notify(ctx, 'booking_confirmed', { appointmentId: appt.id, customerId: appt.customer_id });
  if (opts.isNew) await notify(ctx, 'welcome', { appointmentId: appt.id, customerId: appt.customer_id, sendAfter: appt.start_ts + 30 * MIN });
  if (appt.deposit_cents > 0) await notify(ctx, 'deposit_paid', { appointmentId: appt.id, customerId: appt.customer_id });
  const offsets: number[] = j(appt.reminder_offsets, ctx.policy.reminderOffsets);
  for (const off of offsets) {
    const at = appt.start_ts - off * MIN;
    if (at <= Date.now()) continue;
    const kind = off >= DAY * 3 ? 'reminder_d3' : off >= DAY ? 'reminder_d1' : off >= 60 ? 'reminder_h3' : 'reminder_h3';
    await notify(ctx, kind, { appointmentId: appt.id, customerId: appt.customer_id, sendAfter: at, idem: `appt:${appt.id}:${kind}` });
  }
  if (appt.confirm_required) {
    const deadline = appt.start_ts - (ctx.policy.confirmOffsets[0] ?? 1440) * MIN;
    await notify(ctx, 'confirm_needed', { appointmentId: appt.id, customerId: appt.customer_id, sendAfter: Math.max(Date.now() + 60_000, deadline) });
    await q.update('appointments', appt.id, { needs_action: 0 });
  }
  return true;
}

// ── fournisseurs ──────────────────────────────────────────────────────
export async function sendEmail(to: string, subject: string, body: string, design: { kind?: string; vars?: Record<string, any>; brandName?: string } = {}) {
  const html = buildEmail({ subject, body, appUrl: env.appUrl, ...design });
  if (env.emailProvider === 'brevo') {
    if (!env.brevoKey) throw new Error('BREVO_API_KEY manquante');
    const from = env.emailFrom.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/);
    const email = (from ? from[2] : env.emailFrom).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.endsWith('@example.com')) throw new Error('EMAIL_FROM doit être une adresse vérifiée dans Brevo');
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'api-key': env.brevoKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sender: { name: from?.[1] || env.emailFromName, email }, to: [{ email: to }], subject,
        htmlContent: html, textContent: body, ...(env.emailReplyTo ? { replyTo: { email: env.emailReplyTo } } : {}), tags: ['zyass', design.kind || 'transactionnel'] }),
    });
    if (!res.ok) throw new Error(`brevo HTTP ${res.status} — vérifier clé API, expéditeur et quota`);
    return { provider: 'brevo', id: ((await res.json()) as any).messageId ?? null };
  }
  if (env.emailProvider === 'resend') {
    if (!env.resendKey) throw new Error('RESEND_API_KEY manquante');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${env.resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.emailFrom, to: [to], subject, text: body, html }),
    });
    if (!res.ok) throw new Error(`resend HTTP ${res.status}`);
    return { provider: 'resend', id: ((await res.json()) as any).id ?? null };
  }
  if (env.emailProvider !== 'stdout') throw new Error('EMAIL_PROVIDER inconnu');
  return { provider: 'stdout', id: null };
}

/** Numéro au format E.164 sans séparateurs (WhatsApp n'accepte que des chiffres, sans `+`). */
export const waNumber = (v: string) => {
  const d = String(v || '').replace(/[^0-9]/g, '').replace(/^00/, '');
  // « 06 44 04 83 85 » est la façon dont un numéro français est noté partout dans le salon
  // (fiche, registre, borne). WhatsApp exige l'international : on convertit, sinon chaque
  // rappel échouerait silencieusement sur un format pourtant correct à l'œil.
  return /^0\d{9}$/.test(d) ? `33${d.slice(1)}` : d;
};

/** Un gabarit approuvé est obligatoire **hors** fenêtre de service de 24 h ; à l'intérieur,
 *  le message libre exige un message WhatsApp du client datant de moins de 24 h.
 *  Une réservation sur le site n'ouvre PAS cette fenêtre. `WHATSAPP_TEMPLATE_NAME` bascule sur le gabarit. */
async function sendWhatsAppMeta(to: string, body: string) {
  if (!env.waToken || !env.waPhoneId) throw new Error('WHATSAPP_ACCESS_TOKEN et WHATSAPP_PHONE_NUMBER_ID sont requis (WHATSAPP_PROVIDER=meta)');
  const numbers = waNumber(to);
  if (numbers.length < 11) throw new Error(`numéro WhatsApp invalide : « ${to} » (format international attendu, ex. +33612345678)`);
  const payload: any =
    env.waTemplate
      ? { messaging_product: 'whatsapp', to: numbers, type: 'template', template: { name: env.waTemplate, language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'fr' }, components: [{ type: 'body', parameters: [{ type: 'text', text: body.slice(0, 600) }] }] } }
      : { messaging_product: 'whatsapp', to: numbers, type: 'text', text: { preview_url: false, body: body.slice(0, 1024) } };
  const res = await fetch(`https://graph.facebook.com/${env.waVersion}/${env.waPhoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.waToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`whatsapp ${res.status}: ${json?.error?.message ?? JSON.stringify(json).slice(0, 180)}`);
  return { provider: 'whatsapp-meta', id: json?.messages?.[0]?.id ?? null };
}

/** Le fournisseur WhatsApp est-il réellement en état d'envoyer ? Déclarer `WHATSAPP_PROVIDER=meta`
 *  sans jeton ni numéro (l'erreur de branchement la plus fréquente) ne doit pas avoir pour effet
 *  collatéral de rendre tous les rappels impossibles : on reste sur le SMS tant que Meta n'est pas
 *  complet. `NOTIFY_TEXT_CHANNEL=whatsapp` force l'envoi — dans ce cas l'erreur est remontée à la
 *  ligne de notification, donc visible dans la file, plutôt que noyée dans un repli silencieux. */
export const waReady = (): boolean =>
  env.waProvider === 'meta'
    ? !!(env.waToken && env.waPhoneId)
    : env.waProvider === 'twilio'
      ? !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
      : false;

/** Canal texte par défaut : WhatsApp dès qu'un fournisseur utilisable est branché (c'est ce que
 *  lisent les clients d'un quartier), sinon SMS. `NOTIFY_TEXT_CHANNEL=sms` force le SMS. */
export const textChannel = (): 'sms' | 'whatsapp' =>
  process.env.NOTIFY_TEXT_CHANNEL === 'sms'
    ? 'sms'
    : process.env.NOTIFY_TEXT_CHANNEL === 'whatsapp'
      ? 'whatsapp'
      : waReady()
        ? 'whatsapp'
        : 'sms';

async function sendSms(to: string, body: string, channel: 'sms' | 'whatsapp' = textChannel()) {
  if (channel === 'whatsapp' && env.waProvider === 'meta') return sendWhatsAppMeta(to, body);
  if ((env.smsProvider === 'twilio' || (channel === 'whatsapp' && env.waProvider === 'twilio')) && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    const p = new URLSearchParams({ To: channel === 'whatsapp' ? `whatsapp:${to}` : to, From: channel === 'whatsapp' ? process.env.TWILIO_FROM || '' : process.env.TWILIO_SMS_FROM || process.env.TWILIO_FROM || '', Body: body });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64') },
      body: p,
    });
    if (!res.ok) throw new Error(`twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { provider: 'twilio', id: ((await res.json().catch(() => ({}))) as any)?.sid ?? null };
  }
  return { provider: 'stdout', id: null };
}

export async function dispatchNow(ctx: Ctx, limit = 40) {
  const q = db();
  const due = await q.all<any>(`SELECT * FROM notifications WHERE location_id = :l AND status = 'queued' AND (send_ts IS NULL OR send_ts <= :n) ORDER BY id LIMIT :lim`, { l: ctx.locId, n: Date.now(), lim: limit });
  let sent = 0;
  for (const n of due) {
    const t0 = Date.now();
    try {
      if (n.waitlist_offer_id) {
        const o = await q.one<any>('SELECT status, expires_ts FROM waitlist_offers WHERE id = :i', { i: n.waitlist_offer_id });
        if (!o || o.status !== 'pending' || o.expires_ts <= Date.now()) { await q.update('notifications', n.id, { status: 'cancelled' }); continue; }
      }
      if (n.channel === 'web') {
        await q.update('notifications', n.id, { status: 'sent', sent_ts: Date.now(), delivered_ts: Date.now() });
      } else if (n.channel === 'email') {
        const out = await sendEmail(n.recipient, n.subject ?? ctx.name, n.body_text, { kind: n.kind, vars: j<any>(n.meta_json, {}).vars ?? {}, brandName: ctx.name });
        await q.update('notifications', n.id, { status: 'sent', sent_ts: Date.now(), meta_json: sj({ ...j(n.meta_json, {}), provider: out.provider, provider_id: out.id }) });
        if (env.demo) console.log(`\n✉️  [demo email] → ${n.recipient}\n${n.subject}\n${n.body_text}\n`);
      } else if (n.channel === 'sms' || n.channel === 'whatsapp') {
        const out = await sendSms(n.recipient, n.body_text, n.channel === 'whatsapp' ? 'whatsapp' : 'sms');
        await q.update('notifications', n.id, { status: 'sent', sent_ts: Date.now(), meta_json: sj({ ...j(n.meta_json, {}), provider: out.provider, provider_id: out.id }) });
        if (env.demo) console.log(`\n📱 [demo ${n.channel}] → ${displayPhone(n.recipient)}\n${n.body_text}\n`);
      }
      sent++;
      await observe('notification', n.kind, Date.now() - t0, 'ok', { channel: n.channel });
    } catch (e: any) {
      const tries = Number(j<any>(n.meta_json, {}).tries ?? 0) + 1;
      await q.update('notifications', n.id, tries >= 3 ? { status: 'failed', failed_ts: Date.now(), error: String(e.message).slice(0, 240) } : { status: 'queued', send_ts: Date.now() + tries * 5 * MIN, meta_json: sj({ ...j(n.meta_json, {}), tries }), error: String(e.message).slice(0, 240) });
      await observe('notification', n.kind, Date.now() - t0, 'error', { error: String(e.message).slice(0, 160) });
    }
  }
  return { due: due.length, sent };
}

/** clic/ouverture sur un lien de rappel → analytics + fin du rappel */
export async function markEngaged(notificationId: number, kind: 'opened' | 'clicked') {
  const q = db();
  const n = await q.one<any>(`SELECT * FROM notifications WHERE id = :i`, { i: notificationId });
  if (!n) return null;
  await q.update('notifications', n.id, kind === 'clicked' ? { clicked_ts: Date.now(), status: n.status === 'sent' ? 'clicked' : n.status } : { read_ts: Date.now() });
  if (n.campaign_id) await q.exec(`UPDATE campaigns SET counts_json = counts_json WHERE id = :i`, { i: n.campaign_id });
  return n;
}

export async function outboxStats(ctx: Ctx) {
  const q = db();
  const rows = await q.all<any>(`SELECT kind, channel, status, COUNT(*) AS n FROM notifications WHERE location_id = :l AND created_ts > :s GROUP BY kind, channel, status`, { l: ctx.locId, s: Date.now() - 14 * DAY });
  return rows;
}

export { fmtDate, fmtTime };
