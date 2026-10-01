import { db, ready, sj, transaction } from '../db/index.ts';
import { hashPassword } from '../lib/secrets.ts';
import { normalizePhone } from '../lib/inputs.ts';
import { DAY, MIN, dateKey, dayAdd, startOfDayMs } from '../lib/time.ts';

/**
 * Jeu de données de démonstration pour Z.YASS Barber Shop.
 * Infos réelles (adresse, téléphone, horaires, prestations/tarifs publiquement listés sur Planity)
 * + historique synthétique clairement marqué `source='demo'` pour alimenter CRM & analytics.
 * Les avis publics affichés sur le site proviennent uniquement de sources vérifiables.
 */

const rnd = (seedRef: { s: number }) => {
  seedRef.s = (seedRef.s * 1103515245 + 12345) & 0x7fffffff;
  return seedRef.s / 0x7fffffff;
};
const pick = <T,>(arr: T[], r: () => number) => arr[Math.min(arr.length - 1, Math.floor(r() * arr.length))];

export interface SeedResult {
  locationId: number;
  customers: number;
  appointments: number;
  services: number;
  offerings: number;
}

export async function seedDemo(opts: { historyDays?: number; futureDays?: number } = {}): Promise<SeedResult> {
  await ready();
  const q = db();
  const now = Date.now();
  const R = { s: 20260920 };
  const r = () => rnd(R);
  const historyDays = opts.historyDays ?? 130;
  const futureDays = opts.futureDays ?? 21;

  const tenantId = await q.insert('tenants', { name: 'Z.YASS Barber Shop', plan: 'pro', status: 'active', created_ts: now });

  const hours: Record<string, [string, string][]> = {
    '0': [],
    '1': [['09:30', '20:00']],
    '2': [['09:30', '20:00']],
    '3': [['09:30', '20:00']],
    '4': [['09:30', '20:00']],
    '5': [['09:30', '20:00']],
    '6': [['09:30', '20:00']],
  };

  const locationId = await q.insert('locations', {
    tenant_id: tenantId,
    slug: 'zyass',
    name: 'Z.YASS Barber Shop',
    legal_name: 'Z YASS BARBER SHOP — SARL (SIRET 918 535 071 00016)',
    timezone: 'Europe/Paris',
    phone: '+33 6 44 04 83 85',
    email: 'contact@zyass-barber.fr',
    brand_json: sj({
      name: 'Z.YASS Barber Shop',
      tagline: 'Le dégradé net, la barbe propre, sans attendre.',
      // WhatsApp : le canal que le quartier utilise vraiment (numéro public, Planity/Google).
      whatsapp: '+33644048385',
      whatsappGreeting: 'Bonjour Z.YASS, je voudrais réserver une coupe. Quel créneau me proposez-vous ?',
      notifyChannel: 'whatsapp',
      promise: 'Coupe, barbe, rasage traditionnel. 3 barbiers, réservation en 20 secondes.',
      about:
        'Z.YASS est un barbershop de quartier au 20 boulevard Roy, aux Pavillons-sous-Bois. Ici, pas de fiche à remplir au téléphone : vous choisissez votre prestation, votre barbier et votre créneau, on vous rappelle pas pour confirmer — c’est déjà confirmé.',
      since: 2022,
      instagram: 'https://instagram.com/zyassbarbershop',
      tiktok: 'https://tiktok.com/@zyassbarbershop',
      googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=Z.YASS+Barber+Shop+20+Boulevard+Roy+93320+Les+Pavillons-sous-Bois',
      reviewUrl: 'https://www.planity.com/zyass-barber-shop-93320-les-pavillons-sous-bois',
      rating: { value: 5, count: 2, source: 'Planity' },
      logoText: 'Z',
      colors: { accent: '#E8C98A', bg: '#0B0B0D' },
      qrNote: 'Scanne, choisis, c’est réservé.',
    }),
    address_json: sj({
      street: '20 boulevard Roy',
      city: 'Les Pavillons-sous-Bois',
      postalCode: '93320',
      country: 'FR',
      lat: 48.9100842,
      lng: 2.5173089,
      district: 'Bd Roy, limite Clichy-sous-Bois',
      directions: 'À 6 min à pied du RER E / arrêt Chênes, face au boulanger. Parking gratuit bd Roy.',
      transit: 'Bus 147 — arrêt Pavillons-sous-Bois centre',
    }),
    hours_json: sj(hours),
    policy_json: sj({
      leadTimeMin: 20,
      horizonDays: futureDays,
      cancelCutoffMin: 4 * 3600,
      deposit: { mode: 'percent', amountCents: 1000, percent: 25, aboveCents: 4500 },
      confirmRequired: true,
      confirmOffsets: [1440],
      reminderOffsets: [4320, 1440, 180],
      waitlistOfferTtlMin: 12,
      noShowDepositEscalation: 2,
    }),
    features_json: sj({
      waitlist: true,
      loyalty: true,
      referrals: true,
      giftCards: true,
      membership: false,
      priorityBooking: true,
      deposits: true, // uniquement la démonstration ; production = PAYMENTS_PROVIDER=off
      reviews: true,
      walkin: true,
      upsell: true,
      smartReminders: true,
      abandonRecovery: true,
    }),
    holidays_json: sj([
      { day: '2026-11-01', name: 'Toussaint' },
      { day: '2026-11-11', name: 'Armistice' },
      { day: '2026-12-25', name: 'Noël' },
      { day: '2026-12-26', name: 'Lendemain de Noël' },
      { day: '2027-01-01', name: 'Jour de l’an' },
      { day: '2026-05-01', name: 'Fête du travail' },
    ]),
    created_ts: now,
    updated_ts: now,
  });

  const staffSeed = [
    { name: 'Yass', slug: 'yass', role_key: 'owner', title: 'Barbier — fondateur', color: '#E8C98A', bio: 'Le fondateur. Spécialiste dégradé américain et barbe sculptée.', commission: 55 },
    { name: 'Mehdi', slug: 'mehdi', role_key: 'staff', title: 'Barbier', color: '#9BC4E2', bio: 'Dégradés à zéro, contours nets, travail à la tondeuse.', commission: 35 },
    { name: 'Rayan', slug: 'rayan', role_key: 'staff', title: 'Barbier & couleur', color: '#C6A2F7', bio: 'Coloration, décoloration, soins. À l’écoute des clients qui hésitent.', commission: 35 },
  ];
  const staffIds: number[] = [];
  for (const [i, s] of staffSeed.entries()) {
    const id = await q.insert('staff', {
      location_id: locationId,
      name: s.name,
      slug: s.slug,
      role_key: s.role_key,
      title: s.title,
      bio: s.bio,
      color_hex: s.color,
      commission_pct: s.commission,
      is_active: 1,
      accept_new_clients: 1,
      display_order: i,
      created_ts: now,
    });
    staffIds.push(id);
  }

  const adminUserId = await q.insert('users', {
    location_id: locationId,
    email: 'owner@zyass.fr',
    name: 'Yass',
    role_key: 'owner',
    password_hash: hashPassword('demo-owner'),
    staff_id: staffIds[0],
    created_ts: now,
  });
  await q.insert('users', { location_id: locationId, email: 'mehdi@zyass.fr', name: 'Mehdi', role_key: 'staff', password_hash: hashPassword('demo-staff'), staff_id: staffIds[1], created_ts: now });
  await q.insert('users', { location_id: locationId, email: 'rayan@zyass.fr', name: 'Rayan', role_key: 'staff', password_hash: hashPassword('demo-staff'), staff_id: staffIds[2], created_ts: now });

  // horaires + pauses
  for (const [i, sid] of staffIds.entries()) {
    for (let d = 2; d <= 6; d++) {
      await q.insert('working_hours', { location_id: locationId, staff_id: sid, dow: d, start_min: 570, end_min: 1200 });
    }
    await q.insert('shift_breaks', { location_id: locationId, staff_id: sid, dow: 2, start_min: 780 + i * 20, end_min: 820 + i * 20, label: 'Pause méridienne' });
    await q.insert('shift_breaks', { location_id: locationId, staff_id: sid, dow: 3, start_min: 780 + i * 20, end_min: 820 + i * 20, label: 'Pause méridienne' });
    await q.insert('shift_breaks', { location_id: locationId, staff_id: sid, dow: 4, start_min: 780 + i * 20, end_min: 820 + i * 20, label: 'Pause méridienne' });
    await q.insert('shift_breaks', { location_id: locationId, staff_id: sid, dow: 5, start_min: 780 + i * 20, end_min: 820 + i * 20, label: 'Pause méridienne' });
    await q.insert('shift_breaks', { location_id: locationId, staff_id: sid, dow: 6, start_min: 760 + i * 20, end_min: 790 + i * 20, label: 'Pause méridienne' });
  }
  // indisponibilités réelles
  await q.insert('blocks', { location_id: locationId, staff_id: staffIds[1], start_ts: startOfDayMs(dayAdd(dateKey(now), 3)) + 13 * 60 * MIN, end_ts: startOfDayMs(dayAdd(dateKey(now), 3)) + 17 * 60 * MIN, kind: 'absence', reason: 'Formation couleur', created_ts: now });
  await q.insert('blocks', { location_id: locationId, staff_id: null, start_ts: startOfDayMs(dayAdd(dateKey(now), 9)) + 9 * 60 * MIN, end_ts: startOfDayMs(dayAdd(dateKey(now), 9)) + 12 * 60 * MIN, kind: 'private_event', reason: 'Événement privé (salon fermé le matin)', created_ts: now });

  // ── catalogue ─────────────────────────────────────────────────────
  const S = [
    { key: 'coupe-homme', name: 'Coupe homme', cat: 'coupe', price: 2500, dur: 30, short: 'Dégradé ou coupe ciseaux, finitions au rasoir.', desc: 'Shampooing, coupe, dégradé, finitions, coiffage. Contours nets assurés.', popular: 1, problem: 'Tu veux une coupe nette, pas un coup de tondeuse rapide.', solution: '30 minutes, dégradé travaillé, contours au rasoir, conseil coiffage.' },
    { key: 'degrade', name: 'Dégradé américain / skin fade', cat: 'coupe', price: 2800, dur: 35, short: 'Fondu à zéro, ligne franche.', desc: 'Dégradé bas/mi-haut au choix, rasage du contour, finition à la lame.', popular: 2, problem: 'Les dégradés ratés, ça se voit tout de suite.', solution: 'Travail à la tondeuse + rasoir, contrôle du fondu à chaque étape.' },
    { key: 'barbe', name: 'Taille de barbe', cat: 'barbe', price: 1500, dur: 20, short: 'Sculptée, contours au rasoir.', desc: 'Sculpture, dégradé de longueur, contours joues/nuque, huile.', popular: 3, problem: 'Une barbe non taillée vieillit le visage.', solution: 'Contours redessinés, longueur équilibrée, huile nourrissante.' },
    { key: 'coupe-barbe', name: 'Coupe + barbe', cat: 'forfait', price: 3500, dur: 45, short: 'Le forfait qui remet le visage d’aplomb.', desc: 'Coupe complète + taille de barbe avec contours au rasoir.', popular: 0, bundle: true, problem: 'Tu as besoin des deux et tu n’as pas 1 h 30.', solution: '45 minutes, un seul créneau, 5 € de moins qu’en séparant.' },
    { key: 'rasage-traditionnel', name: 'Rasage traditionnel à la lame', cat: 'barbe', price: 2500, dur: 30, short: 'Serviette chaude, blaireau, lame.', desc: 'Préparation vapeur, rasage à la lame, soin après-rasage.', popular: 0 },
    { key: 'tete-rasee', name: 'Tête rasée', cat: 'coupe', price: 2000, dur: 25, short: 'Rasage complet, crâne nettoyé.', desc: 'Tonte, rasage à la lame, hydratation.' },
    { key: 'coupe-enfant', name: 'Coupe enfant (-12 ans)', cat: 'coupe', price: 2000, dur: 25, short: 'Calme, rapide, récompensée.', desc: 'Coupe adaptée, sans stress, assis sur le siège enfant.', age: 'enfant' },
    { key: 'coupe-ado', name: 'Coupe ado (12-17 ans)', cat: 'coupe', price: 2200, dur: 30, short: 'Tarif réduit, même exigence.', desc: 'Dégradé, contours, coiffage.', age: 'ado' },
    { key: 'coloration', name: 'Coloration / camouflage barbe', cat: 'couleur', price: 2500, dur: 30, short: 'Sans effet racine, naturel.', desc: 'Coloration barbe ou cheveux, test mèche inclus.', level: 'inter', problem: 'Les cheveux gris te vieillissent de 10 ans.', solution: 'Camouflage léger, résultat naturel, 30 minutes.' },
    { key: 'decoloration', name: 'Décoloration / mèches', cat: 'couleur', price: 5500, dur: 75, short: 'Blond contrôlé, soin inclus.', desc: 'Décoloration partielle ou complète, patine et soin reconstructeur.', level: 'expert', problem: 'Un blond raté, ça se rattrape mal.', solution: 'Protocole en 2 étapes, test de mèche, soin reconstructeur, patine offerte.' },
    { key: 'soin-capillaire', name: 'Soin capillaire / cuir chevelu', cat: 'soin', price: 2000, dur: 20, short: 'Hydratation, démangeaisons, pellicules.', desc: 'Diagnostic, masque, massage crânien.' },
    { key: 'forfait-etudiant', name: 'Forfait étudiant', cat: 'forfait', price: 2200, dur: 30, short: 'Sur présentation de la carte.', desc: 'Coupe homme au tarif étudiant.' },
    { key: 'mariage', name: 'Coiffure événement / mariage', cat: 'evenement', price: 6000, dur: 60, short: 'Essai + jour J, à domicile possible.', desc: 'Préparation, essai, tenue longue durée, déplacement 93 inclus.', level: 'expert' },
    { key: 'contour', name: 'Contours / lignes (hors coupe)', cat: 'barbe', price: 1000, dur: 15, short: 'Remise à neuf entre deux RDV.' },
  ];
  const serviceIds: Record<string, number> = {};
  for (const [i, s] of S.entries()) {
    const id = await q.insert('services', {
      location_id: locationId,
      key: s.key,
      name: s.name,
      category: s.cat,
      short_desc: s.short ?? null,
      description: s.desc ?? null,
      base_price_cents: s.price,
      base_duration_min: s.dur,
      prep_min: 3,
      cleanup_min: 5,
      level: s.level ?? 'tous',
      age: s.age ?? 'adulte',
      gender: 'm',
      is_active: 1,
      display_order: i,
      price_from_label: null,
      problem: s.problem ?? null,
      solution: s.solution ?? null,
      seo_title: `${s.name} — Les Pavillons-sous-Bois`,
      seo_desc: (s.short ?? s.desc ?? s.name) + ' Chez Z.YASS Barber Shop, 20 bd Roy. Réservation en ligne, confirmation immédiate.',
      faq_json: sj(
        s.key === 'decoloration'
          ? [
              { q: 'Est-ce que ça abîme les cheveux ?', a: 'Une décoloration bien conduite abîme peu : on fait un test de mèche, on respecte le temps de pose et on termine par un soin reconstructeur.' },
              { q: 'Combien de temps pour un blond ?', a: 'Compte 1 h 15 à 2 h selon la base. Sur cheveux noirs, on vise souvent un blond chaud plutôt qu’un blond polaire en une séance.' },
              { q: 'Il faut payer un acompte ?', a: 'Oui, 25 % pour réserver. Il est déduit du prix final, et remboursé si tu annules plus de 4 h avant.' },
            ]
          : s.key === 'coupe-homme'
            ? [
                { q: 'Faut-il prendre rendez-vous ?', a: 'C’est fortement conseillé : sans créneau, tu peux finir avec 1 h d’attente. Réserve en 20 secondes, on garde le fauteuil.' },
                { q: 'Tu fais les contours au rasoir ?', a: 'Oui, systématiquement, sans supplément.' },
                { q: 'Je peux venir avec une photo ?', a: 'Oui, et c’est recommandé. On regarde ensemble ce qui est faisable sur ta nature de cheveux.' },
              ]
            : [
                { q: 'Durée ?', a: `${s.dur} minutes sur le fauteuil, plus 5 minutes de nettoyage du poste.` },
                { q: 'Annulation ?', a: 'Libre jusqu’à 4 h avant, en un clic depuis le lien de confirmation.' },
              ],
      ),
      updated_ts: now,
    });
    serviceIds[s.key] = id;
  }

  // compétences : tout le monde ne fait pas tout
  const skills: Record<string, number[]> = {
    'coupe-homme': [0, 1, 2],
    degrade: [0, 1, 2],
    barbe: [0, 1, 2],
    'coupe-barbe': [0, 1, 2],
    'rasage-traditionnel': [0],
    'tete-rasee': [0, 1, 2],
    'coupe-enfant': [0, 1, 2],
    'coupe-ado': [0, 1, 2],
    coloration: [2, 0],
    decoloration: [2],
    'soin-capillaire': [2, 0, 1],
    'forfait-etudiant': [0, 1, 2],
    mariage: [0, 2],
    contour: [0, 1, 2],
  };
  for (const [key, ids] of Object.entries(skills)) {
    for (const i of ids) {
      await q.insert('staff_skills', { staff_id: staffIds[i], service_id: serviceIds[key], price_cents: key === 'degrade' && i === 0 ? 3000 : null, duration_min: null, level: i === 0 ? 'expert' : null });
    }
  }

  const A = [
    { key: 'addon-barbe', name: 'Taille de barbe', price: 1500, dur: 20, after: 'coupe-homme', hint: '+ 5 € vs. prendre un RDV séparé' },
    { key: 'addon-soin', name: 'Soin capillaire express', price: 1200, dur: 15, after: 'coupe-homme', hint: 'Cheveux secs ou cuir chevelu qui gratte' },
    { key: 'addon-contour', name: 'Contours au rasoir', price: 800, dur: 10, after: 'coupe-homme' },
    { key: 'addon-rasage', name: 'Rasage traditionnel', price: 2000, dur: 25, after: 'barbe' },
    { key: 'addon-cire', name: 'Produit coiffant (cire/pâte)', price: 1200, dur: 0, after: 'coupe-homme', hint: 'Le pot rapporté à la maison' },
    { key: 'addon-patte', name: 'Patine (après décoloration)', price: 1500, dur: 15, after: 'decoloration' },
    { key: 'addon-shampooing', name: 'Shampooing traitant', price: 600, dur: 5, after: 'coupe-homme' },
  ];
  const addonIds: Record<string, number> = {};
  for (const [i, a] of A.entries()) {
    addonIds[a.key] = await q.insert('addons', {
      location_id: locationId,
      key: a.key,
      name: a.name,
      price_cents: a.price,
      duration_min: a.dur,
      description: a.hint ?? null,
      category: a.key.includes('cire') ? 'produit' : 'soin',
      is_active: 1,
      display_order: i,
      suggest_after_service_key: a.after,
      hint: a.hint ?? null,
    });
  }

  // prestations réservables (service × équipe) + bundles populaires
  let offeringCount = 0;
  for (const s of S) {
    const svc = await q.one<any>(`SELECT * FROM services WHERE id = :i`, { i: serviceIds[s.key] });
    const id = await q.insert('offerings', {
      location_id: locationId,
      service_id: svc.id,
      staff_id: null,
      addon_ids: sj([]),
      name: svc.name,
      description: svc.short_desc,
      duration_min: svc.base_duration_min,
      price_cents: svc.base_price_cents,
      is_active: 1,
      is_popular: svc.popular && svc.popular <= 3 ? 1 : 0,
      display_order: offeringCount,
      updated_ts: now,
    });
    offeringCount++;
    void id;
  }
  const bundleCoupeBarbe = await q.insert('offerings', {
    location_id: locationId,
    service_id: serviceIds['coupe-barbe'],
    staff_id: null,
    addon_ids: sj([addonIds['addon-contour']]),
    name: 'Coupe + barbe + contours',
    description: 'Le forfait complet, 50 minutes, reparti net de la tête à la barbe.',
    duration_min: 50,
    price_cents: 3800,
    is_active: 1,
    is_popular: 1,
    display_order: 0,
    updated_ts: now,
  });
  void bundleCoupeBarbe;

  // ── médias / galerie (visuels d'illustration, à remplacer par les photos du salon) ──
  const gallery = [
    { path: '/brand/tools.jpg', label: 'Dégradé bas + contours', key: 'degrade', price: 2800, dur: 35 },
    { path: '/brand/hero.jpg', label: 'Le salon, bd Roy', key: null, price: null, dur: null },
    { path: '/brand/marble.jpg', label: 'Barbe sculptée à la lame', key: 'barbe', price: 1500, dur: 20 },
  ];
  for (const [i, g] of gallery.entries()) {
    await q.insert('media', {
      location_id: locationId,
      path: g.path,
      alt: g.label,
      kind: i === 1 ? 'place' : 'photo',
      label: g.label,
      service_key: g.key,
      price_cents: g.price,
      duration_min: g.dur,
      before_after: 0,
      aspect: '4/5',
      ts: now - i * DAY,
      like_count: 0,
    });
  }

  // ── templates de notifications ───────────────────────────────────
  const T = [
    { key: 'booking_confirmed', channel: 'sms', body: '{prenom}, c\'estbooké ✔\n{service} — {jour} {date} à {heure}\n{staff}\nZ.YASS Barber Shop, 20 bd Roy\nModifier : {link_manage}' },
    { key: 'booking_confirmed', channel: 'email', subject: 'Rendez-vous confirmé — {date} à {heure}', body: 'Bonjour {prenom},\n\nTa prestation « {service} » avec {staff} est confirmée pour {jour} {date} à {heure} (durée {duree}, {prix}).\n\nAdresse : 20 boulevard Roy, 93320 Les Pavillons-sous-Bois — {maps}\n\nBesoin de changer ? Tout est possible en un clic : {link_manage}\n\nÀ vite,\nL\'équipe Z.YASS' },
    { key: 'reminder_d3', channel: 'sms', body: 'Rappel : {service} {jour} {date} à {heure} chez Z.YASS. Tout est OK ? Confirmer : {link_confirm} — Décaler : {link_reschedule}' },
    { key: 'reminder_d1', channel: 'sms', body: 'Demain {heure}, c\'est toi ! Confirme en 1 clic : {link_confirm}. Besoin de bouger ? {link_reschedule}' },
    { key: 'reminder_h3', channel: 'sms', body: 'On t\'attend à {heure} ({service}). Le salon est ouvert, viens 5 min avant. Un souci : {phone}' },
    { key: 'confirm_needed', channel: 'sms', body: '{prenom}, confirme ton RDV {jour} {date} à {heure} (1 clic) : {link_confirm}. Sinon on repasse le créneau à quelqu\'un d\'autre. Reporter : {link_reschedule}' },
    { key: 'cancelled', channel: 'sms', body: 'RDV du {date} {heure} annulé. {deposit_msg} Nouveau créneau quand tu veux : {link_book}' },
    { key: 'rescheduled', channel: 'sms', body: 'C\'est noté : {service} décalé au {jour} {date} à {heure}. Tout le reste est à jour : {link_manage}' },
    { key: 'waitlist_offer', channel: 'sms', body: 'Un créneau se libère pour toi : {service} {jour} {date} à {heure}. Réserve en 1 clic (valide {ttl} min) : {link_claim}. Refuser : {link_decline}' },
    { key: 'waitlist_promised', channel: 'sms', body: 'Dispo trouvée sur ton horizon ! Ton accès waitlist prioritaire : {link_book}' },
    { key: 'review_request', channel: 'sms', body: '{prenom}, comment c\'était ? Dis-nous en 10 secondes : {link_review} — ça aide vraiment le salon.' },
    { key: 'review_thanks', channel: 'sms', body: 'Merci ! Si tu as 20 secondes, un avis Google aide plus que n\'importe quelle pub : {link_google}' },
    { key: 'rebook_suggestion', channel: 'sms', body: '{prenom}, ça fait {jours} depuis ta dernière {service}. Les prochains créneaux avec {staff} : {link_book}' },
    { key: 'winback', channel: 'sms', body: 'Ça fait un moment. On a une place pour toi cette semaine chez Z.YASS : {link_book} (envie de rien ? Juste « STOP »)' },
    { key: 'birthday', channel: 'sms', body: 'Joyeux anniversaire {prenom} ! Ton cadeau : {reward} offert sur ta prochaine venue : {link_book}' },
    { key: 'welcome', channel: 'email', subject: 'Bienvenue chez Z.YASS — ce qu\'il faut savoir', body: 'Salut {prenom},\n\n1. Viens 5 min avant, on démarre à l\'heure.\n2. Envoie la photo de ton inspiration, on tranche ensemble.\n3. Annuler ou décaler = 1 clic ici : {link_manage} (libre jusqu\'à 4 h avant).\n4. Reviens à 3-4 semaines, le dégradé reste propre.\n\nL\'équipe' },
    { key: 'draft_abandon', channel: 'email', subject: 'Tu n\'as pas terminé ta réservation', body: 'Bonjour {prenom},\n\nTon créneau {slot} n\'est pas réservé — personne ne l\'a pris à ta place.\n\nReprendre en 1 clic : {link_resume}\nSi tu préfères une autre date ou un autre barbier, tout est ici : {link_book}\n\nÀ bientôt,\nZ.YASS' },
    { key: 'deposit_paid', channel: 'sms', body: 'Acompte de {deposit} reçu ✔ Ton RDV {date} {heure} est bloqué. Solde sur place : {balance}.' },
    { key: 'referral_success', channel: 'sms', body: '{parrain}, ton filleul a réservé ! Ta récompense {reward} est débloquée : {link_book}' },
    { key: 'noshow_notice', channel: 'email', subject: 'Ton rendez-vous manqué', body: 'Bonjour {prenom},\n\nOn t\'a attendu à {heure}. Le créneau était bloqué pour toi.\n\nReprendre : {link_book}\n\nPour info : au-delà de 2 rendez-vous manqués, un acompte est demandé à la réservation — c\'est automatique et ça protège tout le monde.' },
  ];
  for (const t of T) {
    await q.insert('templates', { location_id: locationId, key: t.key, channel: t.channel, lang: 'fr', subject: (t as any).subject ?? null, body_text: t.body, is_active: 1, updated_ts: now });
  }

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
      is_active: 1,
      cooldown_hours: a.cooldown ? Math.round(a.cooldown / 60) : 0,
      quiet_hours: sj({ from: '21:00', to: '08:30' }),
      max_per_week: 5,
      requires_owner_approval: a.action === 'apply_policy' || a.action === 'grant_reward' ? 1 : 0,
      updated_ts: now,
    });
  }

  // ── fidélité & parrainage ─────────────────────────────────────────
  const rewardId = await q.insert('loyalty_rewards', {
    location_id: locationId,
    name: 'Barbe offerte',
    description: 'Après 5 visites : taille de barbe (valeur 15 €) offerte.',
    kind: 'free_service',
    value_cents: 1500,
    threshold_visits: 5,
    points_cost: 120,
    is_active: 1,
    points_per_visit: 25,
    birthday_bonus_points: 20,
  });
  void rewardId;
  await q.insert('loyalty_rewards', { location_id: locationId, name: '-10 % sur la prochaine prestation', description: 'Atteint à 200 points.', kind: 'discount', value_cents: 0, threshold_visits: 0, points_cost: 200, is_active: 1, points_per_visit: 25, birthday_bonus_points: 0 });

  // ── contenu SEO ───────────────────────────────────────────────────
  const P = [
    {
      slug: 'guide-degrade-amerain',
      kind: 'guide',
      title: 'Dégradé américain : le guide pour ne plus se tromper de demande',
      summary: 'Low, mid, high, skin fade : quelle longueur de fondu sur ta tête, et comment l\'expliquer au barbier.',
      service: 'degrade',
      body: [
        { type: 'p', text: 'Un dégradé raté ne se rattrape pas dans la journée : on enlève, on remet pas. La bonne nouvelle, c\'est qu\'il suffit de trois mots pour se faire comprendre : bas, milieu, haut.' },
        { type: 'h', text: 'Les 3 familles de dégradés' },
        { type: 'p', text: 'Le low fade démarre juste au-dessus de l\'oreille : discret, parfait pour une première fois ou un environnement strict. Le mid fade est le plus polyvalent, il allonge visuellement le visage. Le high fade et le skin fade, eux, assument : très courts sur les côtés, contraste franc avec le dessus.' },
        { type: 'list', items: ['Visage rond → mid ou high fade, le contraste allonge.', 'Visage allongé → low fade, on évite de raccourcir encore le dessus.', 'Tempes qui creusent → ne pas descendre à zéro avant les tempes.', 'Cheveux frisés → garder 2-3 cm sur le dessus, sinon ça gonfle.'] },
        { type: 'h', text: 'La fréquence qui garde le résultat net' },
        { type: 'p', text: 'Un skin fade se regarde 10 à 12 jours. Une coupe plus longue tient 4 semaines. Aux Pavillons-sous-Bois, la plupart de nos clients reviennent toutes les 3 semaines : c\'est le meilleur compromis prix/rendu. Nous t\'envoyons un rappel à ce moment-là — pas avant.' },
        { type: 'cta', text: 'Réserver un dégradé avec le barbier de ton choix' },
      ],
    },
    {
      slug: 'guide-barbe-propre',
      kind: 'guide',
      title: 'Barbe propre au quotidien : 4 gestes, 3 minutes le matin',
      summary: 'Huile, brosse, ligne de joues : ce qui change vraiment le rendu entre deux passages au salon.',
      service: 'barbe',
      body: [
        { type: 'p', text: 'Une barbe qui paraît soignée n\'est pas une barbe longue, c\'est une barbe hydratée et dessinée.' },
        { type: 'list', items: ['Après la douche, 4 à 6 gouttes d\'huile, dans le sens du poil puis à rebours.', 'Brosse en poils pour répartir et discipliner.', 'La ligne de joues se rase à la lame, pas au rasoir de sûreté : elle reste nette 3 jours de plus.', 'Taille tous les 10-12 jours, sinon les pointes fourchues donnent un effet "broussaille".'] },
        { type: 'h', text: 'Et si tu pars de zéro ?' },
        { type: 'p', text: 'On dessine d\'abord la forme sur ta mâchoire, on ne suit pas la pousse existante. C\'est le seul point qui fait la différence entre une barbe "étudiant en licence" et une barbe qui structure le visage.' },
        { type: 'cta', text: 'Réserver une taille de barbe' },
      ],
    },
    {
      slug: 'faq',
      kind: 'faq',
      title: 'Questions fréquentes',
      summary: 'Acompte, annulation, enfant, retard, moyen de paiement.',
      body: [],
      faq: [
        { q: 'Faut-il payer pour réserver ?', a: 'Pour les prestations longues (décoloration, événementiel) et après deux rendez-vous manqués, un acompte de 25 % est demandé. Il est déduit du prix final et remboursé intégralement si tu annules plus de 4 h avant. En dessous, rien à payer : tu règles sur place.' },
        { q: 'Puis-je annuler ou reporter ?', a: 'Oui, en un clic depuis le SMS ou l\'email de confirmation, sans nous appeler. Le créneau repart immédiatement dans la waitlist.' },
        { q: 'Et si j\'ai du retard ?', a: 'Préviens-nous par SMS au 06 44 04 83 85. Jusqu\'à 10 minutes, on garde la fin du créneau. Au-delà, on adapte la prestation ou on te propose un autre créneau — jamais d\'attente pour les suivants.' },
        { q: 'Vous coupez les cheveux des enfants ?', a: 'Oui, à partir de 3 ans, sur un siège rehausseur, 25 minutes chrono. Le créneau du mercredi après-midi est le plus demandé : réserve 10 jours avant.' },
        { q: 'Moyens de paiement ?', a: 'Espèces, carte, sans contact, et les cartes cadeaux Z.YASS. Facture sur demande.' },
        { q: 'Vous faites les contours rasoir ?', a: 'Systématiquement, inclus dans toutes les coupes.' },
        { q: 'Où se garer ?', a: 'Boulevard Roy, stationnement gratuit devant le salon et en face, hors zone livraisons du matin.' },
        { q: 'Puis-je venir avec une photo ?', a: 'Oui — c\'est même notre méthode de travail. On regarde, on adapte à ta nature de cheveux et on te dit honnêtement si ça ne tiendra pas.' },
        { q: 'Vous acceptez les sans rendez-vous ?', a: 'Quand un fauteuil est libre, oui. On garde 2 à 3 places par jour pour le quartier. Tu peux rejoindre la file d\'attente sur place depuis le lien file d\'attente : on te donne une heure de passage estimée.' },
      ],
    },
  ];
  for (const p of P) {
    await q.insert('content_pages', {
      location_id: locationId,
      slug: p.slug,
      kind: p.kind,
      title: p.title,
      summary: p.summary,
      body_json: sj((p as any).body ?? []),
      service_key: (p as any).service ?? null,
      faq_json: sj((p as any).faq ?? []),
      seo_title: p.title,
      seo_desc: p.summary,
      is_published: 1,
      reading_min: 3,
      created_ts: now,
      updated_ts: now,
    });
  }

  // ── clients & historique synthétiques ─────────────────────────────
  const first = ['Adam', 'Soufiane', 'Karim', 'Luca', 'Ilan', 'Bilal', 'Mamadou', 'Théo', 'Wassim', 'Elias', 'Noah', 'Idriss', 'Malik', 'Youssef', 'Ali', 'Enzo', 'Sacha', 'Dylan', 'Abdou', 'Nathan', 'Ismaël', 'Loris', 'Sean', 'Wali', 'Zak', 'Amine', 'Kevin', 'Yanis', 'Ziad', 'Bastien', 'Cedric', 'Dario', 'Evan', 'Florian', 'Hamza', 'Ilyes', 'Loïc', 'Marek', 'Nelson', 'Osman', 'Paul', 'Ruben', 'Sohan', 'Timéo', 'Wylan', 'Gabin', 'Hugo', 'Jibril', 'Aymen', 'Nino', 'Fares', 'Rayane', 'Tanguy', 'Sacha2', 'Noam', 'Aylan', 'Ilyasse'];
  const last = ['Benali', 'Diallo', 'Fernandez', 'Gomis', 'Haddad', 'Koné', 'Lopez', 'Moreau', 'Nguyen', 'Pereira', 'Rousseau', 'Sissoko', 'Traoré', 'Zerrouki', 'Bensaid', 'Chevalier', 'Diarra', 'El Amrani', 'Fontaine', 'Garcia'];
  const sources = [
    { source: 'instagram', medium: 'social', campaign: 'reel-zero-fade', weight: 0.3 },
    { source: 'tiktok', medium: 'social', campaign: 'avant_apres_barbe', weight: 0.18 },
    { source: 'google', medium: 'organic', campaign: null, weight: 0.22 },
    { source: 'maps', medium: 'organic', campaign: 'fiche_etablissement', weight: 0.1 },
    { source: 'referral', medium: 'client', campaign: 'parrainage', weight: 0.1 },
    { source: 'qr', medium: 'offline', campaign: 'flyer_quartier', weight: 0.05 },
    { source: 'direct', medium: 'none', campaign: null, weight: 0.05 },
  ];
  const pickSource = () => {
    let x = rnd(R);
    for (const s of sources) {
      if (x < s.weight) return s;
      x -= s.weight;
    }
    return sources[0];
  };

  const svcRows = await q.all<any>(`SELECT * FROM services WHERE location_id = :l ORDER BY display_order`, { l: locationId });
  const offByService = new Map<number, number>();
  for (const o of await q.all<any>(`SELECT * FROM offerings WHERE location_id = :l`, { l: locationId })) offByService.set(o.service_id, o.id);
  const commonServices = svcRows.filter((s) => ['coupe-homme', 'degrade', 'coupe-barbe', 'barbe', 'coupe-enfant', 'forfait-etudiant', 'coloration'].includes(s.key));

  const customers: { id: number; name: string; phone: string; email: string; habit: number; svc: any; staffId: number; visits: number; lastTs: number | null }[] = [];
  let custCount = 0;
  for (let i = 0; i < 56; i++) {
    const fn = first[i % first.length];
    const ln = last[(i * 7) % last.length];
    const src = pickSource();
    const habit = 15 + Math.round(rnd(R) * 28);
    const svc = pick(commonServices , r)!;
    const staffId = staffIds[Math.floor(rnd(R) * 3)];
    const phone = `06${String(10000000 + Math.floor(rnd(R) * 89999999)).slice(0, 8)}`;
    const createdAt = now - (historyDays + Math.floor(rnd(R) * 220)) * DAY;
    const visitedTimes = 2 + Math.floor(rnd(R) * 6);
    const consentEmail = rnd(R) > 0.35 ? 1 : 0;
    const consentSms = rnd(R) > 0.25 ? 1 : 0;
    const birthDay = dateKey(startOfDayMs(`${1990 + (i % 12)}-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + ((i * 5) % 28)).padStart(2, '0')}`));
    const id = await q.insert('customers', {
      location_id: locationId,
      first_name: fn,
      last_name: ln,
      phone,
      phone_norm: normalizePhone(phone),
      email: `${fn.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}.${ln.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}${i}@mail.fr`,
      email_norm: `${fn.toLowerCase()}.${ln.toLowerCase()}${i}@mail.fr`.normalize('NFD').replace(/[^a-z@.0-9]/g, ''),
      birth_day: birthDay,
      preferred_staff_id: rnd(R) > 0.3 ? staffId : null,
      preferred_service_id: svc.id,
      preferred_channel: consentSms ? 'sms' : 'email',
      consent_marketing_email: consentEmail,
      consent_marketing_sms: consentSms,
      consent_terms_ts: createdAt,
      source: src.source,
      medium: src.medium,
      campaign: src.campaign,
      landing: `/${svc.key}`,
      device: rnd(R) > 0.25 ? 'mobile' : 'desktop',
      referrer: src.source === 'google' ? 'google.com' : src.source === 'instagram' ? 'instagram.com' : null,
      referral_code: `ZY-${(1000 + i).toString(36).toUpperCase()}`,
      notes: rnd(R) > 0.75 ? 'Préfère ne pas être rasé à la lame sur le cou (feu du rasoir).' : null,
      tags: sj(rnd(R) > 0.8 ? ['vip'] : []),
      created_ts: createdAt,
      updated_ts: now,
    });
    custCount++;

    // historique de visites : chaînes de RDV honorés espacées de l'habitude du client
    let cursor = now - Math.floor(rnd(R) * 25) * DAY - 2 * DAY;
    let spent = 0;
    let visits = 0;
    let noshow = 0;
    let cancels = 0;
    for (let v = 0; v < visitedTimes; v++) {
      let start = startOfDayMs(dateKey(cursor)) + (10 * 60 + 10 * Math.floor(rnd(R) * 6)) * MIN;
      const price = svc.base_price_cents + (rnd(R) > 0.6 ? 1500 : 0);
      const status = rnd(R) < 0.06 ? 'no_show' : rnd(R) < 0.1 ? 'cancelled' : 'completed';
      /* Historique de démonstration cohérent : deux rendez-vous du même barbier ne se posent pas
         l'un sur l'autre. Sans cette boucle, le générateur écrivait des chevauchements dans le passé
         (12 relevés le 21/09) — l'agenda rejoué du back-office affichait alors deux fiches au même
         créneau, et le taux de remplissage calculé devenait impossible à expliquer au client. */
      let libre = false;
      for (let g = 0; g < 18 && !libre; g++) {
        libre = !(await q.one<any>(
          `SELECT 1 AS x FROM appointments WHERE staff_id = :s AND status <> 'cancelled' AND start_ts < :e AND end_ts > :st LIMIT 1`,
          { s: staffId, st: start, e: start + svc.base_duration_min * MIN },
        ));
        if (!libre) start += 10 * MIN;
      }
      if (!libre) {
        cursor -= habit * DAY;
        continue;
      }
      if (status === 'completed') {
        spent += price;
        visits++;
        cursor -= habit * DAY + Math.round((rnd(R) - 0.5) * 6) * DAY;
      } else if (status === 'no_show') {
        noshow++;
        cursor -= habit * DAY;
      } else {
        cancels++;
        cursor -= habit * DAY;
      }
      const apptId = await q.insert('appointments', {
        location_id: locationId,
        customer_id: id,
        offering_id: offByService.get(svc.id)!,
        service_id: svc.id,
        staff_id: staffId,
        start_ts: start,
        end_ts: start + svc.base_duration_min * MIN,
        status,
        price_cents: price,
        paid_cents: status === 'completed' ? price : 0,
        deposit_cents: 0,
        deposit_status: 'none',
        duration_min: svc.base_duration_min,
        source: src.source,
        medium: src.medium,
        campaign: src.campaign,
        device: 'mobile',
        completed_ts: status === 'completed' ? start + svc.base_duration_min * MIN : null,
        created_ts: start - 4 * DAY,
        updated_ts: start,
        confirmed_ts: status === 'completed' ? start - DAY : null,
        confirm_required: 0,
      });
      if (status === 'completed') {
        await q.insert('loyalty_ledger', { location_id: locationId, customer_id: id, points: 25, reason: 'visit', appointment_id: apptId, balance_after: visits * 25, ts: start });
        if (rnd(R) > 0.72) {
          const rating = rnd(R) > 0.15 ? 5 : 4;
          await q.insert('reviews', {
            location_id: locationId,
            appointment_id: apptId,
            customer_id: id,
            rating,
            title: null,
            comment:
              rating === 5
                ? pick(['Dégradé nickel, contours propres, reparti content.', 'Équipe au top, ponctuel, ça change des autres barbiers.', 'Bon accueil, coupé net, à l’heure.', 'Pris à 18h10, sorti à 18h40, impeccable.'], () => rnd(R))
                : 'Bon travail mais un peu d’attente malgré le créneau réservé.',
            status: 'private',
            visibility: 'private',
            channel: 'demo',
            staff_id: staffId,
            service_id: svc.id,
            consent_publish: 0,
            created_ts: start + 2 * DAY,
            updated_ts: start + 2 * DAY,
          });
        }
      }
      await q.insert('appointment_events', { appointment_id: apptId, kind: 'created', data_json: sj({ demo: true }), actor_type: 'system', ts: start - 4 * DAY });
    }
    customers.push({ id, name: `${fn} ${ln}`, phone, email: `${fn}.${ln}${i}@mail.fr`, habit, svc, staffId, visits, lastTs: status0(visits, cursor) });
    await q.update('customers', id, {
      visits_count: visits,
      spent_cents: spent,
      loyalty_visits: visits,
      loyalty_points: visits * 25,
      noshow_count: noshow,
      cancelled_count: cancels,
      last_visit_ts: status0(visits, cursor),
      avg_days_between: habit,
      segment: 'active',
    });
  }

  // ── rendez-vous à venir : forte densité ven./sam., trous volontaires le reste ──
  let apptCount = 0;
  const upcomingCustomers = customers.slice(0, 44);
  for (const c of upcomingCustomers) {
    const daysAhead = 1 + Math.floor(rnd(R) * 13);
    const day = dayAdd(dateKey(now), daysAhead);
    const wd = new Date(startOfDayMs(day)).getUTCDay();
    if (wd === 0 || wd === 1) continue;
    const svc = c.svc;
    const staffId = c.staffId ?? staffIds[Math.floor(rnd(R) * 3)];
    const hourBase = wd === 5 || wd === 6 ? 10 * 60 + 30 : 9 * 60 + 60 + 30 * Math.floor(rnd(R) * 5);
    const start = startOfDayMs(day) + (hourBase + 10 * Math.floor(rnd(R) * 11)) * MIN;
    const needsDeposit = svc.base_price_cents >= 4500;
    try {
      const id = await transaction(async (t) => {
        const clash = await t.one<any>(
          `SELECT id FROM appointments WHERE staff_id = :s AND status IN ('booked','confirmed','pending_payment','held','waiting_client','in_progress') AND start_ts < :e AND end_ts > :st LIMIT 1`,
          { s: staffId, st: start, e: start + (svc.base_duration_min + svc.cleanup_min) * MIN },
        );
        if (clash) return null;
        const aid = await t.insert('appointments', {
          location_id: locationId,
          customer_id: c.id,
          offering_id: offByService.get(svc.id)!,
          service_id: svc.id,
          staff_id: staffId,
          start_ts: start,
          end_ts: start + svc.base_duration_min * MIN,
          status: needsDeposit ? 'pending_payment' : 'booked',
          price_cents: svc.base_price_cents,
          paid_cents: 0,
          deposit_cents: needsDeposit ? Math.round(svc.base_price_cents * 0.25) : 0,
          deposit_status: needsDeposit ? 'authorized' : 'none',
          duration_min: svc.base_duration_min,
          confirm_required: daysAhead >= 1 ? 1 : 0,
          source: 'demo',
          medium: 'seed',
          created_ts: now - 2 * DAY,
          updated_ts: now,
          reminder_offsets: sj([4320, 1440, 180]),
        });
        await t.insert('appointment_events', { appointment_id: aid, kind: 'created', data_json: sj({ demo: true }), actor_type: 'system', ts: now - 2 * DAY });
        return aid;
      });
      if (id) apptCount++;
    } catch {}
  }

  // une journée quasi-complète pour démontrer la waitlist (vendredi suivant)
  const busyDay = dayAdd(dateKey(now), (5 - new Date(startOfDayMs(dateKey(now))).getUTCDay() + 7) % 7 || 7);
  for (const sid of staffIds) {
    for (let m = 10 * 60; m < 19 * 60 + 30; m += 40) {
      const c = customers[Math.floor(rnd(R) * customers.length)];
      const svc = svcRows.find((s) => s.id === c.svc.id)!;
      try {
        await transaction(async (t) => {
          const clash = await t.one(`SELECT id FROM appointments WHERE staff_id = :s AND status IN ('booked','confirmed') AND start_ts < :e AND end_ts > :st LIMIT 1`, { s: sid, st: startOfDayMs(busyDay) + m * MIN, e: startOfDayMs(busyDay) + (m + svc.base_duration_min) * MIN });
          if (clash) return;
          await t.insert('appointments', {
            location_id: locationId,
            customer_id: c.id,
            offering_id: offByService.get(svc.id)!,
            service_id: svc.id,
            staff_id: sid,
            start_ts: startOfDayMs(busyDay) + m * MIN,
            end_ts: startOfDayMs(busyDay) + (m + svc.base_duration_min) * MIN,
            status: 'confirmed',
            price_cents: svc.base_price_cents,
            duration_min: svc.base_price_cents >= 0 ? svc.base_duration_min : 30,
            confirmed_ts: now - DAY,
            source: 'demo',
            created_ts: now - 6 * DAY,
            updated_ts: now,
          });
        });
        apptCount++;
      } catch {}
    }
  }

  // ── waitlist : la demande non satisfaite, matérialisée ───────────
  const wlSeeds = [
    { name: 'Idriss K.', phone: '0612345671', day: busyDay, svc: 'degrade', staff: staffIds[0], note: 'Dispo seulement après 17 h, je finis à 16 h 30.', prio: 0 },
    { name: 'Wassim B.', phone: '0612345672', day: busyDay, svc: 'coupe-barbe', staff: null, note: 'Samedi avant midi si possible.', prio: 0 },
    { name: 'Paul R.', phone: '0612345673', day: null, svc: 'decoloration', staff: staffIds[2], note: 'Flexible en semaine, idéalement 18 h.', prio: 0 },
    { name: 'Malik T.', phone: '0612345674', day: null, svc: 'coupe-homme', staff: null, note: 'Dès que possible, je m’adapte.', prio: 0 },
    { name: 'Enzo F.', phone: '0612345675', day: busyDay, svc: 'barbe', staff: staffIds[1], note: '', prio: 0 },
    { name: 'Sacha L.', phone: '0612345676', day: null, svc: 'coupe-enfant', staff: null, note: 'Mercredi avec mon fils de 6 ans.', prio: 0 },
    { name: 'Amine D.', phone: '0612345677', day: busyDay, svc: 'mariage', staff: staffIds[0], note: 'Témoin, mariage le 24/10 — besoin d’un essai avant.', prio: 1 },
  ];
  let wlCount = 0;
  for (const [i, w] of wlSeeds.entries()) {
    const svc = svcRows.find((s) => s.key === w.svc);
    await q.insert('waitlist', {
      location_id: locationId,
      name: w.name,
      phone: w.phone,
      phone_norm: normalizePhone(w.phone),
      email: null,
      service_id: svc?.id ?? null,
      offering_id: svc ? offByService.get(svc.id) ?? null : null,
      staff_id: w.staff,
      days: sj(w.day ? [w.day] : [0, 2, 3, 4, 5]),
      window_start_min: w.svc === 'coupe-enfant' ? 810 : null,
      window_end_min: w.svc === 'coupe-enfant' ? 1080 : null,
      flex_json: sj({ otherStaff: w.staff != null, otherDays: w.day == null, sameDayOtherTime: true }),
      note: w.note,
      priority: w.prio,
      status: 'active',
      queue_rank: i + 1,
      consent_contact: 1,
      source: 'booking_full',
      token: `demo-${i}`,
      created_ts: now - (i + 1) * 6 * 3600 * 1000,
      updated_ts: now,
    });
    wlCount++;
  }

  // ── avis publics vérifiables (source Planity, non modifiés) ──────
  await q.insert('reviews', {
    location_id: locationId,
    rating: 5,
    comment: 'Franchement bien merci à tout l’équipe',
    status: 'public',
    visibility: 'public',
    channel: 'planity',
    public_url: 'https://www.planity.com/zyass-barber-shop-93320-les-pavillons-sous-bois',
    created_ts: new Date('2025-03-27T12:00:00Z').getTime(),
    updated_ts: now,
  });

  // ── cartes cadeaux, campagnes, expérimentations ──────────────────
  await q.insert('gift_cards', { location_id: locationId, code: 'ZY-GIFT-50', amount_cents: 5000, balance_cents: 5000, buyer_name: 'Sophie M.', buyer_email: 'sophie@mail.fr', recipient_name: 'Son frère', message: 'Bonne fête, prends soin de ta barbe.', status: 'active', send_ts: now, created_ts: now - 3 * DAY });
  await q.insert('gift_cards', { location_id: locationId, code: 'ZY-GIFT-25', amount_cents: 2500, balance_cents: 0, buyer_name: 'Karim D.', recipient_name: 'Luca', message: 'Merci pour le coup de main.', status: 'redeemed', redeemed_ts: now - 8 * DAY, created_ts: now - 40 * DAY });
  const campId = await q.insert('campaigns', {
    location_id: locationId,
    name: 'Win-back — absence > 45 j',
    kind: 'winback',
    segment_json: sj([{ field: 'days_since_last', op: '>', value: 45 }]),
    template_key: 'winback',
    channel: 'sms',
    status: 'sent',
    sent_ts: now - 4 * DAY,
    counts_json: sj({ targeted: 18, sent: 16, skippedConsent: 2, booked: 3, revenueCents: 8400 }),
    created_by: adminUserId,
    approved_by: adminUserId,
    created_ts: now - 5 * DAY,
    updated_ts: now - 4 * DAY,
  });
  void campId;
  for (const [key, name, hyp, metric] of [
    ['booking_cta_label', 'Libellé du CTA de réservation', '“Réserver mon créneau” > “Prendre rendez-vous” car plus concret', 'booking_rate'],
    ['deposit_timing', 'Acompte demandé en fin vs début de tunnel', 'Le placer après le choix du créneau réduit l’abandon de 1,5 pt', 'abandon_rate'],
  ] as [string, string, string, string][]) {
    const eid = await q.insert('experiments', { location_id: locationId, key, name, hypothesis: hyp, metric, population_pct: 100, status: 'running', started_ts: now - 18 * DAY, min_sample: 250, created_ts: now - 18 * DAY });
    await q.insert('experiment_variants', { experiment_id: eid, key: 'A', weight: 50, payload_json: sj({ label: 'Prendre rendez-vous' }), is_control: 1 });
    await q.insert('experiment_variants', { experiment_id: eid, key: 'B', weight: 50, payload_json: sj({ label: 'Réserver mon créneau' }), is_control: 0 });
  }

  // ── funnel (événements de session, clairement marqués demo) ──────
  let funnel = 0;
  for (let d = 0; d < 28; d++) {
    const day = dayAdd(dateKey(now), -d);
    const base = startOfDayMs(day);
    const visitors = 60 + Math.floor(rnd(R) * 90);
    for (let v = 0; v < Math.min(visitors, 26); v++) {
      const src = pickSource();
      const uidv = `demo-${d}-${v}`;
      const steps = rnd(R) < 0.34 ? 1 : rnd(R) < 0.6 ? 2 : rnd(R) < 0.82 ? 3 : 5;
      const kinds = ['visit', 'service_view', 'booking_start', 'slot_view', 'booking_confirmed'];
      for (let k = 0; k < steps; k++) {
        await q.insert('funnel_events', {
          location_id: locationId,
          visitor_id: uidv,
          session_id: `s-${uidv}`,
          kind: kinds[k],
          step: k,
          meta_json: sj({ demo: true }),
          source: src.source,
          medium: src.medium,
          campaign: src.campaign,
          device: rnd(R) > 0.22 ? 'mobile' : 'desktop',
          ts: base + (8 * 60 + Math.floor(rnd(R) * 720)) * MIN,
        });
        funnel++;
      }
    }
  }

  // ── parrainage ───────────────────────────────────────────────────
  for (let i = 0; i < 6; i++) {
    const ref = customers[i * 3];
    const ref2 = customers[i * 3 + 1];
    if (!ref || !ref2) break;
    await q.insert('referrals', {
      location_id: locationId,
      referrer_id: ref.id,
      referee_id: ref2.id,
      code: 'PARRAIN-DEMO',
      channel: i % 2 ? 'qr' : 'link',
      status: i < 4 ? 'converted' : 'invited',
      first_book_ts: now - (i + 2) * DAY,
      first_visit_ts: i < 4 ? now - i * DAY : null,
      reward_referrer_cents: 500,
      reward_referee_cents: 500,
      granted_ts: i < 4 ? now - i * DAY : null,
      created_ts: now - (10 + i) * DAY,
    });
  }

  await q.insert('observations', { location_id: locationId, kind: 'info', name: 'seed.demo', ms: Date.now() - now, status: 'ok', meta_json: sj({ customers: custCount, appointments: apptCount, waitlist: wlCount, funnel }), ts: now });

  return { locationId, customers: custCount, appointments: apptCount + customers.length * 4, services: svcRows.length, offerings: offByService.size };
}

function status0(visits: number, cursor: number) {
  return visits ? cursor + 2 * DAY : null;
}

/** Insère un créneau temporairement bloqué (utilisé par la waitlist et les RDV admin). */
export async function holdSlot(locId: number, staffId: number, customerId: number, serviceId: number, offeringId: number, start: number, durationMin: number, status = 'held') {
  return transaction(async (t) => {
    return t.insert('appointments', {
      location_id: locId,
      customer_id: customerId,
      offering_id: offeringId,
      service_id: serviceId,
      staff_id: staffId,
      start_ts: start,
      end_ts: start + durationMin * MIN,
      status,
      price_cents: 0,
      duration_min: durationMin,
      created_ts: Date.now(),
      updated_ts: Date.now(),
    });
  });
}
