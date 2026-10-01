import { db, sj } from '../db/index.ts';

/** Observabilité minimale et locale : latence + erreurs, exploitables depuis /api/admin/observability.
 *  En production : brancher Sentry/OTLP en lisant la même table ou en poussant les événements. */
export async function observe(kind: string, name: string, ms: number | null, status: string, meta: any = {}, locId: number | null = null) {
  try {
    await db().insert('observations', { location_id: locId, kind, name, ms: ms == null ? null : Math.round(ms), status, meta_json: sj(meta), ts: Date.now() });
  } catch {
    /* jamais bloquant */
  }
}

export async function p95(kind: string) {
  const rows = await db().all<any>(`SELECT ms FROM observations WHERE kind = :k AND ms IS NOT NULL ORDER BY id DESC LIMIT 500`, { k: kind });
  const v = rows.map((r) => r.ms).sort((a, b) => a - b);
  if (!v.length) return { p50: 0, p95: 0, p99: 0, n: 0 };
  const at = (q: number) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), n: v.length };
}
