/**
 * Couche d'accès données unique : un seul SQL métier traduit vers SQLite (dev/test)
 * ou Postgres (Vercel + Neon/Supabase en production).
 *
 * Règles d'écriture :
 *  - paramètres nommés `:name` (traduits en `?` / `$n`)
 *  - aucun opérateur de date SQL : tout est epoch ms (BIGINT), montants en centimes,
 *    booléens 0/1, JSON en TEXT. Les deux moteurs renvoient donc des résultats identiques.
 *  - toute écriture multi-requêtes passe par `session()` : transaction atomique,
 *    verrou d'exclusion côté PG (pg_advisory_xact_lock), file d'attente mono-écrivain côté SQLite.
 */
export type SqlValue = string | number | null | boolean | undefined;
export type Params = Record<string, SqlValue>;
export type QRes<T = any> = { rows: T[]; changes: number; lastId: number | null };

/** Convertit `:name` en positionnel en ignorant les littéraux entre guillemets. */
/**
 * Attention, piège mesuré le 24/09 : ce scanneur suit les guillemets mais PAS les commentaires SQL.
 * Une apostrophe dans un commentaire bloc inclus dans le texte de la requête ouvre une chaîne fictive,
 * les `:param` suivants ne sont plus substitués, et l'exécution échoue pour « Missing named parameters »
 * — sur les deux moteurs. Les commentaires qui expliquent une requête vont donc AU-DESSUS du template,
 * pas dedans.
 */
export function parseNamed(sql: string, params: Params = {}) {
  const names: string[] = [];
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < sql.length) {
    const c = sql[i];
    if (inStr) {
      out += c;
      if (c === "'") {
        if (sql[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        inStr = false;
      }
      i++;
      continue;
    }
    if (c === "'") {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    // `::` est un cast Postgres (`x::int`), pas un paramètre : sans ce garde, `count(*)::int`
    // était lu comme le paramètre « int » et la requête échouait avant d'atteindre la base.
    if (c === ':' && sql[i + 1] === ':') {
      out += '::';
      i += 2;
      continue;
    }
    if (c === ':' && /[A-Za-z_]/.test(sql[i + 1] || '')) {
      const m = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i))!;
      names.push(m[1]);
      out += '\u0000';
      i += m[0].length;
      continue;
    }
    out += c;
    i++;
  }
  const values = names.map((n) => {
    if (!(n in params)) throw new Error(`Paramètre SQL manquant : ${n} — ${sql.slice(0, 90)}`);
    const v = params[n];
    return v === undefined || v === null ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v;
  });
  return { text: out, values };
}

export function toDialect(text: string, kind: 'sqlite' | 'pg'): string {
  let n = 0;
  return text.replace(/\u0000/g, () => (kind === 'pg' ? `$${++n}` : '?'));
}

export interface Session {
  readonly kind: 'sqlite' | 'pg';
  all<T = any>(sql: string, params?: Params): Promise<T[]>;
  run(sql: string, params?: Params): Promise<QRes>;
  exec(sql: string): Promise<void>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  lock?(key: number | string): Promise<void>;
  release(): Promise<void>;
}

export interface Driver {
  kind: 'sqlite' | 'pg';
  session(): Promise<Session>;
  /**
   * Session « hors transaction » branchée directement sur le pool (Postgres). Elle évite de
   * retenir un client `pg` pour toute la vie du process : un client retenu en permanence, c'est
   * `pool.end()` qui ne revient jamais (le CLI `npm run migrate` ne sortait pas) et une requête
   * de moins en parallélisme. Les transactions gardent `session()` : BEGIN/COMMIT exigent un client.
   */
  sharedSession?(): Session;
  exec(sql: string): Promise<void>;
  all<T = any>(sql: string, params?: Params): Promise<T[]>;
  close(): Promise<void>;
}

class SessionBase implements Session {
  /** verrou advisory (Postgres) / no-op (SQLite, déjà sérialisé par la file) */
  lock?: (key: number | string) => Promise<void>;
  private raw: (text: string, values: any[]) => Promise<QRes>;
  constructor(readonly kind: 'sqlite' | 'pg', raw: (text: string, values: any[]) => Promise<QRes>) {
    this.raw = async (text, values) => raw(toDialect(text, this.kind), values);
  }
  async all<T>(sql: string, params: Params = {}) {
    const p = parseNamed(sql, params);
    return (await this.raw(p.text, p.values)).rows as T[];
  }
  async run(sql: string, params: Params = {}) {
    const p = parseNamed(sql, params);
    return this.raw(p.text, p.values);
  }
  async exec(sql: string) {
    await this.raw(sql, []);
  }
  begin(): Promise<void> {
    throw new Error('non implémenté');
  }
  commit(): Promise<void> {
    throw new Error('non implémenté');
  }
  rollback(): Promise<void> {
    throw new Error('non implémenté');
  }
  async release() {}
}

export async function createDriver(opts: { dataFile?: string; connectionString?: string }): Promise<Driver> {
  if (opts.connectionString) {
    const pg = await import('pg');
    /* Politique TLS centralisée (voir pg-options.ts) : `sslmode` doit sortir de l'URL, sinon pg
       l'applique APRÈS notre option `ssl` et le handshake échoue sur un certificat autosigné. */
    const { pgConnectionOptions } = await import('./pg-options.ts');
    const connOpts = pgConnectionOptions(opts.connectionString);
    const pool = new pg.default.Pool({
      connectionString: connOpts.connectionString,
      max: Number(process.env.PG_POOL_MAX || 10),
      ssl: connOpts.ssl,
    });
    const pgTypes = (pg.default as any).types;
    if (pgTypes?.setTypeParser) for (const oid of [20, 21, 23, 26, 1700, 700, 701]) pgTypes.setTypeParser(oid, (v: any) => (v === null ? null : Number(v)));

    const mkSession = (client: any) => {
      const s = new SessionBase('pg', async (text, values) => {
        const r = await client.query(text, values);
        return { rows: (r.rows ?? []) as any[], changes: typeof r.rowCount === 'number' ? r.rowCount : 0, lastId: null };
      });
      s.begin = () => client.query('BEGIN');
      s.commit = () => client.query('COMMIT');
      s.rollback = () => client.query('ROLLBACK').catch(() => undefined);
      s.lock = async (key) => {
        const k = typeof key === 'number' ? key : [...String(key)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);
        await client.query(`SELECT pg_advisory_xact_lock(${k & 2147483647})`);
      };
      return s;
    };

    const shared = new SessionBase('pg', async (text, values) => {
      const r = await pool.query(text, values);
      return { rows: (r.rows ?? []) as any[], changes: typeof r.rowCount === 'number' ? r.rowCount : 0, lastId: null };
    });
    // Le handle global ne transige jamais : un BEGIN sur le pool tomberait sur un client au hasard.
    shared.begin = async () => {
      throw new Error('db() ne peut pas ouvrir de transaction : passer par transaction()');
    };
    shared.commit = shared.begin;
    shared.rollback = async () => undefined;
    shared.release = async () => undefined;

    return {
      kind: 'pg',
      sharedSession: () => shared,
      async session() {
        const client = await pool.connect();
        const s = mkSession(client);
        const origRelease = s.release;
        s.release = async () => {
          try {
            await origRelease.call(s);
          } finally {
            client.release();
          }
        };
        return s;
      },
      async exec(sql) {
        await pool.query(sql);
      },
      async all<T>(sql: string, params: Params = {}) {
        const p = parseNamed(sql, params);
        const r = await pool.query(toDialect(p.text, 'pg'), p.values);
        return r.rows as T[];
      },
      close: () => pool.end().then(() => undefined),
    };
  }

  const mod: any = await import('better-sqlite3');
  const Database = mod.default ?? mod;
  const { mkdirSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const file = opts.dataFile || ':memory:';
  if (file !== ':memory:') mkdirSync(dirname(resolve(file)), { recursive: true });
  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 8000');

  // File mono-écrivain : aucune requête tierce ne peut s'intercaler dans une transaction ouverte.
  let chain: Promise<void> = Promise.resolve();
  // Profondeur de transaction : 0 = aucune, 1 = BEGIN ouvert, >1 = transaction imbriquée.
  // Une transaction imbriquée est réelle (SAVEPOINT), pas un no-op : sinon un `commit` interne
  // validait tout le travail du parent, et un `rollback` interne lui effaçait ses écritures.
  let txDepth = 0;
  const spNames: string[] = [];
  const queue = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const rawRun = (text: string, values: any[]): Promise<QRes> =>
    queue(async () => {
      const st = conn.prepare(text);
      if (/^\s*(select|with|pragma)\b/i.test(text)) return { rows: st.all(...values) as any[], changes: 0, lastId: null };
      if (/\breturning\b/i.test(text) && /^\s*(update|delete)/i.test(text)) {
        const rows = st.all(...values) as any[];
        return { rows, changes: rows.length, lastId: null };
      }
      const r = st.run(...values);
      return { rows: [], changes: Number(r.changes), lastId: r.lastInsertRowid == null ? null : Number(r.lastInsertRowid) };
    });

  const drv: Driver = {
    kind: 'sqlite',
    async exec(sql) {
      await queue(async () => {
        conn.exec(sql);
      });
    },
    async all<T>(sql: string, params: Params = {}) {
      const p = parseNamed(sql, params);
      return (await rawRun(toDialect(p.text, 'sqlite'), p.values)).rows as T[];
    },
    async session() {
      const s = new SessionBase('sqlite', rawRun);
      s.begin = async () => {
        await queue(async () => {
          if (txDepth === 0) conn.exec('BEGIN IMMEDIATE');
          else {
            const name = `zyass_sp_${txDepth}`;
            spNames.push(name);
            conn.exec(`SAVEPOINT ${name}`);
          }
          txDepth++;
        });
      };
      s.commit = async () => {
        await queue(async () => {
          if (txDepth <= 0) return;
          txDepth--;
          if (txDepth === 0) conn.exec('COMMIT');
          else conn.exec(`RELEASE ${spNames.pop()}`);
        });
      };
      s.rollback = async () => {
        await queue(async () => {
          if (txDepth <= 0) return;
          if (txDepth === 1) {
            txDepth = 0;
            conn.exec('ROLLBACK');
            return;
          }
          const name = spNames.pop();
          // ROLLBACK TO laisse le savepoint ouvert : on le libère juste après.
          conn.exec(`ROLLBACK TO ${name}; RELEASE ${name};`);
          txDepth--;
        });
      };
      s.lock = async () => {};
      s.release = async () => {
        // filet de sécurité : une session rendue avec une transaction encore ouverte serait un
        // verrou éternel sur la garde d'écriture.
        if (txDepth > 0) await s.rollback();
      };
      return s;
    },
    close: async () => queue(() => Promise.resolve(conn.close())),
  };
  return drv;
}
