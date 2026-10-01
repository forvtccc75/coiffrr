/**
 * Vocabulaire unique du tunnel d'acquisition.
 *
 * Le client frappe `track(kind)`, le serveur valide, l'analyse agrège. Tant que chaque bout gardait
 * sa liste, les événements se perdaient sans bruit : `sendBeacon` ignore la réponse, donc un `kind`
 * inconnu du serveur = 422 jamais vu, et un entonnoir qui affiche 0 conversion sur un site qui en
 * reçoit. Les trois côtés lisent désormais le même tableau — et le type `FunnelKind` rend le
 * `track('kind_inventé')` impossible à la compilation.
 */
export const FUNNEL_STEPS = ['visit', 'service_view', 'availability_view', 'booking_start', 'contact_step', 'booking_confirmed'] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

/** Superset validé à l'écriture : les étapes + les vues annexes + les noms historiques déjà en base. */
export const FUNNEL_KINDS = [
  ...FUNNEL_STEPS,
  'booking_abandon',
  'gallery_view',
  'waitlist_view',
  'gift_view',
  'cta_click',
  'space_login_sent',
  'booking_view', // historique : remplacé par availability_view
  'service_pick', // historique : remplacé par service_view
  'day_pick', // historique : remplacé par booking_start
  'slot_pick_home', // historique : remplacé par booking_start
  'booking_done', // historique : remplacé par booking_confirmed
] as const;

export type FunnelKind = (typeof FUNNEL_KINDS)[number];

export const isFunnelKind = (v: unknown): v is FunnelKind => typeof v === 'string' && (FUNNEL_KINDS as readonly string[]).includes(v);
