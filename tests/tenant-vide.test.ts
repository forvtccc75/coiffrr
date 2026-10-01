import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { app, call } from './helpers.ts';

/**
 * Un salon fraîchement créé n'a ni prestation, ni barbier, ni créneau. Mesuré en conditions
 * réelles (campagne de vérification du 21/09) : `/api/public/config` plantait sur `services[0].id`
 * et renvoyait un 500 — donc tout le site tombait pour un tenant vide, y compris la page qui
 * explique au client que l'ouverture arrive. Ces tests verrouillent l'état « en cours d'ouverture »
 * côté public, côté file d'attente (zéro demande perdue : on peut encore laisser son numéro) et
 * côté back-office (l'owner doit voir son assistant d'onboarding, pas une page blanche).
 */
const dbq = async () => (await import('../server/db/index.ts')).db();

async function newEmptySalon(tag: string) {
  const d = await dbq();
  const now = Date.now();
  const slug = `vide-${tag}-${now}`;
  const tenant = await d.one<any>(`SELECT id FROM tenants ORDER BY id LIMIT 1`);
  const locId = await d.insert('locations', {
    tenant_id: tenant?.id ?? 1,
    slug,
    name: `Salon vide ${tag}`,
    created_ts: now,
    updated_ts: now,
  });
  const { invalidateCtx } = await import('../server/domain/context.ts');
  invalidateCtx();
  return { slug, locId };
}

beforeEach(async () => {
  await app();
  const d = await dbq();
  await d.exec(`DELETE FROM rate_buckets`);
});

test('salon sans prestation : le site public répond 200 et explique l’ouverture', async () => {
  const { slug } = await newEmptySalon('site');
  const cfg = await call(`/api/public/config?loc=${slug}`);
  assert.equal(cfg.status, 200, `config → ${cfg.status} ${cfg.text.slice(0, 160)}`);
  assert.equal(cfg.json.onboarding, true, 'le mode ouverture doit être signalé au client');
  assert.deepEqual(cfg.json.services, [], 'un salon vide ne doit inventer aucune prestation');
  assert.equal(cfg.json.live.nextSlot, null, 'aucun créneau ne doit être promis');
  // Et le salon de référence reste intact : la bascule ne doit rien casser pour les autres.
  const ref = await call('/api/public/config?loc=zyass');
  assert.equal(ref.status, 200);
  assert.ok(ref.json.services.length > 0, 'le salon principal a perdu ses prestations');
  assert.notEqual(ref.json.onboarding, true, 'le salon principal est passé à tort en mode ouverture');
});

test('créneaux d’un salon vide : agenda vide honnête, jamais un « complet » mensonger', async () => {
  const { slug } = await newEmptySalon('slots');
  const av = await call(`/api/public/availability?loc=${slug}&service=coupe-homme&days=7`);
  assert.equal(av.status, 200, `availability → ${av.status} ${av.text.slice(0, 140)}`);
  assert.deepEqual(av.json.days, [], 'un salon vide ne doit publier aucun créneau');
  assert.equal(av.json.closed, true, 'la journée doit être annoncée fermée (pas « complet »)');
  assert.equal(av.json.waitlistOpen, true, 'la file d’attente doit rester la porte de sortie');
  assert.ok(/ouverture/.test(String(av.json.note ?? '')), 'le visiteur doit recevoir une explication lisible');
  const next = await call(`/api/public/next?loc=${slug}`);
  assert.equal(next.status, 200);
  assert.equal(next.json.slot, null, 'aucun « prochain créneau » ne doit être inventé');
  const walk = await call(`/api/public/walkin?loc=${slug}`);
  assert.equal(walk.status, 200, `walkin → ${walk.status}`);
  assert.equal(walk.json.enabled, false, 'les sans-rendez-vous sont désactivés tant qu’il n’y a pas d’agenda');
});

test('zéro demande perdue avant même l’ouverture : la waitlist enregistre', async () => {
  const { slug } = await newEmptySalon('waitlist');
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(Date.now() + 86400000));
  const w = await call(`/api/public/waitlist?loc=${slug}`, {
    body: {
      name: 'Attendu',
      phone: `06${String(74100000 + (Date.now() % 1000)).padStart(8, '0')}`,
      days: [day],
      consent: true,
    },
  });
  assert.equal(w.status, 201, `waitlist → ${w.status} ${w.text.slice(0, 200)}`);
  assert.ok(w.json.token, 'la demande doit être gérée par un lien signé');
  const d = await dbq();
  const row = await d.one<any>(`SELECT * FROM waitlist WHERE id = :i`, { i: w.json.id });
  assert.ok(row, 'la demande n’est pas en base');
  assert.equal(row.service_id, null, 'aucune prestation ne doit être supposée pour ce client');
});

test('un sous-domaine choisit son salon : le Host résout le tenant public', async () => {
  const { slug } = await newEmptySalon('hote');
  const r = await call('/api/public/config', { headers: { host: `${slug}.zyass.fun`, 'x-forwarded-host': `${slug}.zyass.fun` } });
  assert.equal(r.status, 200, `config par sous-domaine → ${r.status} ${r.text.slice(0, 140)}`);
  assert.equal(r.json.salon?.slug, slug, 'le Host n’a pas sélectionné le salon attendu');
  const nu = await call('/api/public/config', { headers: { host: 'inconnu.zyass.fun', 'x-forwarded-host': 'inconnu.zyass.fun' } });
  assert.equal(nu.status, 200, 'un sous-domaine inconnu ne doit pas renvoyer 500');
  assert.equal(nu.json.salon?.slug, 'zyass', 'à sous-domaine inconnu, salon par défaut (et une erreur muette)');
});

test('back-office d’un salon vide : l’assistant d’onboarding s’affiche au lieu de planter', async () => {
  const { slug, locId } = await newEmptySalon('admin');
  const d = await dbq();
  const email = `owner-${slug}@example.fr`;
  const userId = await d.insert('users', {
    location_id: locId,
    email,
    name: 'Owner vide',
    role_key: 'owner',
    password_hash: 'x',
    created_ts: Date.now(),
  });
  const { setPasswordForUser } = await import('../server/lib/security.ts');
  await setPasswordForUser(userId, 'motdepasse-de-test');
  const cookie = await call('/api/public/auth/password', { body: { email, password: 'motdepasse-de-test' } }).then((r) => {
    assert.equal(r.status, 200, `login → ${r.status} ${r.text.slice(0, 140)}`);
    return r.cookie;
  });
  // Le back-office travaille sur le salon du compte, sans avoir à porter `?loc=` : c'est ce que
  // suppose un déploiement par salon (ou un sous-domaine). Le 403 « hors périmètre » reste vérifié
  // plus bas, lui, avec un loc explicite.
  for (const path of ['/api/admin/today', `/api/admin/calendar?mode=month`, '/api/admin/automations', '/api/admin/onboarding']) {
    const r = await call(path, { cookie });
    assert.equal(r.status, 200, `${path} → ${r.status} ${r.text.slice(0, 160)}`);
  }
  const onb = await call('/api/admin/onboarding', { cookie });
  assert.equal(onb.json.steps.find((x: any) => x.key === 'booking').ok, false, 'l’assistant ne doit pas valider une étape impossible');
  // Un salon vide ne peut pas promettre de créneau : l'offre waitlist doit refuser proprement.
  const rej = await call('/api/admin/waitlist/1/offer', { cookie, body: { start: Date.now() + 3600000, staffId: 1 } });
  const hors = await call('/api/admin/today?loc=zyass', { cookie });
  assert.equal(hors.status, 403, 'un owner d’un autre salon a pu lire le salon de référence');
  assert.ok([403, 404, 409].includes(rej.status), `offre sur salon vide → ${rej.status} ${rej.text.slice(0, 120)}`);
});
