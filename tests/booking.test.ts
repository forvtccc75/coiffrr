import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { app, call, login, openDay } from './helpers.ts';

const phoneFor = (n: number) => `06${String(12345000 + n).padStart(8, '0')}`;
/* Ce fichier enchaîne volontairement les réservations : on vide le seau de rate-limit
   entre chaque test (le plafonnement lui-même est vérifié par son propre test). */
beforeEach(async () => {
  await app();
  const { db } = await import('../server/db/index.ts');
  await db().exec(`DELETE FROM rate_buckets`);
});
let booked: { token: string; id: number; start: number; day: string; phone: string } | null = null;

test('réservation : le parcours complet aboutit en une requête, sans acompte sur une coupe', async () => {
  const { day, ts } = await openDay();
  const res = await call('/api/public/booking', {
    body: {
      offeringId: 1,
      start: ts,
      visitorId: 'test-v1',
      customer: { firstName: 'Karim', lastName: 'Benali', phone: phoneFor(1), email: 'karim.benali@mail.fr', note: 'Dégradé bas, barbe nette SVP' },
      consent: { terms: true, marketingSms: false, marketingEmail: true },
      attribution: { source: 'instagram', campaign: 'story-juin' },
    },
  });
  assert.equal(res.status, 201, res.text.slice(0, 200));
  assert.equal(res.json.status, 'booked');
  assert.equal(res.json.start, ts);
  assert.equal(res.json.day ?? day, day);
  assert.ok(res.json.end > res.json.start);
  assert.ok(res.json.priceCents > 0);
  assert.equal(res.json.depositCents, 0, 'pas d’acompte sur une coupe simple');
  assert.ok(res.json.manageToken && res.json.manageUrl, 'le lien de gestion est présent');
  assert.ok(res.json.icsUrl.includes('/actions/ics?token='), 'lien .ics signé présent');
  assert.equal(res.json.isNewCustomer, true);
  assert.ok(res.json.staffName, 'le client sait chez qui il va');
  booked = { token: res.json.manageToken, id: res.json.id, start: ts, day, phone: phoneFor(1) };
});

test('ZERO DOUBLE BOOKING : même barbier, même créneau = refus, avec des alternatives réelles', async () => {
  assert.ok(booked);
  const who = await call(`/api/public/appointment?token=${booked!.token}`);
  const staffId = who.json.appointment.staffId ?? 2;
  const second = await call('/api/public/booking', {
    body: { offeringId: 1, start: booked!.start, staffId, customer: { firstName: 'Samy', phone: phoneFor(2) } },
  });
  assert.equal(second.status, 409, `créneau déjà tenu chez le même barbier : ${second.status} ${second.text.slice(0, 140)}`);
  assert.equal(second.json.error, 'creneau_pris');
  const spare = await call('/api/public/booking', {
    body: { offeringId: 1, start: booked!.start, customer: { firstName: 'Samy', phone: phoneFor(2) } },
  });
  if (spare.status === 201) assert.notEqual(spare.json.staffId, staffId, 'si un autre prend le créneau, ce n’est pas le même barbier');
  else assert.ok([409, 429].includes(spare.status));
  assert.ok(Array.isArray(second.json.data?.alternatives ?? second.json.alternatives), 'le refus embarque des alternatives');
  const alts = second.json.data?.alternatives ?? second.json.alternatives ?? [];
  for (const a of alts) assert.ok(a.ts > Date.now() && a.time, 'une alternative est un vrai créneau futur');
});

test('cohérence : la fiche client est reconnue quel que soit le format du numéro', async () => {
  assert.ok(booked);
  const { json } = await call('/api/public/config');
  void json;
  const res = await call('/api/public/booking', {
    body: { offeringId: 1, start: (await openDay(3)).ts, customer: { firstName: 'Karim', phone: `+33 6 ${booked!.phone.slice(2, 4)} ${booked!.phone.slice(4, 6)} ${booked!.phone.slice(6, 8)} ${booked!.phone.slice(8, 10)}` } },
  });
  assert.equal(res.status, 201, res.text.slice(0, 160));
  assert.equal(res.json.isNewCustomer, false, 'le même numéro au format international = le même client, pas un doublon de fiche');
});

test('saisie contrôlée : téléphone, nom et créneau invalides sont rejetés avant d’écrire', async () => {
  const { ts } = await openDay(2);
  const badPhone = await call('/api/public/booking', { body: { offeringId: 1, start: ts, customer: { firstName: 'X', phone: '0644' } } });
  assert.equal(badPhone.status, 422, `un numéro trop court doit être refusé en 422, pas en 500 (${badPhone.status})`);
  assert.equal(badPhone.json.error, 'champs_invalides');
  assert.match(badPhone.json.message, /téléphone|prénom/, 'et le message doit nommer le champ, en français');
  const shortName = await call('/api/public/booking', { body: { offeringId: 1, start: ts, customer: { firstName: 'A', phone: phoneFor(9) } } });
  assert.equal(shortName.status, 422);
  assert.doesNotMatch(JSON.stringify(shortName.json), /zod|too_small|minimum/i, 'aucun détail interne ne fuit vers le client');
  const past = await call('/api/public/booking', { body: { offeringId: 1, start: Date.now() + 60_000, customer: { firstName: 'Hugo', phone: phoneFor(10) } } });
  assert.ok(['slot_trop_proche', 'slot_non_aligne', 'creneau_pris'].includes(past.json?.error), past.text.slice(0, 160));
  const noService = await call('/api/public/booking', { body: { offeringId: 999999, start: ts, customer: { firstName: 'Hugo', phone: phoneFor(11) } } });
  assert.ok(noService.status >= 400, 'une prestation inexistante ne se réserve pas');
});

test('anti-abus : un même client ne peut pas accumuler les réservations actives', async () => {
  assert.ok(booked);
  const p = booked!.phone;
  const results = [];
  for (let i = 0; i < 6; i++) {
    const { ts } = await openDay(4 + i);
    results.push(await call('/api/public/booking', { body: { offeringId: 1, start: ts, customer: { firstName: 'Karim', phone: p } } }));
  }
  const okCount = results.filter((r) => r.status === 201).length;
  const blocked = results.filter((r) => r.json?.error === 'trop_de_rdv' || r.json?.error === 'doublon');
  assert.ok(blocked.length >= 1, `plafond de réservations actives non appliqué (${okCount} passées)`);
});

test('lien de gestion : le titulaire peut décaler, puis annuler — et l’annulation est idempotente', async () => {
  assert.ok(booked);
  const view = await call(`/api/public/appointment?token=${booked!.token}`);
  assert.equal(view.status, 200);
  assert.ok(view.json.appointment.manageToken ?? view.json.token);
  const staffId = view.json.appointment.staffId ?? view.json.appointment.staff_id;
  assert.ok(staffId);
  const available = await call('/api/public/availability?service=coupe-homme&staff=' + staffId + '&days=14');
  const target = available.json.days.flatMap((d: any) => d.slots ?? []).find((slot: any) => slot.staffIds.includes(staffId));
  assert.ok(target, 'créneau du barbier initial');
  const next = { ts: target.ts };
  const move = await call('/api/public/appointment/reschedule', { body: { token: booked!.token, start: next.ts } });
  assert.equal(move.status, 200, move.text.slice(0, 200));
  const cancel = await call('/api/public/appointment/cancel', { body: { token: booked!.token } });
  assert.equal(cancel.status, 200, cancel.text.slice(0, 200));
  assert.equal(cancel.json.ok, true);
  const again = await call('/api/public/appointment/cancel', { body: { token: booked!.token } });
  assert.equal(again.json.already, true, 'annuler deux fois ne crée pas deux mouvements');
  const forged = await call('/api/public/appointment?token=' + booked!.token.slice(0, -2) + 'zz');
  assert.equal(forged.status, 403);
  assert.equal(forged.json.error, 'lien_invalide');
});

test('créneau libéré : il redevient réservable immédiatement (récupération des annulations)', async () => {
  assert.ok(booked);
  const av = await call(`/api/public/availability?service=coupe-homme&days=1&date=${booked!.day}`);
  assert.ok((av.json.days[0].slots ?? []).length > 0, `${booked!.day} : plus aucun créneau affiché après annulation`);
  const other = await call('/api/public/booking', { body: { offeringId: 1, start: booked!.start, customer: { firstName: 'Nabil', phone: phoneFor(21) } } });
  if (other.status === 409) {
    // le créneau est en cours de proposition à la waitlist : voulu, mais il doit expirer vite
    // et porter une vraie offre en attente — sinon le créneau libéré est perdu.
    const { db } = await import('../server/db/index.ts');
    const pending = await db().one<any>(`SELECT * FROM waitlist_offers WHERE start_ts = :t AND status = 'pending' ORDER BY id DESC LIMIT 1`, { t: booked!.start });
    assert.ok(pending, `409 sans offre waitlist en attente sur ${booked!.start} : créneau disparu`);
    assert.ok(Number(pending.expires_ts) - Date.now() <= 20 * 60_000, 'une offre doit expirer vite, le créneau ne reste pas gelé');
    assert.ok(String(pending.token).length > 20, 'l’offre porte un jeton de réclamation');
  } else {
    assert.equal(other.status, 201, other.text.slice(0, 160));
    await call('/api/public/appointment/cancel', { body: { token: other.json.manageToken } });
  }
});

test('SMS d’offre waitlist : le lien de réclamation est réel et signé', async () => {
  const { db } = await import('../server/db/index.ts');
  const row = await db().one<any>(
    `SELECT n.body_text AS b, o.token AS t FROM notifications n JOIN waitlist_offers o ON o.id = n.waitlist_offer_id WHERE n.kind = 'waitlist_offer' AND n.channel = 'sms' ORDER BY n.id DESC LIMIT 1`,
  );
  assert.ok(row, 'aucun SMS de waitlist dans cette base de test');
  assert.match(row.b, /\/waitlist\/reserver\?token=/, `le SMS doit porter le lien de réclamation : ${String(row.b).slice(0, 180)}`);
  assert.match(row.b, /\/waitlist\/refuser\?token=/, 'et le lien de refus, pour que le désengagement marche aussi');
  assert.ok(String(row.b).includes(String(row.t).slice(0, 12)), 'le jeton du message est bien celui de l’offre');
});

test('anti-abus : le rate limit de réservation protège le serveur des scripts de bourrage', async () => {
  const ip = '198.51.100.77';
  let blocked = 0;
  for (let i = 0; i < 16; i++) {
    const { ts } = await openDay(8 + (i % 5));
    const r = await call('/api/public/booking', { ip, body: { offeringId: 1, start: ts, customer: { firstName: 'Bot', phone: phoneFor(40 + i) } } });
    if (r.status === 429) blocked++;
  }
  assert.ok(blocked >= 1, '16 tentatives en quelques secondes doivent être plafonnées');
  const last = await call('/api/public/booking', { ip, body: { offeringId: 1, start: (await openDay(9)).ts, customer: { firstName: 'Bot', phone: phoneFor(60) } } });
  assert.equal(last.json?.error ?? 'too_many_requests', 'too_many_requests', 'le blocage persiste le temps de la fenêtre');
});

test('un RDV marqué « terminé » dont la fenêtre court encore ne rend pas le fauteuil réservable', async () => {
  const { day, ts, days } = await openDay();
  const slot = (days[0].slots ?? []).find((s: any) => s.ts === ts) ?? days[0].slots[0];
  const staff = slot?.staffIds?.[0] ?? 1;
  const b = await call('/api/public/booking', {
    body: { offeringId: 1, start: ts, staffId: staff, customer: { firstName: 'TropTôt', phone: '0678112233' }, consent: { terms: true } },
  });
  assert.equal(b.status, 201, `réservation → ${b.status} ${b.text.slice(0, 160)}`);
  const cookie = await login('owner@zyass.fr');
  const done = await call(`/api/admin/appointments/${b.json.id}/complete`, { method: 'POST', body: {}, cookie });
  assert.ok([200, 201].includes(done.status), `compléter → ${done.status} ${done.text.slice(0, 160)}`);

  // Vue publique : le fauteuil reste occupé jusqu'à la fin de la fenêtre (préparation + nettoyage comprises).
  const av = await call(`/api/public/availability?service=coupe-homme&days=1&date=${day}`);
  const encrore = (av.json.days?.[0]?.slots ?? []).some((s: any) => s.ts === ts && (s.staffIds ?? []).includes(staff));
  assert.ok(!encrore, "le créneau a été proposé alors que le RDV terminé n'était pas écoulé");

  // Et le moteur refuse la réservation par-dessus, au lieu d'aligner deux fiches sur le même créneau.
  const again = await call('/api/public/booking', {
    body: { offeringId: 1, start: ts, staffId: staff, customer: { firstName: 'Dessus', phone: '0678112244' }, consent: { terms: true } },
  });
  assert.equal(again.status, 409, `chevauchement accepté (${again.status}) — deux RDV au même moment chez le même barbier`);
  assert.ok((again.json?.data?.alternatives ?? []).length > 0, 'un refus sans proposition de repli');

  const cal = await call(`/api/admin/calendar?mode=day&from=${day}`, { cookie });
  assert.equal(cal.status, 200, `calendrier → ${cal.status} ${cal.text.slice(0, 120)}`);
  const surCeCreneau = (cal.json.days ?? [])
    .flatMap((d: any) => (d.perStaff ?? []).filter((ps: any) => (ps.staff?.id ?? ps.staff) === staff).flatMap((ps: any) => ps.appointments ?? []))
    .filter((a: any) => a.start === ts && !['cancelled', 'no_show'].includes(a.status));
  // Les fiches annulées restent visibles dans l'agenda (historique) mais ne comptent pas : on vérifie
  // qu'il n'y a qu'UNE occupation réelle sur ce créneau — la notre, terminée.
  assert.equal(
    surCeCreneau.length,
    1,
    `l'agenda affiche ${surCeCreneau.length} fiches sur le même créneau: ${surCeCreneau.map((a: any) => `#${a.id} ${a.status} staff=${a.staffId}`).join(', ')}`,
  );
});
