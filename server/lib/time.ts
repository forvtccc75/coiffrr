import { env } from './env.ts';

/**
 * Toutes les dates "métier" du salon sont exprimées en minutes locales du fuseau
 * d'exploitation (Europe/Paris), et stockées en epoch ms UTC.
 * Aucun calcul de date n'est fait en SQL (portabilité SQLite/Postgres + index exploitables) :
 * c'est le serveur qui convertit.
 */
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

const dtf = new Intl.DateTimeFormat('en-GB', {
  timeZone: env.tz,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
});

function parts(ms: number) {
  if (!Number.isFinite(ms)) return { y: 1970, mo: 1, d: 1, h: 0, mi: 0, wd: 4 };
  const out: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    y: +out.year,
    mo: +out.month,
    d: +out.day,
    h: +out.hour % 24,
    mi: +out.minute,
    wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(out.weekday),
  };
}

export function tzOffsetMs(ms: number): number {
  const p = parts(ms);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  return Math.round((asUtc - Math.floor(ms / MIN) * MIN) / MIN) * MIN;
}

/** epoch ms -> "YYYY-MM-DD" local */
export function dateKey(ms: number): string {
  const p = parts(ms);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** epoch ms -> minutes depuis minuit local */
export function minutesOfDay(ms: number): number {
  const p = parts(ms);
  return p.h * 60 + p.mi;
}

export function dow(ms: number): number {
  return parts(ms).wd;
}

/** "YYYY-MM-DD" -> epoch ms de minuit local */
export function startOfDayMs(day: string): number {
  const [y, m, d] = String(day ?? '').split('-').map(Number);
  if (!y || !m || !d) return NaN;
  // minuit *local* (fuseau d'exploitation) et non minuit UTC : sur un serveur
  // calé en UTC (Vercel, conteneurs), arrondir à DAY renvoyait les créneaux
  // avec 1 à 2 h de décalage par rapport aux horaires réels du salon.
  const midnightAsUtc = Date.UTC(y, m - 1, d);
  let ms = midnightAsUtc - tzOffsetMs(midnightAsUtc + 12 * HOUR);
  const off2 = tzOffsetMs(ms);
  if (off2 !== tzOffsetMs(midnightAsUtc + 12 * HOUR)) ms = midnightAsUtc - off2; // bascule d'heure en milieu de nuit
  return Math.floor(ms / MIN) * MIN;
}

/** fin de journée exclusive = minuit *local* du lendemain (et non minuit + 24 h : le jour du
    changement d’heure fait 23 ou 25 heures, et une addition de DAY retombait sur le mauvais jour). */
export function endOfDayMs(day: string): number {
  return startOfDayMs(dayAfter(day));
}

/** Décalage de jours en *calendrier* : Date.UTC normalise les fins de mois et les années bissextiles. */
function shiftDay(day: string, n: number): string {
  const [y, m, d] = String(day ?? '').split('-').map(Number);
  if (!y || !m || !d) return '';
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export function dayAfter(day: string): string {
  return shiftDay(day, 1);
}
export function dayAdd(day: string, n: number): string {
  return shiftDay(day, n);
}
export function dayDiff(a: string, b: string): number {
  const pa = String(a ?? '').split('-').map(Number);
  const pb = String(b ?? '').split('-').map(Number);
  if (!pa[0] || !pb[0]) return NaN;
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / DAY);
}

/**
 * « Jour D + minutes depuis minuit local » -> epoch ms.
 *
 * L’addition directe (minuit du jour + n minutes) est fausse deux fois par an : la nuit du
 * changement d’heure, l’offset du matin n’est plus celui de minuit, et 09:30 se retrouvait
 * affiché 08:30 (ou 10:30). On itère donc sur l’offset de l’instant trouvé jusqu’à ce que
 * l’horloge murale retombe sur la minute demandée. Une minute inexistante (l’heure sautée au printemps) retombe sur le dernier
 * instant valable avant la bascule : du du grain, jamais NaN, donc aucun intervalle appelant
 * n’est empoisonné. Les horaires d’un salon (09:30-20:00) ne peuvent pas atteindre cette plage.
 */
export function atLocal(day: string, minuteOfDay: number): number {
  const [y, m, d] = String(day ?? '').split('-').map(Number);
  if (!y || !m || !d) return NaN;
  const want = Math.floor(Number(minuteOfDay) || 0);
  const wallAsUtc = Date.UTC(y, m - 1, d, 0, want);
  let ms = wallAsUtc - tzOffsetMs(wallAsUtc);
  for (let i = 0; i < 3; i++) {
    const next = wallAsUtc - tzOffsetMs(ms);
    if (next === ms) break;
    ms = next;
  }
  if (minutesOfDay(ms) !== ((want % 1440) + 1440) % 1440 || dateKey(ms) !== day) ms += (((want % 1440) + 1440) % 1440 - minutesOfDay(ms)) * MIN;
  return Math.floor(ms / MIN) * MIN;
}
export function todayDay(): string {
  return dateKey(Date.now());
}

export function minFromHHMM(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}
export function hhmm(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function fmtTime(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const p = parts(ms);
  return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}

const WD = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MO = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

export function fmtDate(ms: number, opts: { weekday?: boolean; short?: boolean } = {}): string {
  if (!Number.isFinite(ms)) return '';
  const p = parts(ms);
  const d = opts.short ? `${p.d}/${String(p.mo).padStart(2, '0')}` : `${p.d} ${MO[p.mo - 1]} ${p.y}`;
  return opts.weekday === true ? `${WD[p.wd]} ${d}` : d;
}

export function fmtDateLong(ms: number): string {
  const p = parts(ms);
  return `${WD[p.wd]} ${p.d} ${MO[p.mo - 1]}`;
}

export function weekdayLabel(d: number): string {
  return ['Dim.', 'Lun.', 'Mar.', 'Mer.', 'Jeu.', 'Ven.', 'Sam.'][d];
}

export function daysUntil(ms: number): number {
  return dayDiff(todayDay(), dateKey(ms));
}

/** "dans 3 h", "dans 45 min", "demain à 14:00" */
export function humanWhen(ms: number, now = Date.now()): string {
  if (!Number.isFinite(ms)) return '';
  const diff = ms - now;
  const day = daysUntil(ms);
  const t = fmtTime(ms);
  if (Math.abs(diff) < MIN) return 'maintenant';
  if (diff < 0) return `il y a ${humanDur(-diff)}`;
  if (day === 0) return `aujourd'hui à ${t}`;
  if (day === 1) return `demain à ${t}`;
  if (day === 2) return `après-demain à ${t}`;
  if (day < 7) return `${WD[parts(ms).wd]} ${t}`;
  return fmtDate(ms, { short: true }) + ` à ${t}`;
}

export function humanDur(ms: number): string {
  const min = Math.round(ms / MIN);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}

export function humanDaysAgo(ms: number, now = Date.now()): string {
  const d = Math.max(0, Math.round((now - ms) / DAY));
  if (d === 0) return "aujourd'hui";
  if (d === 1) return 'hier';
  if (d < 31) return `il y a ${d} jours`;
  const mo = Math.round(d / 30);
  return mo <= 1 ? 'il y a 1 mois' : `il y a ${mo} mois`;
}

export function rangeOfDay(day: string) {
  const s = startOfDayMs(day);
  return { s, e: s + DAY };
}

export function eachDay(from: string, to: string, fn: (day: string) => void) {
  let c = from;
  let guard = 0;
  while (c <= to && guard++ < 400) {
    fn(c);
    c = dayAfter(c);
  }
}

export const nowMs = () => Date.now();
export const roundToStep = (ms: number, stepMin: number) => Math.ceil(ms / (stepMin * MIN)) * stepMin * MIN;
export const isAligned = (ms: number, stepMin: number) => ms % (stepMin * MIN) === 0;
