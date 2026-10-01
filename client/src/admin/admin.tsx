import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { adminApi as A, eur, time, when, useConfig } from '../lib/api';
import { Card, Chip, Field, Modal, Seg, Skeleton, errText, useAsync, useToast } from '../lib/ui';
import { Analytics, Assistant, Automations, Clients, Marketing, Reviews, Settings } from './panels';

/**
 * Back-office. Objectif : toute la journée du salon sans sortir d'un écran,
 * et zéro tâche administrative pour les tâches déjà automatisées.
 */
const pick = (d: any, keys: string[]): any[] => {
  if (Array.isArray(d)) return d;
  for (const k of keys) if (Array.isArray(d?.[k])) return d[k];
  return [];
};

export function Admin() {
  const { pathname } = useLocation();
  const { cfg } = useConfig();
  // (le rôle vient de /api/public/me, plus bas : un `A.get('..')` ajoutait une requête
  //  qui se normalisait en « GET /api/ » → 404 à chaque ouverture du back-office)
  const [auth, setAuth] = useState<{ loading: boolean; user: any }>({ loading: true, user: null });
  useEffect(() => {
    fetch('/api/public/me', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j) => setAuth({ loading: false, user: j?.user?.role && j.user.role !== 'customer' ? j.user : null }))
      .catch(() => setAuth({ loading: false, user: null }));
  }, []);

  const section = '/' + (pathname.split('/')[2] ?? 'today');
  if (auth.loading) return <div className="wrap pad"><Skeleton n={5} /></div>;
  if (!auth.user) return <Login onDone={() => location.reload()} demo={!!cfg?.demo} />;

  const navAll: [string, string][] = [
    ['/today', "Aujourd'hui"],
    ['/planning', 'Planning'],
    ['/queue', 'Files'],
    ['/waitlist', 'Waitlist'],
    ['/clients', 'Clients'],
    ['/analytics', 'Analytique'],
    ['/reviews', 'Avis'],
    ['/marketing', 'Marketing'],
    ['/automations', 'Automatisations'],
    ['/assistant', 'Assistant'],
    ['/settings', 'Réglages'],
  ];
  // la règle d'affichage suit celle du serveur (requireAdmin 'manager' sur /settings) : un lien
  // qui mène à un 403 n'est pas une permission, c'est une porte qui claque.
  const canSettings = ['owner', 'manager'].includes(String(auth.user?.role ?? ''));
  const nav = navAll.filter(([k]) => k !== '/settings' || canSettings);

  return (
    <div className="adm">
      <nav className="adm-nav" aria-label="Back-office">
        <div className="logo brand" style={{ padding: '4px 10px 12px' }}>
          Z.YASS
        </div>
        {nav.map(([to, label]) => (
          <Link key={to} to={'/admin' + to} className={section === to ? 'on' : ''}>
            {label}
          </Link>
        ))}
        <div style={{ flex: 1 }} />
        <span className="mut xs" style={{ padding: '10px' }}>
          {auth.user.name} · {auth.user.role}
        </span>
        <button
          className="btn ghost sm"
          style={{ margin: '0 10px 12px' }}
          onClick={async () => {
            await A.logout().catch(() => undefined);
            location.href = '/';
          }}
        >
          Déconnexion
        </button>
      </nav>
      <main className="adm-main" id="adm-main" tabIndex={-1}>
        {section === '/today' && <Today />}
        {section === '/planning' && <Planning />}
        {section === '/queue' && <Queue />}
        {section === '/waitlist' && <WaitlistAdmin />}
        {section === '/clients' && <Clients />}
        {section === '/analytics' && <Analytics />}
        {section === '/reviews' && <Reviews />}
        {section === '/marketing' && <Marketing />}
        {section === '/automations' && <Automations />}
        {section === '/assistant' && <Assistant />}
        {section === '/settings' && <Settings />}
      </main>
    </div>
  );
}

export function Login({ onDone, demo }: { onDone: () => void; demo: boolean }) {
  const [email, setEmail] = useState(demo ? 'owner@zyass.fr' : '');
  const [password, setPassword] = useState(demo ? 'demo-owner' : '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="wrap pad center" style={{ maxWidth: 430, paddingTop: '12vh' }}>
      <h1>Espace salon</h1>
      <p className="mut">Planning, clients, waitlist et statistiques. Accès réservé.</p>
      <form
        className="card hl col"
        style={{ gap: 0, textAlign: 'left' }}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr('');
          try {
            await A.login(email.trim(), password);
            onDone();
          } catch (e2) {
            setErr(errText(e2));
            setBusy(false);
          }
        }}
      >
        <Field label="E-mail">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus />
        </Field>
        <Field label="Mot de passe">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        {err && <div className="note bad">{err}</div>}
        <button className="btn block lg" disabled={busy}>
          {busy ? '…' : 'Entrer'}
        </button>
        {demo && <p className="mut xs center mb0" style={{ marginTop: 10 }}>Démo : owner@zyass.fr / demo-owner · ou mehdi@zyass.fr / demo-staff</p>}
      </form>
      <p className="mut xs mt">
        <Link to="/" className="link">
          ← retour au site
        </Link>
      </p>
    </div>
  );
}

/* ───────────────────────── AUJOURD'HUI ───────────────────────── */
function Today() {
  const toast = useToast();
  const t = useAsync(() => A.get('today'), []);
  const act = async (id: number, action: string, body: any = {}) => {
    try {
      await A.post(`appointments/${id}/${action}`, body);
      toast('Fait ✔');
      t.reload();
    } catch (e) {
      toast(errText(e), 'bad');
    }
  };
  if (t.loading) return <Skeleton n={5} />;
  if (t.error) return <div className="note bad">{errText(t.error)}</div>;
  const d = t.data;
  const c = d.counts ?? {};
  return (
    <>
      <div className="spread mb">
        <h2 className="mb0">
          {new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}
        </h2>
        <button className="btn ghost sm" onClick={t.reload}>
          rafraîchir
        </button>
      </div>
      <div className="grid g4 mb">
        {[
          ['RDV', c.total, `${c.active} actifs`],
          ['CA du jour', c.revenueCents ? eur(c.revenueCents) : '0 €', `prévus ${c.expectedCents ? eur(c.expectedCents) : '0 €'}`],
          ['À confirmer', c.needsConfirm ?? 0, 'relances auto'],
          ['En attente', c.walkins ?? 0, 'sans RDV'],
          ['Retards', c.lateMinutes ?? 0, 'dépassent sur le suivant'],
          ['Waitlist', d.waitlist ?? 0, 'dans la file'],
        ].map(([l, v, s]: any) => (
          <div className="tile" key={l}>
            <span className="mut xs">{l}</span>
            <b>{v}</b>
            <span className="mut xs" style={{ display: 'block' }}>
              {s}
            </span>
          </div>
        ))}
      </div>

      {d.next && (
        <Card className="hl mb">
          <div className="spread">
            <div>
              <span className="tiny gold">Prochain client</span>
              <h3 className="mb0" style={{ marginTop: 4 }}>
                {d.next.name} — {d.next.service} ({d.next.staff})
              </h3>
              <span className="mut sm">{d.next.when}</span>
            </div>
            <a className="btn sm" href={`tel:${d.next.phone}`}>
              Appeler
            </a>
          </div>
        </Card>
      )}

      {(pick(d.tasks, ['items', 'tasks', 'pending']).length > 0 || d.tasks?.pending > 0) && (
        <Card className="mb">
          <h4>À valider (les actions destructives passent par toi)</h4>
          {pick(d.tasks, ['items', 'tasks']).map((x: any) => (
            <div className="item" key={x.id}>
              <span>
                <b style={{ fontWeight: 600 }}>{x.label ?? x.title ?? x.kind}</b>
                <span className="mut xs" style={{ display: 'block' }}>{x.detail ?? x.reason ?? ''}</span>
              </span>
              <span className="row" style={{ gap: 6 }}>
                <button className="btn sm" onClick={() => A.post(`tasks/${x.id}/approve`, {}).then(t.reload)}>
                  OK
                </button>
                <button className="btn ghost sm" onClick={() => A.post(`tasks/${x.id}/decline`, {}).then(t.reload)}>
                  non
                </button>
              </span>
            </div>
          ))}
        </Card>
      )}

      <Card>
        <div className="spread" style={{ marginBottom: 8 }}>
          <h4 style={{ margin: 0 }}>Agenda</h4>
          <span className="mut xs">{d.realtime?.conversion ?? 0} % de conversion sur 7 j</span>
        </div>
        <div className="tx" tabIndex={0} role="region" aria-label="Tableau — défilement horizontal"><table className="t">
          <thead>
            <tr>
              <th>Heure</th>
              <th>Client</th>
              <th>Prestation</th>
              <th>Barbier</th>
              <th>Statut</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(d.agenda ?? []).map((a: any) => (
              <tr key={a.id}>
                <td className="nowrap">
                  {time(a.start)}
                  {a.late && <span className="badge no_show" style={{ marginLeft: 6 }}>retard</span>}
                </td>
                <td>
                  <b style={{ fontWeight: 600 }}>
                    {a.firstName} {a.lastName}
                  </b>
                  <span className="mut xs" style={{ display: 'block' }}>
                    <a className="link" href={`tel:${a.phone}`}>{a.phone}</a>
                  </span>
                </td>
                <td>
                  {a.service}
                  <span className="mut xs" style={{ display: 'block' }}>{a.durationMin} min · {eur(a.priceCents)}</span>
                </td>
                <td>
                  <span className="dot" style={{ background: a.color, marginRight: 6 }} />
                  {a.staff}
                </td>
                <td>
                  <span className={`badge ${a.status}`}>{label(a.status)}{a.confirmRequired && !a.confirmed ? ' · à conf.' : ''}</span>
                </td>
                <td className="right nowrap">
                  {(!a.confirmed && a.confirmRequired) && <button className="btn sm" onClick={() => act(a.id, 'confirm')}>confirmer</button>}{' '}
                  {a.status !== 'completed' && a.status !== 'cancelled' && (
                    <>
                      <button className="btn ghost sm" onClick={() => act(a.id, 'complete', {})}>terminé</button>{' '}
                      <button className="btn ghost sm" onClick={() => act(a.id, 'no-show')}>no-show</button>{' '}
                      <button className="btn ghost sm" onClick={() => act(a.id, 'remind')}>rappel</button>{' '}
                      <button className="btn danger sm" onClick={() => act(a.id, 'cancel', { reason: 'staff' })}>annuler</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {!(d.agenda ?? []).length && (
              <tr>
                <td colSpan={6} className="mut">
                  Journée vide — <Link className="link" to="/book">réserver un créneau test</Link>.
                </td>
              </tr>
            )}
          </tbody>
        </table></div>
      </Card>

      <div className="grid g3 mt">
        {(d.freePerStaff ?? []).map((f: any) => (
          <div className="tile" key={f.staffId ?? f.staff?.id}>
            <span className="mut xs">{f.staff?.name ?? f.name ?? 'Barbier'}</span>
            <b>{f.free ?? f.freeMin ?? 0} min</b>
            <span className="mut xs" style={{ display: 'block' }}>libres aujourd’hui</span>
          </div>
        ))}
      </div>
    </>
  );
}

const label = (s: string) =>
  ({ booked: 'réservé', confirmed: 'confirmé', pending_payment: 'acompte', held: 'retenu', waiting_client: 'attendu', in_progress: 'en cours', completed: 'terminé', cancelled: 'annulé', no_show: 'no-show' }[s] ?? s);

/* ───────────────────────── PLANNING ───────────────────────── */
function Planning() {
  const toast = useToast();
  const [day, setDay] = useState<string>(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date()));
  const cal = useAsync(() => A.get('calendar', { date: day, days: 7 }), [day]);
  const cfg = useConfig().cfg;
  const [quick, setQuick] = useState<any>(null);
  const [block, setBlock] = useState<any>(null);
  if (cal.loading && !cal.data) return <Skeleton n={4} />;
  const data = cal.data;
  const d0 = (data?.days ?? []).find((x: any) => x.day === day) ?? (data?.days ?? [])[0];

  const strip = (data?.days ?? []).map((x: any) => ({ value: x.day, label: `${x.weekday} ${x.label}`, hint: `${x.total} rdv` }));

  return (
    <>
      <div className="spread mb">
        <h2 className="mb0">Planning</h2>
        <div className="row">
          <button className="btn ghost sm" onClick={() => setBlock({ day })}>
            bloquer une plage
          </button>
          <button className="btn sm" onClick={() => setQuick({ day })}>
            réserver pour un client
          </button>
        </div>
      </div>
      <Seg label="Jour" value={d0?.day} options={strip} tone="plain" onChange={(v) => setDay(String(v))} />

      <div className="card mt" style={{ overflowX: 'auto' }}>
        {!d0 ? (
          <p className="mut mb0">Chargement…</p>
        ) : (
          <div style={{ minWidth: 640 }}>
            {(d0.perStaff ?? []).map((ps: any) => (
              <div key={ps.staff.id} style={{ marginBottom: 14 }}>
                <div className="spread" style={{ marginBottom: 6 }}>
                  <b style={{ fontWeight: 650 }}>
                    <span className="dot" style={{ background: ps.staff.color_hex, display: 'inline-block', marginRight: 7 }} />
                    {ps.staff.name}
                  </b>
                  <span className="mut xs">
                    {ps.appointments.length} rdv · {ps.deadMinutes ?? 0} min de trous · {ps.usable ?? 0} créneaux encaissables
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(64, 1fr)', gap: 1, height: 26 }}>
                  {Array.from({ length: 64 }, (_, i) => {
                    const start = 9 * 60 + i * 10 + 30;
                    const ts = new Date(`${d0.day}T00:00:00+01:00`).getTime() + start * 60_000;
                    const appt = ps.appointments.find((a: any) => a.start === ts);
                    const inBusy = ps.appointments.some((a: any) => ts >= a.start && ts < a.end);
                    const isFree = (ps.free ?? []).includes(ts);
                    const blocked = (d0.blocks ?? []).some((b: any) => ts >= b.start && ts < b.end && (b.staffId == null || b.staffId === ps.staff.id));
                    return (
                      <button
                        key={i}
                        title={appt ? `${time(appt.start)} ${appt.firstName} ${appt.lastName}` : blocked ? 'bloqué' : isFree ? `libre ${String(Math.floor(start / 60)).padStart(2, '0')}:${start % 60}` : 'hors créneau'}
                        onClick={() => (appt ? setQuick({ id: appt.id, start: appt.start, staffId: ps.staff.id, serviceId: appt.serviceId }) : isFree ? setQuick({ start: ts, staffId: ps.staff.id }) : undefined)}
                        className={`cell ${appt ? 'bus' : blocked ? 'block' : inBusy ? 'busy' : ''}`}
                        style={{ background: appt ? 'rgba(232,201,138,.28)' : blocked ? 'rgba(239,122,109,.16)' : isFree ? 'rgba(255,255,255,.035)' : 'transparent', border: 'none', height: 26, cursor: appt || isFree ? 'pointer' : 'default', padding: 0, borderRadius: 4 }}
                      />
                    );
                  })}
                </div>
                <div className="row xs mut" style={{ marginTop: 6 }}>
                  <span>9h30</span>
                  <span style={{ marginLeft: 'auto' }}>20h00</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal open={!!quick} onClose={() => setQuick(null)} title={quick?.id ? 'Déplacer / régler' : 'Créer un créneau'}>
        {quick && (
          <QuickForm
            day={quick.day ?? day}
            staff={(cfg?.staff ?? []).map((s: any) => ({ value: s.id, label: s.name }))}
            services={(cfg?.services ?? []).map((s: any) => ({ value: s.offeringId, label: `${s.name} · ${eur(s.priceCents)}` }))}
            initial={quick}
            onGo={async (v: any) => {
              try {
                if (quick.id) await A.post(`appointments/${quick.id}/move`, { start: v.start, staffId: v.staffId, offeringId: v.offeringId });
                else await A.post('appointments', v);
                toast('Planning mis à jour ✔');
                setQuick(null);
                cal.reload();
              } catch (e) {
                toast(errText(e), 'bad');
              }
            }}
          />
        )}
      </Modal>

      <Modal open={!!block} onClose={() => setBlock(null)} title="Bloquer une plage">
        {block && (
          <form
            className="col"
            style={{ gap: 0 }}
            onSubmit={async (e: any) => {
              e.preventDefault();
              const f = new FormData(e.target);
              const mk = (s: any) => new Date(`${day}T${String(s).padStart(5, '0')}:00+01:00`).getTime();
              try {
                await A.post('blocks', { day, start: mk(f.get('from')), end: mk(f.get('to')), kind: String(f.get('kind')), reason: String(f.get('reason') ?? ''), staffId: Number(f.get('staffId')) || undefined });
                toast('Plage bloquée — la disponibilité a été recalculée.');
                setBlock(null);
                cal.reload();
              } catch (err2) {
                toast(errText(err2), 'bad');
              }
            }}
          >
            <div className="grid g2">
              <Field label="De">
                <input name="from" type="time" defaultValue="12:00" required />
              </Field>
              <Field label="À">
                <input name="to" type="time" defaultValue="13:00" required />
              </Field>
            </div>
            <div className="grid g2">
              <Field label="Motif">
                <select name="kind" defaultValue="break">
                  <option value="break">pause</option>
                  <option value="training">formation</option>
                  <option value="leave">absence</option>
                  <option value="private">réservé / privé</option>
                  <option value="closed">fermé</option>
                </select>
              </Field>
              <Field label="Barbier">
                <select name="staffId" defaultValue="">
                  <option value="">Toute l’équipe</option>
                  {(cfg?.staff ?? []).map((s: any) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Note (facultatif)">
              <input name="reason" maxLength={140} placeholder="Formation couleur avec Rayan" />
            </Field>
            <button className="btn block">Bloquer</button>
          </form>
        )}
      </Modal>
    </>
  );
}

function QuickForm({ day, staff, services, initial, onGo }: any) {
  const [v, setV] = useState<any>({ start: initial.start ?? null, staffId: initial.staffId ?? staff[0]?.value, offeringId: initial.offeringId ?? services[0]?.value, firstName: '', phone: '', priceCents: null });
  const [startStr, setStartStr] = useState(initial.start ? new Date(initial.start).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '10:00');
  const av = useAsync(() => fetch('/api/public/availability?' + new URLSearchParams({ service: 'coupe-homme', days: '1', date: day })).then((r) => r.json()), [day]);
  return (
    <form
      className="col"
      style={{ gap: 0 }}
      onSubmit={(e) => {
        e.preventDefault();
        const ts = v.start ?? new Date(`${day}T${startStr}:00+01:00`).getTime();
        onGo({ ...v, day, start: ts });
      }}
    >
      <Field label="Jour">
        <input type="date" value={day} onChange={(e) => e.preventDefault()} readOnly />
      </Field>
      <div className="grid g2">
        <Field label="Heure">
          <input list="slotsfree" value={startStr} onChange={(e) => { setStartStr(e.target.value); setV({ ...v, start: null }); }} />
          <datalist id="slotsfree">
            {(av.data?.days?.[0]?.slots ?? []).map((s: any) => (
              <option key={s.ts} value={s.time} />
            ))}
          </datalist>
        </Field>
        <Field label="Barbier">
          <select value={v.staffId} onChange={(e) => setV({ ...v, staffId: Number(e.target.value) })}>
            {staff.map((o: any) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Prestation">
        <select value={v.offeringId} onChange={(e) => setV({ ...v, offeringId: Number(e.target.value) })}>
          {services.map((o: any) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      {!initial.id && (
        <div className="grid g2">
          <Field label="Client">
            <input value={v.firstName} onChange={(e) => setV({ ...v, firstName: e.target.value })} placeholder="Prénom" required minLength={2} />
          </Field>
          <Field label="Téléphone">
            <input value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} placeholder="06…" required />
          </Field>
        </div>
      )}
      <button className="btn block">{initial.id ? 'Déplacer' : 'Placer au planning'}</button>
    </form>
  );
}

/* ───────────────────────── FILES ───────────────────────── */
function Queue() {
  const toast = useToast();
  const q = useAsync(() => A.get('queue'), []);
  if (q.loading && !q.data) return <Skeleton n={3} />;
  const cols = [
    ['REQUIRES_ACTION', 'À traiter'],
    ['NEW_REQUEST', 'Demandes'],
    ['WAITLIST', 'Créneaux retenus'],
    ['CONFIRMED', 'Confirmés'],
    ['BOOKED', 'À confirmer'],
  ];
  return (
    <>
      <div className="spread mb">
        <h2 className="mb0">Files</h2>
        <button className="btn ghost sm" onClick={q.reload}>
          rafraîchir
        </button>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))' }}>
        {cols.map(([k, title]) => {
          const rows = q.data?.[k] ?? [];
          return (
            <div key={k} className="card flat">
              <div className="spread" style={{ marginBottom: 8 }}>
                <h4 style={{ margin: 0 }}>{title}</h4>
                <Chip>{rows.length}</Chip>
              </div>
              <div className="col" style={{ gap: 8 }}>
                {rows.map((a: any) => (
                  <div className="tile" key={a.id}>
                    <b style={{ fontWeight: 600 }}>
                      {a.firstName} {a.lastName}
                    </b>
                    <span className="mut xs" style={{ display: 'block' }}>
                      {time(a.start)} {when(a.start).split(',').slice(1).join(',')} · {a.service}
                    </span>
                    {a.expires && <span className="badge held">expire {time(a.expires)}</span>}
                    <div className="row" style={{ marginTop: 8, gap: 6 }}>
                      <button className="btn sm" onClick={() => A.post(`appointments/${a.id}/confirm`, {}).then(() => { toast('Confirmé'); q.reload(); })}>
                        confirmer
                      </button>
                      <button className="btn ghost sm" onClick={() => A.post(`appointments/${a.id}/remind`, {}).then(() => { toast('Rappel envoyé'); })}>
                        relancer
                      </button>
                      <button className="btn danger sm" onClick={() => A.post(`appointments/${a.id}/cancel`, { reason: 'staff' }).then(() => { toast('Annulé — créneau republié'); q.reload(); })}>
                        libérer
                      </button>
                    </div>
                  </div>
                ))}
                {!rows.length && <span className="mut xs">Rien ici — l'automatisation a tout pris.</span>}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ───────────────────────── WAITLIST ───────────────────────── */
function WaitlistAdmin() {
  const toast = useToast();
  const w = useAsync(() => A.get('waitlist'), []);
  if (w.loading && !w.data) return <Skeleton n={3} />;
  const rows = pick(w.data, ['entries', 'rows', 'items', 'list']);
  return (
    <>
      <h2 className="mb">Waitlist</h2>
      <div className="grid g4 mb">
        {[['En file', w.data?.active ?? rows.length], ['Offertes', w.data?.offersSent ?? w.data?.notified ?? '—'], ['Converties', w.data?.converted ?? '—'], ['Récupération', w.data?.recoveryRate ? `${w.data.recoveryRate}%` : '—']].map(([l, v]: any) => (
          <div className="tile" key={l}>
            <span className="mut xs">{l}</span>
            <b>{v}</b>
          </div>
        ))}
      </div>
      <Card>
        <div className="tx" tabIndex={0} role="region" aria-label="Tableau — défilement horizontal"><table className="t">
          <thead>
            <tr>
              <th>Client</th>
              <th>Demande</th>
              <th>Priorité</th>
              <th>Offres</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e: any) => (
              <tr key={e.id}>
                <td>
                  <b style={{ fontWeight: 600 }}>{e.name ?? `${e.first_name} ${e.last_name ?? ''}`}</b>
                  <span className="mut xs" style={{ display: 'block' }}>
                    <a className="link" href={`tel:${e.phone}`}>{e.phone}</a>
                  </span>
                </td>
                <td>
                  {e.service ?? e.service_name ?? 'souple'}
                  <span className="mut xs" style={{ display: 'block' }}>{(e.days ?? []).length ? `${(typeof e.days === 'string' ? JSON.parse(e.days || '[]') : e.days).join(', ')}` : 'tous jours'} · {e.window_label ?? 'horaires souples'}</span>
                </td>
                <td>{e.priority}</td>
                <td>{e.notified_count ?? e.notified ?? 0}</td>
                <td className="right nowrap">
                  <button className="btn ghost sm" onClick={() => A.post(`waitlist/${e.id}/notify`, {}).then(() => { toast('Offre envoyée'); w.reload(); })}>
                    proposer un créneau
                  </button>{' '}
                  <button className="btn ghost sm" onClick={() => A.post(`waitlist/${e.id}/promote`, {}).then(() => { toast('Priorité augmentée'); w.reload(); })}>
                    booster
                  </button>{' '}
                  <button className="btn danger sm" onClick={() => A.post(`waitlist/${e.id}/close`, {}).then(() => { toast('Sorti de la file'); w.reload(); })}>
                    fermer
                  </button>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={5} className="mut">
                  Personne en attente. La file se remplit automatiquement depuis le site.
                </td>
              </tr>
            )}
          </tbody>
        </table></div>
      </Card>
    </>
  );
}
