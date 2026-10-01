/** Boot d'une app isolée (base en mémoire + données de démo) pour les tests. */
process.env.TEST_DB = 'memory';
process.env.NODE_ENV = 'test';
process.env.TZ = process.env.TZ || 'Europe/Paris';

import { startOfDayMs, minFromHHMM, dayAdd } from '../server/lib/time.ts';

export type Res = { status: number; json: any; text: string; headers: Headers; cookie: string };

let cached: any = null;
export async function app() {
  if (cached) return cached;
  const { bootstrap } = await import('../server/app.ts');
  cached = await bootstrap();
  return cached;
}

/** Un seul contexte partagé par fichier de test : la base est la même. */
let jar = new Map<string, string>();
/** IP de test : chaque fichier a la sienne, sinon on sature immédiatement le rate-limit global. */
const FILE_IP = `203.0.113.${(process.pid % 200) + 10}`;

export async function call(path: string, init: { method?: string; body?: any; raw?: string; cookie?: string; ip?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const a = await app();
  const headers: Record<string, string> = { 'x-forwarded-for': init.ip ?? FILE_IP, ...init.headers };
  if (init.body !== undefined || init.raw !== undefined) headers['content-type'] = 'application/json';
  const cookie = init.cookie ?? '';
  if (cookie) headers.cookie = cookie;
  const res = await a.request(path, { method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'), headers, body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined) });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const [k] = pair.split('=');
    jar.set(k.trim(), pair);
  }
  return { status: res.status, json, text, headers: res.headers, cookie: [...jar.values()].join('; ') };
}

export const login = async (email: string, password = 'demo-owner') => (await call('/api/public/auth/password', { body: { email, password } })).cookie;

/** ts (epoch ms) pour un jour + heure locale du salon */
export const tsAt = (day: string, hhmm: string) => startOfDayMs(day) + minFromHHMM(hhmm) * 60_000;

/** premier jour ouvré à partir de demain qui a des créneaux libres */
export async function openDay(fromOffset = 1) {
  const a = await app();
  void a;
  const { todayDay } = await import('../server/lib/time.ts');
  let d = dayAdd(todayDay(), fromOffset);
  for (let i = 0; i < 21; i++) {
    const res = await call(`/api/public/availability?service=coupe-homme&days=1&date=${d}`);
    const day = res.json?.days?.[0];
    if (day?.slots?.length) return { day: d, ts: day.slots[0].ts, days: res.json.days };
    d = dayAdd(d, 1);
  }
  throw new Error('aucun jour ouvert trouvé');
}
