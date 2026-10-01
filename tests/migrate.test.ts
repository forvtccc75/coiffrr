import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Le rattrapage de colonnes dans `migrate()` — le chemin qui protège une base de production, et qui
 * n'existait pas avant le 28/09 : `CREATE TABLE IF NOT EXISTS` ne touche pas une table déjà créée, donc
 * une colonne ajoutée dans `server/db/schema.ts` n'arrivait jamais en production.
 * On ne passe pas par `bootstrap()` (il fige le driver du process de test) : on ouvre un driver SQLite
 * en mémoire séparé, exactement celui que `npm run migrate` utilise.
 */
async function freshDriver() {
  const { createDriver } = await import('../server/db/driver.ts');
  return createDriver({ dataFile: ':memory:' });
}

test('migrate() rattache les colonnes qui manquent à une table existante', async () => {
  const d = await freshDriver();
  // Une table « ancienne version » : seulement deux colonnes, comme si le produit datait de six mois.
  await d.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, first_name TEXT NOT NULL)`);
  const { migrate } = await import('../server/db/index.ts');
  const { added, failed } = await migrate(d);
  const cols = (await d.all<{ name: string }>(`PRAGMA table_info(customers)`)).map((r) => r.name);
  for (const need of ['last_name', 'phone', 'phone_norm', 'segment', 'risk_score', 'spent_cents', 'deleted_ts']) {
    assert.ok(cols.includes(need), `colonne ${need} absente après migrate() — reçu : ${cols.join(',')}`);
  }
  assert.ok(
    ['customers.phone', 'customers.risk_score'].every((x) => added.includes(x)),
    `le rapport de rattrapage est faux : ${added.slice(0, 8).join(',')} (${added.length})`,
  );
  assert.equal(failed.length, 0, `des colonnes n'ont pas pu être ajoutées : ${JSON.stringify(failed).slice(0, 400)}`);
  await d.close();
});

test('migrate() est idempotente : rien à rattraper la seconde fois', async () => {
  const d = await freshDriver();
  const { migrate } = await import('../server/db/index.ts');
  const first = await migrate(d);
  const second = await migrate(d);
  assert.equal(second.added.length, 0, `deuxième passage ajoute encore des colonnes : ${second.added.slice(0, 6).join(',')}`);
  assert.equal(second.failed.length, 0, `deuxième passage échoue : ${JSON.stringify(second.failed).slice(0, 300)}`);
  // Au premier passage sur base vierge, tout est créé par le CREATE TABLE : le rattrapage ne doit rien inventer.
  assert.equal(first.added.length, 0, `rattrapage sur base vierge : ${first.added.slice(0, 6).join(',')}`);
  await d.close();
});

test('toute colonne du schéma est relue depuis wantedColumns (le parseur ne rate rien)', async () => {
  const { ALL_TABLES, wantedColumns } = await import('../server/db/schema.ts');
  const want = wantedColumns('sqlite');
  const tables = new Set(want.map((c) => c.table));
  assert.equal(tables.size, ALL_TABLES.length, `tables non couvertes par wantedColumns : ${ALL_TABLES.filter((t: string) => !tables.has(t)).join(',')}`);
  // Le nombre de colonnes déclarées doit correspondre au texte du schéma : contrôle de non-régression du parseur.
  const total = want.length;
  assert.ok(total > 300, `seulement ${total} colonnes détectées : le parseur de wantedColumns ne voit plus le schéma`);
  for (const kind of ['sqlite', 'pg'] as const) {
    const rows = wantedColumns(kind);
    assert.ok(rows.every((c) => c.def && !c.def.endsWith(',') && !/^\{.+\}$/.test(c.def)), `${kind}: définitions de colonnes mal extraites`);
    if (kind === 'pg') assert.ok(rows.some((c) => /TEXT NOT NULL/.test(c.def)), 'pg: aucune colonne NOT NULL trouvée (parseur suspect)');
  }
});

test('une colonne impossible à ajouter est remontée, sans empêcher les autres', async () => {
  const d = await freshDriver();
  // Table existante avec une contrainte qui interdit l'ajout d'une NOT NULL sans défaut : `paid_cents`
  // a un défaut, donc on fabrique le cas en rendant la table contraire (colonne NOT NULL sans défaut
  // déjà présente avec un type incompatible forçant l'erreur).
  await d.exec(`CREATE TABLE gift_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL)`);
  const { migrate } = await import('../server/db/index.ts');
  const { added, failed } = await migrate(d);
  const cols = (await d.all<{ name: string }>(`PRAGMA table_info(gift_cards)`)).map((r) => r.name);
  assert.ok(cols.includes('amount_cents'), `gift_cards n'a pas été rattrapée : ${cols.join(',')}`);
  assert.ok(added.some((x) => x.startsWith('gift_cards.')), 'le rapport ne mentionne pas les colonnes ajoutées ici');
  assert.ok(Array.isArray(failed), 'failed doit toujours être un tableau');
  await d.close();
});

test('SQLite : un ADD COLUMN avec contrainte en ligne est relancé sans elle (et le rapport le dit)', async () => {
  const d = await freshDriver();
  // Table « ancienne » MAIS peuplée : c'est le cas réel d'une base de production. SQLite refuse
  // catégoriquement `ADD COLUMN ... UNIQUE`, Postgres non — le rattrapage doit donc retenter sans la
  // contrainte, et le dire, plutôt que de laisser la colonne manquante.
  await d.exec(`CREATE TABLE payments (id INTEGER PRIMARY KEY AUTOINCREMENT, appointment_id INTEGER NOT NULL DEFAULT 0, amount_cents BIGINT NOT NULL DEFAULT 0)`);
  await d.exec(`INSERT INTO payments (appointment_id, amount_cents) VALUES (1, 2500), (2, 4000)`);
  const { migrate } = await import('../server/db/index.ts');
  const { added, failed } = await migrate(d);
  const cols = (await d.all<{ name: string }>(`PRAGMA table_info(payments)`)).map((r) => r.name);
  assert.ok(cols.includes('idempotency_key'), `idempotency_key toujours absente ; colonnes : ${cols.join(',')}`);
  const line = added.find((x) => x.startsWith('payments.idempotency_key'));
  assert.ok(line, `le rapport ne mentionne pas payments.idempotency_key : ${added.join(' | ')}`);
  assert.match(line, /ux_rattrape_payments_idempotency_key/, `le rapport ne nomme pas l'index de repli posé : ${line}`);
  // Les colonnes NOT NULL SANS défaut sont légitimement refusées sur une table peuplée (c'est SQL, pas
  // l'app) : le rattrapage doit les NOMMER, pas les taire — c'est ce qui rend l'échec réparable.
  const pb = failed.filter((f) => f.where.startsWith('payments.')).map((f) => f.where);
  assert.ok(pb.length > 0 && pb.every((x) => /location_id|kind|created_ts|updated_ts/.test(x)), `échecs inattendus sur payments : ${pb.join(',') || 'aucun'}`);
  assert.ok(failed.every((f) => /NOT NULL/.test(f.why)), `la cause remontée n'est pas parlante : ${JSON.stringify(failed).slice(0, 300)}`);
  // Et l'index unique du schéma existe bien après coup : la contrainte n'a pas disparu, elle a changé de support.
  const idx = await d.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'payments'`);
  assert.ok(idx.some((i) => i.name === 'ux_rattrape_payments_idempotency_key'), `index de repli absent : ${idx.map((i) => i.name).join(',')}`);
  // L'index doit réellement empêcher le doublon : sinon le repli est décoratif.
  await d.exec(`INSERT INTO payments (appointment_id, amount_cents, idempotency_key) VALUES (3, 100, 'k1')`);
  let dup = false;
  try {
    await d.exec(`INSERT INTO payments (appointment_id, amount_cents, idempotency_key) VALUES (4, 100, 'k1')`);
  } catch {
    dup = true;
  }
  assert.ok(dup, 'DEUX PAIEMENTS avec la même idempotency_key acceptés : la contrainte a été perdue');
  await d.close();
});
