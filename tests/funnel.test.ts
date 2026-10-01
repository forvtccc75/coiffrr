/**
 * Le vocabulaire du tunnel d'acquisition, tenu par un test.
 *
 * Le piège, réel dans ce dépôt : le client envoyait `booking_done`, le serveur ne connaissait que
 * `booking_confirmed`, et `sendBeacon` ne lit jamais la réponse — donc 422 ignoré, entonnoir à zéro
 * conversion sur un site qui encaisse des réservations. Trois invariants, aucun ne tient d'un
 * commentaire : le client ne peut taper qu'un kind connu, l'analyse ne demande que des kinds connus,
 * et l'endpoint les accepte vraiment (en continuant de refuser le reste).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FUNNEL_KINDS, FUNNEL_STEPS, isFunnelKind } from '../shared/funnel.ts';
import { app, call } from './helpers.ts';

const root = resolve(import.meta.dirname, '..');
function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('tout track() du client est un kind connu du serveur', () => {
  const seen: [string, string][] = [];
  for (const f of files('client/src')) {
    const src = readFileSync(join(root, f), 'utf8');
    for (const m of src.matchAll(/track\(\s*'([a-z_]+)'/g)) seen.push([m[1], f]);
  }
  assert.ok(seen.length >= 8, `seulement ${seen.length} appels track() trouvés : la sonde ne lit plus le bon motif`);
  const inconnus = seen.filter(([k]) => !isFunnelKind(k));
  assert.deepEqual(inconnus, [], `kind hors vocabulaire (donc jetés en 422) : ${inconnus.map(([k, f]) => `${k} in ${f}`).join(', ')}`);
});

test('l’analyse ne compte que des kinds connus et suit les étapes partagées', () => {
  const src = readFileSync(join(root, 'server/domain/analytics.ts'), 'utf8');
  const used = [...src.matchAll(/\bev\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(used.length >= 3, 'aucune lecture ev(...) repérée dans analytics.ts');
  for (const k of used) assert.ok(FUNNEL_KINDS.includes(k as any), `analytics demande « ${k} », que le serveur refuserait d'écrire`);
  for (const s of FUNNEL_STEPS) assert.ok(FUNNEL_KINDS.includes(s as any), `étape ${s} absente du vocabulaire validé`);
  assert.match(src, /FUNNEL_STEPS/, 'analytics.ts ne consomme plus la liste partagée (risque de dérive)');
});

test('le client doit rester typé par le vocabulaire (pas de track(kind: string))', () => {
  const api = readFileSync(join(root, 'client/src/lib/api.ts'), 'utf8');
  assert.match(api, /export function track\(\s*kind:\s*FunnelKind/, "track() accepte n\u2019importe quelle chaîne : la dérive redevient silencieuse");
});

test('l’endpoint accepte chaque kind et rejette ce qui n’en est pas un', async () => {
  await app();
  for (const kind of FUNNEL_KINDS) {
    const res = await call('/api/public/track', { body: { visitorId: 'v-test-' + kind, kind, path: '/book', meta: {}, attribution: {} } });
    assert.equal(res.status, 202, `${kind} → ${res.status} ${res.text.slice(0, 120)}`);
  }
  const junk = await call('/api/public/track', { body: { visitorId: 'v-test-junk', kind: 'vol_de_donnees', path: '/x' } });
  assert.equal(junk.status, 422, 'un kind inventé doit être refusé, pas stocké');
});

test('un visiteur qui réserve remonte bien jusqu’à la dernière étape de l’entonnoir', async () => {
  await app();
  const vid = 'v-funnel-' + Date.now().toString(36);
  for (const step of FUNNEL_STEPS) {
    const res = await call('/api/public/track', { body: { visitorId: vid, kind: step, path: '/book', meta: {}, attribution: { source: 'instagram' } } });
    assert.equal(res.status, 202, `${step}: ${res.status}`);
  }
  const { loadCtx } = await import('../server/domain/context.ts');
  const { funnel } = await import('../server/domain/analytics.ts');
  const ctx = await loadCtx('zyass');
  const f = await funnel(ctx, new Date().toISOString().slice(0, 10), new Date().toISOString().slice(0, 10));
  const last = f.steps[f.steps.length - 1];
  assert.equal(last.key, 'booking_confirmed', "l'entonnoir doit finir sur la réservation confirmée");
  assert.ok(last.users >= 1, `étape finale à ${last.users} alors qu'un visiteur complet vient d'être tracé (le trou historique) :\n${JSON.stringify(f.steps)}`);
});

test("l'upsert de conversion d'une expérience tient sur les deux moteurs (et n'avale pas son erreur)", async () => {
  const { db } = await import('../server/db/index.ts');
  const d = await db();
  const key = `exp-test-${Date.now()}`;
  const eid = await d.insert('experiments', {
    key,
    name: 'Test conversion',
    location_id: 1,
    status: 'running',
    hypothesis: 'Afficher le prochain créneau libre augmente la conversion.',
    started_ts: Date.now() - 1000,
    created_ts: Date.now(),
  });
  for (const v of ['A', 'B']) {
    await d.insert('experiment_variants', { experiment_id: eid, key: v, payload_json: JSON.stringify({ label: v }) });
  }
  const { trackExperiment, listExperiments } = await import('../server/domain/marketing.ts');
  const { loadCtx } = await import('../server/domain/context.ts');
  const ctx = await loadCtx('zyass');
  // Deux visiteurs, dont un qui convertit au deuxième passage : l'upsert doit passer converted de 0 à 1
  // SANS repasser par 0, et additionner le CA. En Postgres, la version `MAX(converted, :c)` levait et
  // le catch silencieux faisait croire à une expérience à 0 %.
  await trackExperiment(ctx, key, 'A', 'visitor-one', false, 0);
  await trackExperiment(ctx, key, 'A', 'visitor-one', true, 3000);
  await trackExperiment(ctx, key, 'B', 'visitor-two', false, 0);
  await d.exec(`DELETE FROM rate_buckets`);
  const rows = await d.all<any>(`SELECT variant_key AS v, converted AS c, revenue_cents AS r FROM experiment_assignments WHERE experiment_key = :k ORDER BY variant_key`, { k: key });
  assert.equal(rows.length, 2, `deux lignes attendues, reçu ${JSON.stringify(rows)}`);
  const a = rows.find((x) => x.v === 'A')!;
  assert.equal(Number(a.c), 1, 'la conversion du second passage a été écrasée par le premier');
  assert.equal(Number(a.r), 3000, 'le chiffre d’affaires cumulé est faux');
  const rep = (await listExperiments(ctx)).find((x: any) => x.key === key);
  assert.ok(rep, 'le rapport d’expérience ne voit pas les données');
  const statA = rep!.variants?.find((x: any) => x.variant === 'A') ?? rep!.stats?.find((x: any) => x.variant === 'A');
  assert.ok(statA, `le rapport ne détaille pas le variant A : ${JSON.stringify(rep).slice(0, 200)}`);
  assert.equal(Number(statA.converted), 1, 'le rapport annonce 0 conversion alors qu’il y en a une');
});
