import { useMemo, useState } from 'react';
import { adminApi as A, availability } from '../lib/api';
import { Card, Chip, Field, Seg, errText, useAsync, useToast } from '../lib/ui';

/**
 * Édition des horaires et des disponibilités.
 *
 * Ce panneau remplace un simple tableau de deux colonnes : le salon doit pouvoir dire « jeudi
 * soir on ferme à 22 h », « Yass coupe aussi le dimanche matin », « le 1er mai tout le monde est
 * fermé », « Mehdi prend sa pause de 13 à 14 h » — et voir **tout de suite** ce que ça change,
 * sans avoir à enregistrer pour comprendre. Deux niveaux de vérité assumés :
 *  - l'estimation locale (par jour, par durée de RDV) : elle bouge pendant la frappe ;
 *  - le compte rendu par le moteur (`/api/public/availability`) : ce que les clients verront
 *    réellement, rafraîchi à l'ouverture du panneau et après chaque enregistrement.
 * Aucune disponibilité n'est inventée entre les deux : l'estimation est marquée comme telle.
 */

type Span = { o: string; c: string };
type DayRow = { open: boolean; spans: Span[]; breaks: Span[] };
type Rows = Record<number, DayRow>;

const ORDER = [1, 2, 3, 4, 5, 6, 0]; // lundi → dimanche ; `dow` suit getDay() : 0 = dimanche
const NAME: Record<number, string> = { 1: 'Lundi', 2: 'Mardi', 3: 'Mercredi', 4: 'Jeudi', 5: 'Vendredi', 6: 'Samedi', 0: 'Dimanche' };
const EMPTY: DayRow = { open: false, spans: [{ o: '', c: '' }], breaks: [] };

const isHHMM = (v: string) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(v || '').trim());
const toMin = (v: string) => {
  const [h, m] = String(v).split(':').map(Number);
  return h * 60 + m;
};
const fromMin = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const spanOk = (s: Span) => isHHMM(s.o) && isHHMM(s.c) && toMin(s.c) > toMin(s.o);
const key = (r: Rows) => ORDER.map((d) => `${d}:${r[d].open ? r[d].spans.map((s) => `${s.o}-${s.c}`).join('+') : '-'}:${r[d].breaks.map((s) => `${s.o}-${s.c}`).join('+')}`).join('|');

/** Le nombre de minutes réellement ouvertes d'un jour, pauses déduites (une pause à cheval sur
 *  deux plages n'est comptée qu'une fois, sur l'intersection). */
function openMinutes(row: DayRow) {
  if (!row.open) return 0;
  let open = 0;
  for (const s of row.spans) if (spanOk(s)) open += toMin(s.c) - toMin(s.o);
  let paused = 0;
  for (const b of row.breaks) {
    if (!spanOk(b)) continue;
    for (const s of row.spans) {
      if (!spanOk(s)) continue;
      const a = Math.max(toMin(b.o), toMin(s.o));
      const z = Math.min(toMin(b.c), toMin(s.c));
      if (z > a) paused += z - a;
    }
  }
  return Math.max(0, open - paused);
}

function slotsFor(row: DayRow, duration: number, step: number) {
  const mins = openMinutes(row);
  if (mins < duration) return 0;
  return Math.max(0, Math.floor((mins - duration) / step) + 1);
}

function rowsFrom(d: any, target: string): Rows {
  const out: Rows = {};
  for (const dow of [0, 1, 2, 3, 4, 5, 6]) out[dow] = { open: false, spans: [{ o: '', c: '' }], breaks: [] };
  if (target === 'loc') {
    const src = d?.location?.hours ?? {};
    for (const k of Object.keys(src)) {
      const dow = Number(k);
      if (!(dow >= 0 && dow <= 6) || !out[dow]) continue;
      const arr = Array.isArray(src[k]) ? src[k] : [];
      const spans: Span[] = arr.map((s: any) => ({ o: String(s?.[0] ?? ''), c: String(s?.[1] ?? '') })).filter((s: Span) => s.o && s.c);
      out[dow] = { open: spans.length > 0, spans: spans.length ? spans : [{ o: '', c: '' }], breaks: [] };
    }
    return out;
  }
  const st = (d?.staff ?? []).find((x: any) => String(x.id) === String(target));
  for (const r of st?.hours ?? []) {
    const dow = Number(r.dow);
    if (dow < 0 || dow > 6) continue;
    out[dow].spans.push({ o: fromMin(Number(r.start_min)), c: fromMin(Number(r.end_min)) });
  }
  for (const r of st?.breaks ?? []) {
    const dow = Number(r.dow);
    if (dow < 0 || dow > 6) continue;
    out[dow].breaks.push({ o: fromMin(Number(r.start_min)), c: fromMin(Number(r.end_min)) });
  }
  for (const dow of ORDER) {
    const row = out[dow];
    row.open = row.spans.length > 0;
    if (!row.spans.length) row.spans = [{ o: '', c: '' }];
  }
  return out;
}

const PRESETS: { label: string; hint: string; apply: (prev: Rows) => Rows }[] = [
  {
    label: '9 h 30 – 20 h, du lundi au samedi',
    hint: 'l’amplitude du quartier, dimanche fermé',
    apply: () => {
      const r: Rows = {};
      for (const dow of [0, 1, 2, 3, 4, 5, 6]) r[dow] = { open: dow !== 0, spans: dow === 0 ? [{ o: '', c: '' }] : [{ o: '09:30', c: '20:00' }], breaks: [] };
      return r;
    },
  },
  {
    label: 'Journée coupée (12 – 14 h)',
    hint: 'ouvre le midi, referme, rouvre le soir — garde les plages existantes',
    apply: (prev) => {
      const r: Rows = JSON.parse(JSON.stringify(prev));
      for (const dow of ORDER) if (r[dow].open) r[dow].breaks = [{ o: '12:00', c: '14:00' }];
      return r;
    },
  },
  {
    label: 'Copier le lundi sur toute la semaine',
    hint: 'pratique après une saison entière passée sur un seul jour',
    apply: (prev) => {
      const src = prev[1];
      const r: Rows = JSON.parse(JSON.stringify(prev));
      for (const dow of [2, 3, 4, 5, 6]) r[dow] = { open: src.open, spans: JSON.parse(JSON.stringify(src.spans)), breaks: JSON.parse(JSON.stringify(src.breaks)) };
      return r;
    },
  },
  {
    label: 'Tout fermer',
    hint: 'à n’utiliser qu’avant de poser des exceptions, sinon plus aucune réservation possible',
    apply: () => {
      const r: Rows = {};
      for (const dow of [0, 1, 2, 3, 4, 5, 6]) r[dow] = { open: false, spans: [{ o: '', c: '' }], breaks: [] };
      return r;
    },
  },
];

export function HoursEditor({ d, onSaved }: { d: any; onSaved?: () => void }) {
  const toast = useToast();
  const staff: any[] = Array.isArray(d?.staff) ? d.staff : [];
  const services: any[] = Array.isArray(d?.services) ? d.services : [];
  const [target, setTarget] = useState<string>('loc');
  const base = useMemo(() => rowsFrom(d, target), [d, target]);
  const [rows, setRows] = useState<Rows>(base);
  const [savedKey, setSavedKey] = useState<string>('');
  const [duration, setDuration] = useState<number>(30);
  const [busy, setBusy] = useState(false);
  const step = Number(d?.location?.policy?.slotStepMin || 10);
  const dirty = key(rows) !== (savedKey || key(base));

  // ce que le moteur donne réellement, pour la cible choisie (aperçu 7 jours)
  const probeKey = services[0]?.key ?? 'coupe-homme';
  const eng = useAsync(async () => {
    const q: Record<string, any> = { service: probeKey, days: 7 };
    if (target !== 'loc') {
      const st = staff.find((x) => String(x.id) === String(target));
      if (st?.slug) q.staff = st.slug;
    }
    try {
      return await availability(q);
    } catch {
      return null;
    }
  }, [target, savedKey]);

  const closures = useAsync(() => A.get('calendar', { mode: 'month' }).catch(() => null), [savedKey]);
  const [closure, setClosure] = useState({ day: '', reason: 'Fermé' });
  /* Une fermeture « tout le salon » est une ligne par barbier en base : on les regroupe pour
     n'afficher qu'une seule étiquette, annulable d'un clic (sinon l'admin doit cliquer trois fois
     pour le même jour, ce qui ressemble à un bug et laisse des journées fermées par erreur). */
  const upcoming = useMemo(() => {
    type Group = { day: string; label: string; reason: string; ids: number[]; who: string };
    const groups = new Map<string, Group>();
    const staffName = (id: number | null) => (id == null ? 'tout le salon' : staff.find((x) => Number(x.id) === Number(id))?.name ?? 'barbier');
    for (const day of closures.data?.days ?? []) {
      for (const b of day.blocks ?? []) {
        if (b.id == null) continue;
        const reason = b.reason ?? (b.kind === 'closed' ? 'Fermé' : b.kind);
        const k = `${day.day}|${reason}|${b.staffId ?? 'all'}`;
        const g: Group = groups.get(k) ?? { day: day.day, label: day.label, reason, ids: [], who: staffName(b.staffId ?? null) };
        g.ids.push(b.id);
        groups.set(k, g);
      }
    }
    return [...groups.values()].slice(0, 12);
  }, [closures.data]);

  const set = (dow: number, patch: Partial<DayRow>) => setRows((prev) => ({ ...prev, [dow]: { ...prev[dow], ...patch } }));
  const setSpan = (dow: number, i: number, field: 'o' | 'c', v: string) =>
    setRows((prev) => {
      const spans = prev[dow].spans.map((s, j) => (j === i ? { ...s, [field]: v } : s));
      return { ...prev, [dow]: { ...prev[dow], open: true, spans } };
    });
  const setBreak = (dow: number, i: number, field: 'o' | 'c', v: string) =>
    setRows((prev) => {
      const breaks = prev[dow].breaks.map((s, j) => (j === i ? { ...s, [field]: v } : s));
      return { ...prev, [dow]: { ...prev[dow], breaks } };
    });
  const addSpan = (dow: number) => set(dow, { open: true, spans: [...rows[dow].spans, { o: '', c: '' }] });
  const addBreak = (dow: number) => set(dow, { breaks: [...rows[dow].breaks, { o: '', c: '' }] });
  const delSpan = (dow: number, i: number) => {
    const spans = rows[dow].spans.filter((_, j) => j !== i);
    set(dow, { spans: spans.length ? spans : [{ o: '', c: '' }], open: spans.length > 0 });
  };
  const delBreak = (dow: number, i: number) => set(dow, { breaks: rows[dow].breaks.filter((_, j) => j !== i) });

  const problems: string[] = [];
  for (const dow of ORDER) {
    const row = rows[dow];
    if (!row.open) continue;
    for (const s of row.spans) if (!(isHHMM(s.o) && isHHMM(s.c))) { problems.push(`${NAME[dow]} : heure incomplète (format 09:30).`); break; }
    for (const s of row.spans) if (isHHMM(s.o) && isHHMM(s.c) && toMin(s.c) <= toMin(s.o)) { problems.push(`${NAME[dow]} : la fermeture doit être après l’ouverture.`); break; }
    for (const b of row.breaks) if (!(isHHMM(b.o) && isHHMM(b.c) && toMin(b.c) > toMin(b.o))) { problems.push(`${NAME[dow]} : pause mal renseignée.`); break; }
  }
  const openDays = ORDER.filter((dow) => rows[dow].open && openMinutes(rows[dow]) > 0);
  if (!openDays.length) problems.push('Aucun jour ouvert : personne ne pourrait réserver. Laisse au moins une journée ouverte, ou passe par les exceptions.');

  const withOwnHours = useMemo(() => staff.filter((x: any) => Array.isArray(x.hours) && x.hours.length > 0), [staff]);
  const perDay = ORDER.map((dow) => ({ dow, n: slotsFor(rows[dow], duration, step), mins: openMinutes(rows[dow]) }));
  const weekSlots = perDay.reduce((a, x) => a + x.n, 0);
  const engTotal = (eng.data?.days ?? []).reduce((a: number, x: any) => a + (x.count ?? 0), 0);

  async function save() {
    if (problems.length) {
      toast(problems[0], 'bad');
      return;
    }
    setBusy(true);
    try {
      if (target === 'loc') {
        const hours: Record<string, [string, string][]> = {};
        for (const dow of ORDER) hours[String(dow)] = rows[dow].open ? rows[dow].spans.filter(spanOk).map((s) => [s.o, s.c] as [string, string]) : [];
        await A.post('settings', { hours });
      } else {
        const st = staff.find((x) => String(x.id) === String(target));
        const hours = ORDER.filter((dow) => rows[dow].open).flatMap((dow) => rows[dow].spans.filter(spanOk).map((s) => ({ dow, start: s.o, end: s.c })));
        const breaks = ORDER.flatMap((dow) => rows[dow].breaks.filter(spanOk).map((s) => ({ dow, start: s.o, end: s.c })));
        // `name` est exigé par l'API ; `serviceIds` n'est PAS renvoyé ici : le serveur ne touche
        // donc plus les compétences quand on ne les envoie pas (avant, ce bouton les effaçait).
        await A.post('staff', { id: Number(st.id), name: st.name, title: st.title ?? undefined, hours, breaks });
      }
      const before = engTotal;
      setSavedKey(key(rows));
      onSaved?.();
      toast(`Horaires enregistrés — ${weekSlots} créneaux de ${duration} min calculés sur la semaine${before ? ` (le moteur en affichait ${before} sur 7 jours glissants)` : ''}.`, 'ok');
    } catch (e) {
      toast(errText(e), 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function closeDay() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(closure.day)) {
      toast('Choisis une date dans le calendrier.', 'bad');
      return;
    }
    setBusy(true);
    try {
      await A.post('blocks', {
        day: closure.day,
        from: 0,
        to: 24 * 60,
        kind: 'closed',
        reason: closure.reason.slice(0, 120) || 'Fermé',
        ...(target === 'loc' ? {} : { staffId: Number(target) }),
      });
      setClosure({ ...closure, day: '' });
      closures.reload();
      eng.reload();
      toast(target === 'loc' ? `Journée du ${closure.day} fermée pour tout le salon.` : `Journée du ${closure.day} fermée pour ce barbier.`, 'ok');
    } catch (e) {
      toast(errText(e), 'bad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid" style={{ gap: 14 }}>
      <Card>
        <div className="spread">
          <div>
            <p className="kick mb0">Qui ouvre quand ?</p>
            <h3 className="mb0" style={{ fontWeight: 650 }}>{target === 'loc' ? 'Horaires du salon' : staff.find((x) => String(x.id) === String(target))?.name}</h3>
          </div>
          <Chip tone={dirty ? 'gold' : 'ok'}>{dirty ? 'modifications non enregistrées' : 'à jour'}</Chip>
        </div>
        <div className="mt">
          <Seg
            label="Cible"
            value={target}
            onChange={(v) => setRows(rowsFrom(d, String(v)))}
            options={[{ value: 'loc', label: 'Salon (défaut)', hint: 'appliqué à tout le monde sauf exception' }, ...staff.map((x) => ({ value: String(x.id), label: x.name, hint: x.title ?? 'barbier' }))]}
          />
        </div>
        <div className="row mt">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              className="btn ghost sm"
              title={p.hint}
              onClick={() => {
                setRows((prev) => p.apply(prev));
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </Card>

      <div className="grid" style={{ gap: 8 }}>
        {ORDER.map((dow) => {
          const row = rows[dow];
          const n = slotsFor(row, duration, step);
          return (
            <Card key={dow} className={row.open ? '' : 'dim'}>
              <div className="spread">
                <label className="row" style={{ gap: 8 }}>
                  <input type="checkbox" checked={row.open} onChange={(e) => set(dow, { open: e.target.checked, spans: e.target.checked && !row.spans.some(spanOk) ? [{ o: '09:30', c: '20:00' }] : row.spans })} />
                  <b style={{ fontWeight: 650 }}>{NAME[dow]}</b>
                </label>
                <span className="mut xs" aria-live="polite">
                  {row.open ? `${Math.round(openMinutes(row) / 6) / 10} h ouvertes · ≈ ${n} créneaux de ${duration} min` : 'fermé'}
                </span>
              </div>
              {row.open && (
                <div className="grid" style={{ gap: 8, marginTop: 10 }}>
                  {row.spans.map((s, i) => (
                    <div className="row" key={i}>
                      <Field label={row.spans.length > 1 ? `Plage ${i + 1} — ouverture` : 'Ouverture'}>
                        <input type="time" step={300} inputMode="numeric" value={s.o} onChange={(e) => setSpan(dow, i, 'o', e.target.value)} aria-label={`Ouverture ${NAME[dow]}${row.spans.length > 1 ? ` plage ${i + 1}` : ''}`} />
                      </Field>
                      <Field label={row.spans.length > 1 ? `Plage ${i + 1} — fermeture` : 'Fermeture'}>
                        <input type="time" step={300} inputMode="numeric" value={s.c} onChange={(e) => setSpan(dow, i, 'c', e.target.value)} aria-label={`Fermeture ${NAME[dow]}${row.spans.length > 1 ? ` plage ${i + 1}` : ''}`} />
                      </Field>
                      {row.spans.length > 1 && (
                        <button className="btn ghost sm" onClick={() => delSpan(dow, i)} aria-label={`Retirer la plage ${i + 1} du ${NAME[dow]}`}>
                          retirer
                        </button>
                      )}
                    </div>
                  ))}
                  {target !== 'loc' && (
                    <div className="row">
                      {row.breaks.map((b, i) => (
                        <div className="row" key={`b${i}`}>
                          <Field label={`Pause ${row.breaks.length > 1 ? i + 1 : ''} — début`}>
                            <input type="time" step={300} value={b.o} onChange={(e) => setBreak(dow, i, 'o', e.target.value)} aria-label={`Début de pause ${NAME[dow]}`} />
                          </Field>
                          <Field label="fin">
                            <input type="time" step={300} value={b.c} onChange={(e) => setBreak(dow, i, 'c', e.target.value)} aria-label={`Fin de pause ${NAME[dow]}`} />
                          </Field>
                          <button className="btn ghost sm" onClick={() => delBreak(dow, i)}>
                            retirer
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="row">
                    <button className="btn ghost sm" onClick={() => addSpan(dow)}>
                      + une plage (midi et soir)
                    </button>
                    {target !== 'loc' && (
                      <button className="btn ghost sm" onClick={() => addBreak(dow)}>
                        + une pause
                      </button>
                    )}
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <Card>
        <div className="spread">
          <p className="kick mb0">Contrôle avant d’enregistrer</p>
          <Seg
            label="Durée de RDV pour l’estimation"
            value={duration}
            onChange={(v) => setDuration(Number(v))}
            options={[20, 30, 45, 60].map((n) => ({ value: n, label: `${n} min` }))}
          />
        </div>
        <p className="mut sm mb0" aria-live="polite">
          {weekSlots > 0 ? `${weekSlots} créneaux de ${duration} min sur la semaine (${openDays.length} jour(s) ouvert(s), pas de ${step} min).` : 'Aucun créneau ne sortirait de ces horaires.'}{' '}
          <span className="xs">Estimation locale : le chiffre exact dépend des RDV déjà pris et des blocages, visibles juste en dessous.</span>
        </p>
        {problems.length > 0 && (
          <ul className="note bad mt" style={{ listStyle: 'none', padding: '10px 12px' }}>
            {problems.slice(0, 4).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="row mt">
          <button className="btn" disabled={!dirty || busy || problems.length > 0} onClick={save}>
            {busy ? '…' : dirty ? 'Enregistrer les horaires' : 'Rien à enregistrer'}
          </button>
          <button className="btn ghost" disabled={!dirty || busy} onClick={() => setRows(base)}>
            Annuler les modifications
          </button>
          <button className="btn ghost sm" onClick={() => { setRows(base); setSavedKey(''); eng.reload(); }}>
            Recharger depuis la base
          </button>
        </div>
      </Card>

      <Card>
        <p className="kick mb0">Ce que voient les clients — {services[0]?.name ?? 'prestation'}{target !== 'loc' ? ` · ${staff.find((x) => String(x.id) === String(target))?.name}` : ' · tous barbiers'}</p>
        {eng.loading ? (
          <p className="mut sm">calcul en cours…</p>
        ) : (
          <div className="row mt">
            {(eng.data?.days ?? []).slice(0, 7).map((day: any) => (
              <span key={day.day} className={`chip ${day.count ? 'ok' : 'bad'}`} title={day.closed ?? ''}>
                {day.label} · {day.count ? `${day.count} créneaux` : day.closed ?? 'complet'}
              </span>
            ))}
            {!(eng.data?.days ?? []).length && <span className="mut sm">Le moteur ne renvoie encore aucune journée (salon en cours d’ouverture ou horaires trop stricts).</span>}
          </div>
        )}
        <p className="mut xs mb0 mt">
          Total sur la fenêtre : <b>{engTotal}</b> créneaux réservables maintenant.
        </p>
      </Card>

      {target === 'loc' && withOwnHours.length > 0 && (
        <Card>
          <div className="spread">
            <div>
              <p className="kick mb0" style={{ color: 'var(--gold)' }}>À savoir avant d’enregistrer</p>
              <h3 className="mb0" style={{ fontWeight: 650 }}>{withOwnHours.length} barbier{withOwnHours.length > 1 ? 's' : ''} gardent leurs propres horaires</h3>
              <p className="mut sm mb0 mt">
                {withOwnHours.map((x) => x.name).join(', ')} : chez {withOwnHours.length > 1 ? 'eux' : 'lui'} un jour fermé au salon reste ouvert tant
                qu’une plage est cochée dans leur fiche. C’est voulu (un barbier peut travailler le dimanche quand le salon est fermé), mais
                ça surprend le jour où l’on veut tout arrêter.
              </p>
            </div>
            <button
              className="btn ghost"
              onClick={async () => {
                if (!confirm(`Effacer les horaires personnels de ${withOwnHours.length} barbier${withOwnHours.length > 1 ? 's' : ''} pour les aligner sur ceux du salon ? Leurs pauses sautent aussi.`)) return;
                setBusy(true);
                try {
                  for (const x of withOwnHours) await A.post('staff', { id: x.id, name: x.name, hours: [], breaks: [] });
                  onSaved?.();
                  toast('Équipe alignée sur les horaires du salon. Les pauses individuelles ont été retirées.', 'ok');
                } catch (e) {
                  toast(errText(e), 'bad');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Les aligner sur le salon
            </button>
          </div>
          <p className="mut xs mb0 mt">Une fermeture ponctuelle, elle, passe avant tout : utilise « Fermer une journée » en dessous — elle vaut pour l’équipe entière, horaires personnels compris.</p>
        </Card>
      )}

      <Card>
        <p className="kick mb0">Fermer une journée précise</p>
        <p className="mut xs mb0">
          Congé, férié, formation, panne : ça n’écrase pas les horaires hebdomadaires, ça pose une exception ce jour-là — pour {target === 'loc' ? 'tout le salon' : 'ce barbier seulement'}.
        </p>
        <div className="row mt">
          <Field label="Date">
            <input type="date" value={closure.day} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setClosure({ ...closure, day: e.target.value })} aria-label="Date de fermeture" />
          </Field>
          <Field label="Motif visible par l’équipe">
            <input value={closure.reason} onChange={(e) => setClosure({ ...closure, reason: e.target.value })} maxLength={120} aria-label="Motif de fermeture" />
          </Field>
          <button className="btn" disabled={busy} onClick={closeDay}>
            Fermer la journée
          </button>
        </div>
        {upcoming.length > 0 && (
          <div className="mt">
            <p className="mut xs mb0">Exceptions déjà posées (35 jours)</p>
            <div className="row">
              {upcoming.map((b) => (
                <span key={b.day + b.reason + b.who} className="chip">
                  {b.label} · {b.reason} · {b.who}
                  <button
                    className="btn ghost sm"
                    style={{ marginLeft: 6, padding: '2px 6px' }}
                    aria-label={`Rouvrir le ${b.label} pour ${b.who}`}
                    onClick={async () => {
                      for (const id of b.ids) await A.post(`blocks/${id}/delete`, {}).catch((e) => toast(errText(e), 'bad'));
                      closures.reload();
                      eng.reload();
                      toast(b.ids.length > 1 ? `Journée du ${b.day} rouverte pour ${b.ids.length} barbiers.` : 'Journée rouverte.', 'ok');
                    }}
                  >
                    annuler
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
