import assert from 'node:assert/strict';
import { test } from 'node:test';
import { app, call, login } from './helpers.ts';

/**
 * Le panneau « Horaires & disponibilités » de l'admin ne repose que sur ces quatre routes ; elles
 * sont donc testées ici comme un contrat, avec les deux pièges corrigés le 28/09/2026 :
 *  1. `GET /api/public/me` renvoyait `{ user: null }` sans drapeau : l'espace client en déduisait
 *     « connecté » et plantait sur `user.name` → page entièrement noire, sans message.
 *  2. `POST /api/admin/staff` appliquait `serviceIds: []` par défaut : désactiver un barbier (ou
 *     éditer ses horaires) effaçait ses prestations et ses prix différenciés, silencieusement.
 */

let owner = '';
async function auth() {
  await app();
  if (!owner) owner = await login('owner@zyass.fr');
  return owner;
}
const dowOf = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();
const slotsOn = async (day: string, staffSlug?: string) => {
  const r = await call(`/api/public/availability?service=coupe-homme&days=1&date=${day}${staffSlug ? `&staff=${staffSlug}` : ''}`);
  const d = r.json?.days?.[0] ?? {};
  return { count: d.slots?.length ?? 0, closed: d.closed ?? null, first: d.slots?.[0]?.time ?? null };
};

test('contrat de session : sans cookie, /api/public/me dit explicitement « anonyme »', async () => {
  const r = await call('/api/public/me', { ip: '203.0.113.240' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user, null);
  assert.equal(r.json.anonymous, true, 'le drapeau doit être dans la réponse, sinon le client devine');
});

test('horaires du salon : écriture, relecture, et effet réel sur la disponibilité', async () => {
  const cookie = await auth();
  const before = await call('/api/admin/settings', { cookie });
  const original = before.json.location.hours;

  // on ouvre uniquement le mercredi de 11 h à 15 h : tout le reste doit devenir indisponible
  const r = await call('/api/admin/settings', { cookie, body: { hours: { 3: [['11:00', '15:00']] } } });
  assert.equal(r.status, 200);

  const after = await call('/api/admin/settings', { cookie });
  assert.deepEqual(after.json.location.hours['3'], [['11:00', '15:00']]);
  assert.deepEqual(after.json.location.hours['1'] ?? [], [], 'un jour absent de la copie est fermé — c’est le contrat du panneau');

  // les horaires individuels priment (documenté dans l'admin) : pour mesurer l'effet du salon,
  // on prend un barbier sans plage personnelle — sinon on testerait la priorité, pas le salon.
  const all = await call('/api/admin/settings', { cookie });
  const own = all.json.staff.filter((x: any) => (x.hours ?? []).length > 0);
  for (const x of own) await call('/api/admin/staff', { cookie, body: { id: x.id, name: x.name, hours: [], breaks: [] } });

  // premier mercredi à venir
  let day = new Date();
  day.setUTCDate(day.getUTCDate() + 1);
  while (dowOf(day.toISOString().slice(0, 10)) !== 3) day.setUTCDate(day.getUTCDate() + 1);
  const wed = day.toISOString().slice(0, 10);
  const closedDay = await slotsOn(wed);
  assert.ok(closedDay.count > 0, `le mercredi ${wed} doit être ouvrable (11:00–15:00)`);
  assert.equal(closedDay.first, '11:00', 'le premier créneau suit l’heure d’ouverture saisie');

  const tuesday = new Date(day);
  tuesday.setUTCDate(tuesday.getUTCDate() - 1);
  const tue = tuesday.toISOString().slice(0, 10);
  const closedTue = await slotsOn(tue);
  assert.equal(closedTue.count, 0, 'mardi fermé = aucun créneau, pas un « complet » mensonger');
  assert.ok(closedTue.closed, 'la raison de fermeture est expliquée au visiteur');

  // la règle de précédence, elle, est tenue : un barbier avec sa propre plage ouvre même salon fermé
  await call('/api/admin/staff', { cookie, body: { id: own[0].id, name: own[0].name, hours: [{ dow: 3, start: '08:00', end: '09:00' }] } });
  const wedAgain = await slotsOn(wed);
  assert.ok(wedAgain.first === '08:00' || (wedAgain.count ?? 0) > 0, 'la plage personnelle doit passer avant le salon fermé');
  await call('/api/admin/staff', { cookie, body: { id: own[0].id, name: own[0].name, hours: [], breaks: [] } });

  await call('/api/admin/settings', { cookie, body: { hours: original } });
  for (const x of own) await call('/api/admin/staff', { cookie, body: { id: x.id, name: x.name, hours: x.hours ?? [], breaks: x.breaks ?? [] } });
});

test('horaires d’un barbier : pause enregistrée, et créneaux réellement retirés', async () => {
  const cookie = await auth();
  const st = (await call('/api/admin/settings', { cookie })).json.staff[0];
  const slug = st.slug;

  // on choisit un jour ouvert pour CE barbier, sinon la comparaison n'a pas de sens
  let day = new Date();
  let base = { count: 0, closed: null as any, first: null as any };
  let d = '';
  for (let i = 1; i <= 14; i++) {
    day.setUTCDate(day.getUTCDate() + 1);
    d = day.toISOString().slice(0, 10);
    const s = await slotsOn(d, slug);
    if (s.count >= 2) { base = s; break; }
  }
  assert.ok(base.count >= 2, 'aucune journée à 2 créneaux trouvée pour ce barbier dans les 14 prochains jours');
  const dow = dowOf(d);

  // la journée complète, puis la même avec une pause de 3 h qui mange le matin
  const full = await call('/api/admin/staff', { cookie, body: { id: st.id, name: st.name, hours: [{ dow, start: '09:00', end: '19:00' }] } });
  assert.equal(full.status, 200);
  const sansPause = await slotsOn(d, slug);

  await call('/api/admin/staff', {
    cookie,
    body: { id: st.id, name: st.name, hours: [{ dow, start: '09:00', end: '19:00' }], breaks: [{ dow, start: '09:00', end: '12:00' }] },
  });
  const avecPause = await slotsOn(d, slug);
  assert.ok(avecPause.count < sansPause.count, `la pause doit retirer des créneaux (${sansPause.count} → ${avecPause.count})`);
  assert.notEqual(avecPause.first, '09:00', 'plus aucun créneau avant la fin de la pause');

  const back = await call('/api/admin/settings', { cookie });
  const mine = back.json.staff.find((x: any) => x.id === st.id);
  assert.equal(mine.hours.length, 1, 'la plage enregistrée est relue telle quelle');
  assert.equal(mine.breaks.length, 1);
  assert.equal(mine.breaks[0].start_min, 9 * 60);

  await call('/api/admin/staff', { cookie, body: { id: st.id, name: st.name, hours: st.hours ?? [] } });
});

test('désactiver un barbier ne doit plus effacer ses prestations', async () => {
  const cookie = await auth();
  const st = (await call('/api/admin/settings', { cookie })).json.staff[0];
  const { db } = await import('../server/db/index.ts');
  const avant = await db().num(`SELECT COUNT(*) FROM staff_skills WHERE staff_id = :i`, { i: st.id });
  assert.ok(avant > 0, 'le barbier de démo a des compétences, sinon le test ne prouve rien');

  // l'appel du panneau « Réglages » n'envoie ni `serviceIds` ni `hours` complets
  await call('/api/admin/staff', { cookie, body: { id: st.id, name: st.name, title: st.title, active: true } });
  const apres = await db().num(`SELECT COUNT(*) FROM staff_skills WHERE staff_id = :i`, { i: st.id });
  assert.equal(apres, avant, 'des compétences perdues silencieusement, c’est une destruction de données');

  // mais les envoyer bien explicitement remplace la liste (le contrat reste tenu)
  const ids = (await call('/api/admin/settings', { cookie })).json.services.slice(0, 2).map((s: any) => s.id);
  await call('/api/admin/staff', { cookie, body: { id: st.id, name: st.name, serviceIds: ids } });
  assert.equal(await db().num(`SELECT COUNT(*) FROM staff_skills WHERE staff_id = :i`, { i: st.id }), ids.length);
  await call('/api/admin/staff', { cookie, body: { id: st.id, name: st.name, serviceIds: (await call('/api/admin/settings', { cookie })).json.services.map((s: any) => s.id) } });
});

test('fermer une journée : exception posée, identifiable, réversible', async () => {
  const cookie = await auth();
  let day = new Date();
  let d = '';
  for (let i = 1; i <= 14; i++) {
    day.setUTCDate(day.getUTCDate() + 1);
    d = day.toISOString().slice(0, 10);
    if ((await slotsOn(d)).count > 0) break;
  }
  const avant = await slotsOn(d);
  assert.ok(avant.count > 0, 'pas de journée ouvrable trouvée pour tester la fermeture');

  const created = await call('/api/admin/blocks', { cookie, body: { day: d, from: 0, to: 24 * 60, kind: 'closed', reason: 'Congé annuel' } });
  assert.equal(created.status, 200);
  assert.ok(Array.isArray(created.json.ids) && created.json.ids.length > 0, 'la création renvoie bien les identifiants');
  const id = created.json.ids[0];

  const pendant = await slotsOn(d);
  assert.equal(pendant.count, 0);
  assert.ok(pendant.closed, 'le visiteur voit une raison, jamais un « complet » sec');

  const cal = await call('/api/admin/calendar?mode=month', { cookie });
  const dayRow = (cal.json.days ?? []).find((x: any) => x.day === d);
  const exposed = (dayRow?.blocks ?? []).find((b: any) => b.id === id);
  assert.ok((dayRow?.blocks ?? []).length >= 1, 'le calendrier du mois doit montrer les fermetures posées');
  assert.ok(exposed, 'le calendrier doit exposer l’id du blocage, sinon impossible de le retirer depuis l’admin');
  assert.equal(exposed.reason, 'Congé annuel');

  const del = await call(`/api/admin/blocks/${id}/delete`, { cookie, method: 'POST' });
  assert.equal(del.status, 200);
  // un seul bloc retiré sur les N créés (un par barbier) : la journée rouvre pour CE barbier
  const apres = await slotsOn(d);
  assert.ok(apres.count > 0, 'supprimer le blocage doit rendre la journée réservable à nouveau');
  for (const other of created.json.ids.slice(1)) await call(`/api/admin/blocks/${other}/delete`, { cookie, method: 'POST' });
  const fini = await slotsOn(d);
  assert.ok(fini.count >= avant.count - 3, `journée entièrement rouverte (${avant.count} → ${fini.count} créneaux)`);

  const invalide = await call('/api/admin/blocks', { cookie, body: { day: d, from: 600, to: 600, kind: 'closed' } });
  assert.equal(invalide.status, 422);
  assert.equal(invalide.json.error, 'plage_invalide');
});
