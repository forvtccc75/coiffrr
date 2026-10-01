/** Initialisation de production : identité connue, agenda vide, aucun client ni compte fictif.
 * Équipe, prestations et prix seront saisis par le propriétaire dans Réglages.
 */
import { SALON_MAPS_URL, REFERENCE_HOURS } from '../../shared/salon.ts';
import { sj, type Q } from '../db/index.ts';
export async function initializeSalon(q: Q): Promise<number> {
  const now = Date.now();
  const tenantId = await q.insert('tenants', { name: 'Z.YASS Barber Shop', plan: 'pro', status: 'active', created_ts: now });
  const locationId = await q.insert('locations', {
    tenant_id: tenantId, slug: 'zyass', name: 'Z.YASS Barber Shop',
    legal_name: 'Z YASS BARBER SHOP — SARL (SIRET 918 535 071 00016)',
    timezone: 'Europe/Paris', phone: '+33644048385', email: null,
    brand_json: sj({ googleMapsUrl: SALON_MAPS_URL, logoUrl: '/brand/logo.png', hoursSource: 'Planity — à confirmer, horaires non publiés sur Google au 29/09/2026', name: 'Z.YASS Barber Shop', tagline: 'Le dégradé net, la barbe propre, sans attendre.', promise: 'Coupe, barbe et rasage traditionnel. Réservation en ligne, règlement sur place.', since: 2022 }),
    address_json: sj({ street: '20 boulevard Roy', city: 'Les Pavillons-sous-Bois', postalCode: '93320', country: 'FR', lat: 48.9100842, lng: 2.5173089 }),
    hours_json: sj(REFERENCE_HOURS),
    policy_json: sj({ leadTimeMin: 20, horizonDays: 30, cancelCutoffMin: 240, confirmRequired: false, reminderOffsets: [1440,180], deposit: { mode: 'none', amountCents: 0, percent: 0, aboveCents: 0 } }),
    features_json: sj({ deposits: false, membership: false, loyalty: false, referrals: false, priorityBooking: false, giftCards: true, waitlist: true, smartReminders: true, reviews: true, walkin: true, abandonRecovery: false }),
    holidays_json: '[]', created_ts: now, updated_ts: now,
  });
  // ── automatisations ───────────────────────────────────────────────
  const AU = [
    { key: 'auto_confirm', trigger: 'booking_created', action: 'send_notification', cfg: { template: 'booking_confirmed' }, name: 'Confirmation immédiate', desc: 'Email + SMS dès que le client valide.', cooldown: 0 },
    { key: 'auto_reminders', trigger: 'appointment_upcoming', action: 'send_notification', cfg: { offsets: [4320, 1440, 180] }, name: 'Rappels J-3 / J-1 / H-3', desc: 'Avec bouton Confirmer / Reporter en 1 clic.', cooldown: 0 },
    { key: 'auto_confirm_gate', trigger: 'reminder_d1', action: 'require_confirmation', cfg: { deadlineMin: 360 }, name: 'Demande de confirmation J-1', desc: 'Sans réponse, le créneau est repassé en priorités waitlist.', cooldown: 0 },
    { key: 'auto_waitlist_replay', trigger: 'slot_freed', action: 'notify_waitlist', cfg: { ttlMin: 12, maxPerSlot: 3 }, name: 'Recyclage des créneaux libérés', desc: 'Dès qu\'un RDV saute, la waitlist est notifiée automatiquement.', cooldown: 0 },
    { key: 'auto_review', trigger: 'appointment_completed', action: 'send_notification', cfg: { template: 'review_request', delayMin: 45 }, name: 'Demande d\'avis', desc: 'Positif → Google. Négatif → formulaire privé (jamais public).', cooldown: 0 },
    { key: 'auto_rebook', trigger: 'appointment_completed', action: 'send_notification', cfg: { template: 'rebook_suggestion', useHabit: true }, name: 'Relance rebooking intelligente', desc: 'Selon la fréquence de retour réelle du client.', cooldown: 240 },
    { key: 'auto_winback', trigger: 'customer_inactive', action: 'send_notification', cfg: { template: 'winback', afterDays: 45 }, name: 'Win-back', desc: 'Un seul message, puis plus rien pendant 90 jours.', cooldown: 2160 },
    { key: 'auto_birthday', trigger: 'customer_birthday', action: 'loyalty_bonus', cfg: { points: 20, label: 'BONUS ANNIVERSAIRE' }, name: 'Bonus anniversaire', desc: 'Points offerts, plus message si consentement marketing.', cooldown: 0 },
    { key: 'auto_welcome', trigger: 'first_booking', action: 'send_notification', cfg: { template: 'welcome' }, name: 'Message de bienvenue', desc: 'Envoyé après le premier RDV réservé.', cooldown: 0 },
    { key: 'auto_noshow_escalation', trigger: 'customer_noshow', action: 'apply_policy', cfg: { forceDepositAfter: 2 }, name: 'Escalade acompte après no-show', desc: 'Acompte obligatoire après 2 absences. Jamais punitif sans règle.', cooldown: 0 },
    { key: 'auto_draft_recover', trigger: 'booking_draft_abandoned', action: 'send_notification', cfg: { template: 'draft_abandon', afterMin: 40 }, name: 'Rattrapage d\'abandon', desc: 'Uniquement si email fourni + opt-in. Sinon : rien.', cooldown: 2880 },
    { key: 'auto_referral_reward', trigger: 'referral_converted', action: 'grant_reward', cfg: { referrerCents: 500, refereeCents: 500 }, name: 'Récompense parrainage', desc: 'Versée après le 1er RDV honoré du filleul.', cooldown: 0 },
  ];
  for (const a of AU) {
    await q.insert('automations', {
      location_id: locationId,
      key: a.key,
      trigger_key: a.trigger,
      action_type: a.action,
      name: a.name,
      description: a.desc,
      config_json: sj(a.cfg),
      is_active: ['auto_confirm', 'auto_reminders', 'auto_waitlist_replay'].includes(a.key) ? 1 : 0,
      cooldown_hours: a.cooldown ? Math.round(a.cooldown / 60) : 0,
      quiet_hours: sj({ from: '21:00', to: '08:30' }),
      max_per_week: 5,
      requires_owner_approval: a.action === 'apply_policy' || a.action === 'grant_reward' ? 1 : 0,
      updated_ts: now,
    });
  }

  return locationId;
}
