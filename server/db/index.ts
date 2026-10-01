import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from '../lib/env.ts';
import { createDriver, parseNamed, toDialect, type Driver, type Params, type Session, type SqlValue } from './driver.ts';
import { ddlFor, wantedColumns } from './schema.ts';

export type { Params, Session, SqlValue } from './driver.ts';

let drvP: Promise<Driver> | null = null;

/** Handle de requêtes : toute l'app passe par là, avec un handle dédié en transaction. */
export interface Q {
  all<T = any>(sql: string, params?: Params): Promise<T[]>;
  one<T = any>(sql: string, params?: Params): Promise<T | null>;
  run(sql: string, params?: Params): Promise<{ changes: number; lastId: number | null }>;
  exec(sql: string, params?: Params): Promise<number>;
  num(sql: string, params?: Params): Promise<number>;
  insert(table: string, row: Record<string, SqlValue>): Promise<number>;
  update(table: string, id: number, patch: Record<string, SqlValue>): Promise<number>;
  del(table: string, id: number): Promise<number>;
}

function handle(s: Session): Q {
  return {
    all: (sql, params) => s.all(sql, params),
    one: async (sql, params) => (await s.all(sql, params))[0] ?? null,
    run: (sql, params) => s.run(sql, params),
    exec: async (sql, params) => (await s.run(sql, params)).changes,
    num: async (sql, params) => {
      const r = await s.all(sql, params);
      const row = r[0] as any;
      if (!row) return 0;
      const v = Object.values(row)[0];
      return v == null ? 0 : Number(v);
    },
    insert: async (table, row) => {
      const keys = Object.keys(row).filter((k) => row[k] !== undefined);
      const vals = Object.fromEntries(keys.map((k) => [k, (row as any)[k]]));
      const r = await s.run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => `:${k}`).join(', ')}) RETURNING id`, vals as Params);
      const id = r.lastId ?? (r.rows[0] as any)?.id;
      if (id == null) throw new Error(`insert(${table}) : pas d'identifiant renvoyé`);
      return Number(id);
    },
    update: async (table, id, patch) => {
      const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
      if (!keys.length) return 0;
      const r = await s.run(`UPDATE ${table} SET ${keys.map((k) => `${k} = :${k}`).join(', ')} WHERE id = :__id`, { ...patch, __id: id } as Params);
      return r.changes;
    },
    del: async (table, id) => (await s.run(`DELETE FROM ${table} WHERE id = :id`, { id })).changes,
  };
}

let globalHandle: Q | null = null;
let globalSession: Session | null = null;

export async function getDriver(): Promise<Driver> {
  if (!drvP) {
    // `TEST_DB=memory` est un ordre, pas une préférence : sans ce garde, `npm run smoke` (qui pose
    // cette variable) partait écrire dans la base de production dès que DATABASE_URL traînait dans
    // l'environnement. `TEST_DB=pg` demande au contraire explicitement le moteur Postgres.
    const forceMemory = process.env.TEST_DB === 'memory';
    const inMemory = forceMemory || (!process.env.TEST_DB && env.demo && process.env.NODE_ENV === 'test');
    drvP = createDriver({
      connectionString: forceMemory ? undefined : env.databaseUrl || undefined,
      dataFile: inMemory ? ':memory:' : env.dataFile,
    }).then(async (d) => {
      try {
        await migrate(d);
        // Postgres : handle global sur le pool (aucun client retenu) ; SQLite : connexion unique.
        globalSession = d.sharedSession ? d.sharedSession() : await d.session();
        globalHandle = handle(globalSession);
        return d;
      } catch (error) {
        await d.close().catch(() => undefined);
        throw error;
      }
    }).catch((error) => {
      // Une coupure transitoire ne doit pas empoisonner toute la vie d'une instance Vercel.
      drvP = null;
      globalSession = null;
      globalHandle = null;
      throw error;
    });
  }
  return drvP;
}

export function db(): Q {
  if (!globalHandle) throw new Error('db() appelé avant l’initialisation — attendez getDriver()');
  return globalHandle;
}

export async function ready() {
  await getDriver();
  return globalHandle!;
}

/**
 * Transaction atomique. SQLite : BEGIN IMMEDIATE + garde exclusive tenue du BEGIN au COMMIT
 * (deux requêtes simultanées sur le même créneau sont sérialisées, jamais entrelacées : sans la
 * garde, la seconde session écrivait À L'INTÉRIEUR de la transaction ouverte par la première).
 * Postgres : client dédié + pg_advisory_xact_lock(locId) : toute écriture de planning
 * pour un salon est sérialisée => zéro double réservation possible, même multi-instance.
 */
let writerGate: Promise<void> = Promise.resolve();
async function acquireWriterGate(): Promise<() => void> {
  const previous = writerGate;
  let release: () => void = () => undefined;
  writerGate = new Promise<void>((r) => {
    release = r;
  });
  await previous;
  return release;
}

/** Chaîne appelante déjà propriétaire de la garde => réentrance, jamais attente de soi-même. */
const txChain = new AsyncLocalStorage<{ depth: number }>();

export async function transaction<T>(fn: (q: Q) => Promise<T>, lockKey: number = 1): Promise<T> {
  const drv = await getDriver();
  const gated = drv.kind === 'sqlite';
  const nested = gated && txChain.getStore() != null;
  const release = gated && !nested ? await acquireWriterGate() : null;
  const s = await drv.session();
  try {
    await s.begin();
    if (s.lock) await s.lock(lockKey);
    const run = () => fn(handle(s));
    const out = gated ? await txChain.run({ depth: (txChain.getStore()?.depth ?? 0) + 1 }, run) : await run();
    await s.commit();
    return out;
  } catch (e) {
    await s.rollback();
    throw e;
  } finally {
    await s.release();
    release?.();
  }
}

/** Point d'entrée des gros écrivains qui doivent se sérialiser avec transaction(). */
export async function withLock<T>(fn: () => Promise<T>, lockKey: number): Promise<T> {
  const s = (await getDriver()).kind === 'pg' ? await (await getDriver()).session() : null;
  try {
    if (s) {
      await s.begin();
      await s.lock?.(lockKey);
    }
    return await fn();
  } finally {
    if (s) {
      await s.commit().catch(() => undefined);
      await s.release();
    }
  }
}

/**
 * Applique le schéma, PUIS rattache les colonnes qui manqueraient à une table déjà existante.
 * Le second temps est le seul qui protège une base de production contre une évolution du produit :
 * `CREATE TABLE IF NOT EXISTS` laisse une table ancienne telle quelle, et l'app partait alors en
 * « column does not exist » chez le client, vert partout en local (mesuré le 28/09 en écrivant 01-schema.sql).
 * Chaque ALTER est indépendant et tolérant : une colonne non ajoutable (NOT NULL sans défaut sur une table
 * peuplée) est remontée dans `failed`, elle ne bloque pas le démarrage des 51 autres tables.
 */
export async function migrate(drv: Driver): Promise<{ added: string[]; failed: Array<{ where: string; why: string }> }> {
  // Ordre imposé par la réalité : les CREATE TABLE d'abord, le rattrapage de colonnes ensuite, les
  // INDEX enfin. Un index sur une colonne que la table ancienne n'a pas fait échouer toute la migration
  // (« no such column: phone_norm ») et le service ne démarrait plus — mesuré le 28/09 en testant le
  // rattrapage sur une table volontairement vieille.
  const stmts = ddlFor(drv.kind);
  const isCreate = (x: string) => /^\s*CREATE\s+TABLE/i.test(x);
  for (const stmt of stmts.filter(isCreate)) {
    try {
      await drv.exec(stmt);
    } catch (e: any) {
      throw new Error(`Migration échouée:\n${stmt.slice(0, 200)}…\n→ ${e?.message || e}`);
    }
  }
  const added: string[] = [];
  const failed: Array<{ where: string; why: string }> = [];
  const byTable = new Map<string, string[]>();
  for (const c of wantedColumns(drv.kind)) {
    const l = byTable.get(c.table) ?? [];
    l.push(`${c.col}\u0001${c.def}`);
    byTable.set(c.table, l);
  }
  for (const [table, cols] of byTable) {
    let have = new Set<string>();
    try {
      have =
        drv.kind === 'pg'
          ? new Set((await drv.all<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = :t`, { t: table })).map((r) => r.c))
          : new Set((await drv.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((r) => r.name));
    } catch {
      continue; // table absente : rien à rattacher (le CREATE du début l'a déjà créée si elle manquait)
    }
    for (const entry of cols) {
      const [col, def] = entry.split('\u0001');
      if (have.has(col)) continue;
      const tryAdd = async (d: string) => drv.exec(`ALTER TABLE ${table} ADD COLUMN ${d}`);
      try {
        await tryAdd(def);
        added.push(`${table}.${col}`);
      } catch (e1: any) {
        // SQLite refuse un ADD COLUMN portant UNIQUE ou PRIMARY KEY en ligne : on retente sans la
        // contrainte — elle est portée par les CREATE UNIQUE INDEX du schéma, appliqués juste après.
        const light = def.replace(/\s+(UNIQUE|PRIMARY KEY)(\s+AUTOINCREMENT)?/gi, '');
        if (light === def) {
          failed.push({ where: `${table}.${col}`, why: String(e1?.message ?? e1).slice(0, 160) });
          continue;
        }
        try {
          await tryAdd(light);
          // La contrainte retirée ne doit pas disparaître pour autant : on la remplace par un index
          // unique du même effet (mesuré le 28/09 : payments.idempotency_key n'a AUCUN index unique dans
          // le schéma, sa seule protection est son UNIQUE en ligne — la retirer sans rien poser ouvrait
          // la porte aux doublons de paiement).
          let indexNote = '';
          if (/\b(UNIQUE|PRIMARY KEY)\b/i.test(def)) {
            try {
              await drv.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_rattrape_${table}_${col} ON ${table} (${col})`);
              indexNote = ', contrainte reportée sur ux_rattrape_' + table + '_' + col;
            } catch {
              indexNote = ', IMPOSSIBLE de poser l’index unique de repli';
            }
          }
          added.push(`${table}.${col} (contrainte en ligne retirée${indexNote})`);
        } catch (e2: any) {
          failed.push({ where: `${table}.${col}`, why: `${String(e1?.message ?? e1).slice(0, 80)} / relu: ${String(e2?.message ?? e2).slice(0, 80)}` });
        }
      }
    }
  }
  for (const stmt of stmts.filter((x) => !isCreate(x))) {
    try {
      await drv.exec(stmt);
    } catch (e: any) {
      throw new Error(`Migration échouée:\n${stmt.slice(0, 200)}…\n→ ${e?.message || e}`);
    }
  }
  await drv.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_ts BIGINT NOT NULL)`);
  return { added, failed };
}

export async function isSeeded(): Promise<boolean> {
  const drv = await getDriver();
  try {
    const rows = await drv.all(`SELECT COUNT(*) AS c FROM locations`);
    return Number((rows[0] as any).c) > 0;
  } catch {
    return false;
  }
}

export async function seedIfEmpty(run: () => Promise<void>) {
  if (await isSeeded()) return false;
  await run();
  return true;
}

export async function closeDb() {
  if (!drvP) return;
  const d = await drvP;
  const s = globalSession;
  globalHandle = null;
  globalSession = null;
  // Relâcher le handle global AVANT de fermer le pool : sinon `pool.end()` attend éternellement
  // un client que nous retenons nous-mêmes, et tout CLI (`migrate`, `seed`) hang sur Postgres.
  if (s) {
    try {
      await s.release();
    } catch {
      /* une session déjà relâchée n'a plus rien à fermer */
    }
  }
  await d.close();
  drvP = null;
}

export function j<T = any>(v: any, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'object') return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
export const sj = (v: unknown) => JSON.stringify(v ?? null);
