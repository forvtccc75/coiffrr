import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { apptAction, apptView, availability, claimOffer, declineOffer, joinWaitlist, loadCfg, reviewView, submitReview, track, useConfig, waitlistStatus, api, eur } from '../lib/api';
import { Card, Check, Chip, Countdown, Field, Seg, Skeleton, errCode, errText, useAsync, useToast } from '../lib/ui';

/* ══════════════════ WAITLIST ══════════════════ */
export function WaitlistPage() {
  const { cfg, error, reload } = useConfig();
  const [params] = useSearchParams();
  const token = params.get('token');
  // `location` n'existe pas au rendu serveur (pré-rendu) : sans ce garde-fou, la page entière
  // partait en erreur d'hydratation et le HTML livré aux moteurs était vide.
  const pathname = typeof location === 'undefined' ? '/waitlist' : location.pathname;
  if (params.get('claim') || pathname.includes('reserver')) return <Claim token={token ?? ''} />;
  if (pathname.includes('refuser')) return <Decline token={token ?? ''} />;
  if (token) return <Track token={token} />;
  if (error) return <div className="wrap pad"><h1>Liste d’attente temporairement inaccessible</h1><p>Impossible de charger le salon. Réessaie ou appelle-nous.</p><button className="btn" onClick={() => void reload().catch(() => undefined)}>Réessayer</button> <a className="btn ghost" href="tel:+33644048385">Appeler le salon</a></div>;
  if (!cfg) return <div className="wrap pad"><h1>Liste d’attente</h1><p>Chargement…</p><Skeleton n={3} /></div>;
  if (!cfg.features?.waitlist) return <div className="wrap pad"><h1>Liste d’attente désactivée</h1><p>Contacte le salon pour ta demande.</p><a className="btn" href="tel:+33644048385">Appeler le salon</a></div>;
  return <Join cfg={cfg} services={cfg?.services ?? []} initial={(params.get('service') ?? null) as string} />;
}

function Join({ cfg, services, initial }: any) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', phone: '', email: '', serviceKey: services.some((s: any) => s.key === initial) ? initial : '', staffSlug: '', note: '' });
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5, 6]);
  const [part, setPart] = useState<'any' | 'am' | 'pm' | 'soir'>('any');
  const [flex, setFlex] = useState({ otherStaff: true, otherDays: true, sameDayOtherTime: true });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const nextFree = useAsync(() => (services.length && cfg.staff?.length ? availability({ service: form.serviceKey || services[0].key, days: 14 }) : Promise.resolve(null)), [form.serviceKey, !!cfg]);

  useEffect(() => track('waitlist_view', '/waitlist'), []);

  const preparing = !services.length || !cfg.staff?.length;
  if (out?.alreadyExists && !out.token) return <div className="wrap pad" style={{ maxWidth: 620 }}><h1>Une demande existe déjà</h1><p>{out.message}</p><p className="mut">Si tu as reçu un e-mail de suivi, utilise son lien. Le salon peut aussi retrouver ta demande.</p><a className="btn" href="tel:+33644048385">Appeler le salon</a></div>;
  if (out)
    return (
      <div className="wrap pad center" style={{ maxWidth: 620 }}>
        <h1>{out.alreadyExists ? 'Ta demande est déjà enregistrée' : 'Tu es dans la file ✔'}</h1>
        <p className="lead" style={{ margin: '0 auto 16px' }}>
          Position indicative <b>{out.position?.rank}</b> sur {out.position?.total}. Ce n’est pas encore un rendez-vous. Si un créneau compatible est proposé, tu pourras le confirmer depuis ton suivi ou le message envoyé par un canal activé par le salon.
        </p>
        <Card className="hl">
          <p className="sm mb0">
            Garde ce lien pour suivre ta place (et te retirer) :
            <br />
            <code style={{ wordBreak: 'break-all', fontSize: 12 }}>{typeof location === 'undefined' ? '' : location.origin}/waitlist?token={out.token}</code>
          </p>
          <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
            <a className="btn ghost sm" href={out.manageUrl}>
              Ouvrir le suivi
            </a>
            <Link className="btn sm" to="/book">
              Réserver quand même un autre créneau
            </Link>
          </div>
        </Card>
      </div>
    );

  const total = nextFree.data?.summary?.totalCount ?? 0;
  return (
    <div className="wrap pad" style={{ maxWidth: 720 }}>
      <h1>{preparing ? 'Être prévenu de l’ouverture du planning' : 'La liste d’attente du salon'}</h1>
      <p className="mut">
        {preparing ? 'Le catalogue est en préparation. Tu peux déjà laisser une demande générale. Aucun tarif, créneau ni délai ne t’est promis.' : nextFree.loading ? 'Recherche des disponibilités…' : nextFree.error ? 'Les disponibilités ne peuvent pas être vérifiées pour le moment. Tu peux laisser ta demande ou réessayer.' : total > 0 ? `Il reste ${total} créneau(x) libre(s) dans les 14 jours — tu peux réserver tout de suite.` : 'Aucun créneau disponible dans la période consultée. Laisse tes préférences : une place peut se libérer.'}
      </p>
      {nextFree.error && <button className="btn ghost sm mb" onClick={nextFree.reload}>Réessayer les disponibilités</button>}
      {total > 0 && (
        <div className="row" style={{ marginBottom: 14 }}>
          <Link className="btn" to={`/book?service=${form.serviceKey || 'coupe-homme'}`}>
            Réserver un des créneaux libres
          </Link>
          <span className="mut xs">…ou rejoins la file pour l’horaire que tu veux vraiment.</span>
        </div>
      )}

      <Card className="hl">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr(null);
            try {
              const window: number[] | undefined = part === 'am' ? [0, 720] : part === 'pm' ? [720, 1020] : part === 'soir' ? [1020, 1440] : undefined;
              const res = await joinWaitlist({
                name: `${form.name}`.trim(),
                phone: form.phone.trim(),
                email: form.email.trim() || undefined,
                serviceKey: form.serviceKey || undefined,
                staffSlug: form.staffSlug || undefined,
                days,
                window,
                flex,
                note: form.note || undefined,
                consent,
              });
              setOut(res);
            } catch (e2) {
              setErr(e2);
              if (errCode(e2) === 'too_many') setErr(new Error('Tu as déjà une demande en cours — utilise le lien de suivi.'));
            } finally {
              setBusy(false);
            }
          }}
          className="col"
          style={{ gap: 2 }}
        >
          <div className="grid g2">
            <Field label="Prénom et nom">
              <input required minLength={2} maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" />
            </Field>
            <Field label="Téléphone" hint="Pour te joindre au sujet de cette demande.">
              <input required type="tel" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="06 12 34 56 78" autoComplete="tel" />
            </Field>
          </div>
          <Field label="E-mail (facultatif)" hint="Conseillé : les propositions peuvent être envoyées par e-mail.">
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" />
          </Field>
          <div className="grid g2">
            <Field label="Prestation">
              <select value={form.serviceKey} onChange={(e) => setForm({ ...form, serviceKey: e.target.value })}>
                <option value="">Peu importe</option>
                {services.map((s: any) => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Barbier">
              <select value={form.staffSlug} onChange={(e) => setForm({ ...form, staffSlug: e.target.value })}>
                <option value="">Peu importe</option>
                {(cfg?.staff ?? []).map((s: any) => (
                  <option key={s.slug} value={s.slug}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Quels jours ?">
            <div className="row" style={{ gap: 6 }}>
              {[
                [1, 'Lun'],
                [2, 'Mar'],
                [3, 'Mer'],
                [4, 'Jeu'],
                [5, 'Ven'],
                [6, 'Sam'],
                [0, 'Dim'],
              ].map(([d, l]) => (
                <button
                  type="button"
                  key={d}
                  className={`chip ${days.includes(d as number) ? 'gold' : ''}`}
                  style={{ cursor: 'pointer', background: 'none' }}
                  aria-pressed={days.includes(d as number)}
                  onClick={() => setDays((x) => (x.includes(d as number) ? x.filter((y) => y !== d) : [...x, d as number]))}
                >
                  {l}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Quel moment de la journée ?">
            <Seg label="Moment" value={part} options={[{ value: 'any', label: 'Indifférent' }, { value: 'am', label: 'Matin' }, { value: 'pm', label: 'Après-midi' }, { value: 'soir', label: 'Soir' }]} onChange={(v) => setPart(v as any)} />
          </Field>
          <Field label="Flexibilité">
            <Check label="Un autre barbier me va" checked={flex.otherStaff} onChange={(v) => setFlex({ ...flex, otherStaff: v })} />
            <Check label="Un autre jour me va" checked={flex.otherDays} onChange={(v) => setFlex({ ...flex, otherDays: v })} />
            <Check label="Une autre heure le même jour me va" checked={flex.sameDayOtherTime} onChange={(v) => setFlex({ ...flex, sameDayOtherTime: v })} />
            <p className="mut xs mb0">Plus tu es flexible, plus tu passes vite : le scoring est transparent, aucun tirage au sort.</p>
          </Field>
          <Field label="À préciser (facultatif)">
            <textarea maxLength={400} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Ex : je peux seulement après 18h, je viens avec mon fils…" />
          </Field>
          <Check
            label="J'accepte d'être contacté par e-mail ou SMS pour cette demande."
            checked={consent}
            onChange={setConsent}
            hint="Uniquement pour ce créneau, jamais de démarchage. Retirable en 1 clic."
          />
          {err && <div className="note bad">{errText(err)}</div>}
          <button className="btn lg block" disabled={busy || !consent || !days.length}>
            {busy ? '…' : preparing ? 'Enregistrer ma demande' : 'Me prévenir dès qu’un créneau se libère'}
          </button>
        </form>
      </Card>
    </div>
  );
}

function Track({ token }: { token: string }) {
  const { data, loading, error, reload } = useAsync(() => waitlistStatus(token), [token]);
  const toast = useToast();
  if (loading) return <div className="wrap pad"><Skeleton n={3} /></div>;
  if (error) return <div className="wrap pad"><div className="note bad">{errText(error)}</div></div>;
  const e = data?.entry;
  return (
    <div className="wrap pad" style={{ maxWidth: 620 }}>
      <h1>Ta demande</h1>
      <Card className="hl">
        <div className="spread">
          <div>
            <b style={{ fontSize: 18 }}>{e?.service ?? 'Créneau au choix'}</b>
            <p className="mut sm mb0">
              {e?.staff ? `avec ${e.staff} · ` : ''}
              {(e?.days ?? []).length ? `${e.days.length} jour(s) cochés` : 'tous les jours'}
            </p>
          </div>
          <Chip tone={e?.status === 'active' ? 'ok' : ''}>{e?.status === 'active' ? 'en file' : e?.status === 'fulfilled' ? 'réservé' : e?.status === 'withdrawn' ? 'demande retirée' : e?.status === 'closed' ? 'fermée' : e?.status}</Chip>
        </div>
        <div className="hr" />
        <p className="mut xs">La position est indicative : la proposition dépend aussi des jours, horaires et barbiers compatibles.</p>
        <div className="grid g3">
          <div>
            <span className="mut xs">Position</span>
            <b style={{ display: 'block', fontSize: 22 }}>{data?.position?.rank ?? '—'}</b>
          </div>
          <div>
            <span className="mut xs">Dans la file</span>
            <b style={{ display: 'block', fontSize: 22 }}>{data?.position?.total ?? '—'}</b>
          </div>
          <div>
            <span className="mut xs">Offres reçues</span>
            <b style={{ display: 'block', fontSize: 22 }}>{e?.notified ?? 0}</b>
          </div>
        </div>
        {(data?.offers ?? []).length > 0 && (
          <>
            <div className="hr" />
            <h4>Dernières propositions</h4>
            {data.offers.slice(0, 3).map((o: any, i: number) => (
              <div className="item" key={i}>
                <span>
                  <b style={{ fontWeight: 600 }}>{new Date(o.start).toLocaleString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</b>
                  <span className="mut xs" style={{ display: 'block' }}>
                    {o.status === 'pending' && o.expires > Date.now() ? (
                      <>
                        expire dans <Countdown to={o.expires} />
                      </>
                    ) : o.status === 'pending' ? 'expirée' : o.status}
                  </span>
                </span>
                {o.status === 'pending' && o.expires > Date.now() ? (
                  <a className="btn sm" href={`/waitlist/reserver?token=${o.token}`}>
                    Réserver
                  </a>
                ) : (
                  <Chip tone={o.status === 'claimed' ? 'ok' : 'bad'}>{o.status === 'claimed' ? 'réservé' : 'expirée'}</Chip>
                )}
              </div>
            ))}
          </>
        )}
      </Card>
      <div className="row" style={{ marginTop: 12 }}>
        <button
          className="btn ghost sm" disabled={e?.status !== 'active'}
          onClick={async () => {
            try { await apptAction('waitlist/cancel', { token }); toast('Demande retirée de la file.'); reload(); } catch (err) { toast(errText(err), 'bad'); }
          }}
        >
          {e?.status === 'active' ? 'Me retirer de la waitlist' : 'Demande traitée'}
        </button>
        <Link className="link sm" to="/book">
          réserver maintenant
        </Link>
      </div>
    </div>
  );
}

function Claim({ token }: { token: string }) { return <OfferAction token={token} decline={false} />; }
function Decline({ token }: { token: string }) { return <OfferAction token={token} decline />; }
/** Une ouverture de lien (y compris par un scanner e-mail) ne réserve ni n'annule rien. */
function OfferAction({ token, decline }: { token: string; decline: boolean }) {
  const preview = useAsync(() => api('/api/public/waitlist/offer?token=' + encodeURIComponent(token)), [token]);
  const [out, setOut] = useState<any>(null);
  const [error, setError] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  if (preview.loading) return <div className="wrap pad"><h1>Chargement de la proposition…</h1><Skeleton n={2} /></div>;
  if (out?.ok) return <div className="wrap pad center" style={{ maxWidth: 660 }}><h1>{decline ? 'Proposition refusée' : 'Créneau réservé ✔'}</h1><p>{decline ? 'Tu restes en attente pour une prochaine proposition. Aucun autre rendez-vous n’a été annulé.' : 'Ton rendez-vous est confirmé. Garde ton lien de gestion.'}</p>{out.manageToken && <a className="btn" href={`/rdv/${out.appointmentId}?token=${out.manageToken}`}>Voir mon rendez-vous</a>} <Link className="btn ghost" to="/book">Voir les disponibilités</Link></div>;
  const p = preview.data;
  const available = p && ((p.status === 'pending' && !p.expired) || (!decline && p.status === 'claimed'));
  return <div className="wrap pad" style={{ maxWidth: 660 }}><h1>{preview.error ? 'Proposition inaccessible' : available ? decline ? 'Refuser cette proposition ?' : p.status === 'claimed' ? 'Rendez-vous déjà réservé' : 'Un créneau pour toi' : 'Cette proposition n’est plus disponible'}</h1>
    {preview.error && <><div className="note bad">{errText(preview.error)}</div><button className="btn ghost" onClick={preview.reload}>Réessayer</button></>}
    {p && <Card><h3>{p.service}</h3><p>{new Date(p.start).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} · {p.staff}</p>{p.priceCents != null && <p>{eur(p.priceCents)} — règlement sur place</p>}{p.status === 'pending' && !p.expired && <p>Offre valable encore <Countdown to={p.expires} />. Ouvrir cette page ne réserve rien.</p>}</Card>}
    {error && <div className="note bad mt">{errText(error)}</div>}
    {available && <button className="btn mt" disabled={busy} onClick={async () => { setBusy(true); setError(null); try { const result = await (decline ? declineOffer(token) : claimOffer(token)); if (!result.ok) throw new Error(result.message || 'Cette proposition n’est plus disponible.'); setOut(result); } catch (e) { setError(e); } finally { setBusy(false); } }}>{busy ? 'Traitement…' : decline ? 'Refuser ce créneau uniquement' : p.status === 'claimed' ? 'Ouvrir mon rendez-vous' : 'Confirmer ce rendez-vous'}</button>}
    <p className="mt"><Link className="link" to="/book">Voir les autres disponibilités</Link></p>
  </div>;
}

/* ══════════════════ PAGE RENDEZ-VOUS (lien signé) ══════════════════ */
export function Appt() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const p = typeof location === 'undefined' ? '' : location.pathname;
  const mode = p.endsWith('/annuler') ? 'cancel' : p.endsWith('/decaler') ? 'move' : 'view';
  const { data, loading, error, reload } = useAsync(() => apptView(token), [token]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [resched, setResched] = useState<any>(null);
  const toast = useToast();
  const a = data?.appointment;

  const av = useAsync(() => (mode === 'move' && a ? availability({ service: a.serviceKey, days: 14 }) : Promise.resolve(null)), [mode, a?.serviceKey]);

  if (loading) return <div className="wrap pad"><Skeleton n={3} /></div>;
  if (error) return <div className="wrap pad" style={{ maxWidth: 560 }}><div className="note bad">{errText(error)}</div><p className="mut sm">Le lien a expiré ? <Link className="link" to="/espace">Reconnecte-toi</Link> ou appelle le 06 44 04 83 85.</p></div>;

  const act = async (path: string, body: any, label: string) => {
    setBusy(true);
    try {
      await apptAction(path, body);
      toast(label);
      reload();
      if (path === 'appointment/cancel') history.replaceState(null, '', `/rdv/${id}?token=${token}`);
    } catch (e: any) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wrap pad" style={{ maxWidth: 620 }}>
      <h1>
        {mode === 'cancel' ? 'Annuler ce rendez-vous ?' : mode === 'move' ? 'Décaler ce rendez-vous' : `Rendez-vous ${a.status === 'cancelled' ? 'annulé' : 'de ' + a.customer?.firstName}`}
      </h1>
      <Card className="hl">
        <div className="spread">
          <div>
            <b style={{ fontSize: 18 }}>{a.service}</b>
            <p className="mut sm mb0">
              {new Date(a.start).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} · {a.durationMin} min
              <br />
              avec {a.staff} · {a.address}
            </p>
          </div>
          <Chip tone={a.status === 'confirmed' ? 'ok' : a.status === 'cancelled' ? 'bad' : 'warn'}>
            {a.status === 'confirmed' ? 'confirmé' : a.status === 'cancelled' ? 'annulé' : a.status === 'booked' ? (a.confirmRequired ? 'à confirmer' : 'réservé') : a.status}
          </Chip>
        </div>
        <div className="hr" />
        <div className="grid g3">
          <div>
            <span className="mut xs">Total</span>
            <b style={{ display: 'block' }}>{new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(a.priceCents / 100)}</b>
          </div>
          <div>
            <span className="mut xs">À régler sur place</span>
            <b style={{ display: 'block' }}>{new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(a.balanceCents / 100)}</b>
          </div>
          <div>
            <span className="mut xs">Annulation</span>
            <b style={{ display: 'block', fontSize: 14 }}>{a.cancelAllowed ? 'libre' : `jusqu'à ${a.cancelCutoffLabel} avant`}</b>
          </div>
        </div>
        {a.confirmRequired && !a.confirmed && (
          <div className="note mt" style={{ marginBottom: 0 }}>
            Confirme pour garder le créneau — sinon on t'appelle la veille.
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn sm" disabled={busy} onClick={async () => { setBusy(true); try { await fetch(data.actions.confirm, { credentials: 'same-origin' }); toast('Confirmé ✔'); reload(); } finally { setBusy(false); } }}>
                Je confirme
              </button>
              <a className="btn ghost sm" href={data.actions.confirm}>
                lien direct
              </a>
            </div>
          </div>
        )}
        {msg && <div className="note bad mt">{msg}</div>}
      </Card>

      {mode === 'cancel' ? (
        <Card className="mt">
          <p className="sm">
            En annulant, le créneau part <b>immédiatement</b> dans la waitlist : un autre client est prévenu dans la minute. Merci de prévenir au plus tôt — c'est ce qui fait marcher le système.
          </p>
          <div className="row">
            <button className="btn danger" disabled={busy} onClick={() => act('appointment/cancel', { token }, 'Rendez-vous annulé')}>
              {busy ? '…' : 'Confirmer l’annulation'}
            </button>
            <Link className="btn ghost" to={`/rdv/${id}?token=${token}`}>
              Finalement non
            </Link>
          </div>
          {!a.cancelAllowed && <p className="mut xs mb0 mt">Attention : à moins de {a.cancelCutoffLabel} du RDV, préviens-nous par téléphone ({cfgPhone()}).</p>}
        </Card>
      ) : mode === 'move' ? (
        <Card className="mt">
          <h4>Nouveau créneau</h4>
          {av.loading ? (
            <Skeleton n={2} />
          ) : (
            <>
              <div className="col" style={{ gap: 8 }}>
                {(av.data?.days ?? [])
                  .filter((d: any) => d.count > 0)
                  .slice(0, 6)
                  .map((d: any) => (
                    <div key={d.day}>
                      <span className="tiny gold">{d.label}</span>
                      <div className="slots">
                        {d.slots.slice(0, 12).map((s: any) => (
                          <button key={s.ts} className={`slot ${resched === s.ts ? 'on' : ''}`} onClick={() => setResched(s.ts)}>
                            {s.time}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
              </div>
              {!(av.data?.days ?? []).some((d: any) => d.count > 0) && (
                <p className="mut sm">
                  Rien de libre dans l'horizon — <Link className="link" to="/waitlist">rejoins la waitlist</Link> ou appelle-nous.
                </p>
              )}
              <button
                className="btn block mt"
                disabled={!resched || busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await apptAction('appointment/reschedule', { token, start: resched });
                    toast('Créneau déplacé ✔');
                    reload();
                    history.replaceState(null, '', `/rdv/${id}?token=${token}`);
                  } catch (e: any) {
                    setMsg(errText(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? '…' : 'Déplacer à cette heure'}
              </button>
            </>
          )}
        </Card>
      ) : (
        <div className="row mt">
          <Link className="btn ghost sm" to={`/rdv/${id}/decaler?token=${token}`}>
            Décaler
          </Link>
          <Link className="btn ghost sm" to={`/rdv/${id}/annuler?token=${token}`}>
            Annuler
          </Link>
          <a className="btn ghost sm" href={data.actions.ics}>
            .ics
          </a>
          {a.status !== 'cancelled' && a.reviewStatus !== 'done' && (
            <Link className="btn sm" to={`/avis/${id}?token=${token}`}>
              Laisser un avis
            </Link>
          )}
        </div>
      )}
      <p className="mut xs mt">Lien personnel et temporaire — ne le transfère pas.</p>
    </div>
  );
}

const cfgPhone = () => '06 44 04 83 85';

/* ══════════════════ AVIS (acheminement éthique) ══════════════════ */
export function Review() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { data } = useAsync(() => apptView(token), [token]);
  const a = data?.appointment;
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [publish, setPublish] = useState(true);
  const [out, setOut] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);

  if (!token)
    return (
      <div className="wrap pad" style={{ maxWidth: 520 }}>
        <div className="note">Donne-nous ton avis depuis le SMS reçu après ta venue : le lien contient la clé qui prouve que tu es passé.</div>
      </div>
    );

  if (out)
    return (
      <div className="wrap pad center" style={{ maxWidth: 560 }}>
        <h1>Merci ✔</h1>
        {out.positive ? (
          <>
            <p className="lead" style={{ margin: '0 auto 14px' }}>
              Ça aide vraiment le salon. Si tu as 20 secondes, publie-le sur Google — c'est le seul endroit où les nouveaux clients regardent.
            </p>

          </>
        ) : (
          <p className="lead" style={{ margin: '0 auto 14px' }}>
            Ton message part directement au patron, en privé. Rien n'est publié — et on te rappelle pour arranger ça.
          </p>
        )}
        {out.googleUrl && <p><a className="btn lg" href={out.googleUrl} target="_blank" rel="nofollow noopener noreferrer">Partager un avis honnête sur Google</a></p>}
        <div className="row" style={{ justifyContent: 'center' }}>
          <Link className="btn ghost" to="/book">
            Rebooker un créneau
          </Link>
        </div>
      </div>
    );

  return (
    <div className="wrap pad" style={{ maxWidth: 560 }}>
      <h1>Comment c'était ?</h1>
      {a && (
        <p className="mut sm">
          {a.service} · {new Date(a.start).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} avec {a.staff}
        </p>
      )}
      <Card className="hl">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr(null);
            try {
              const res = await submitReview({ token, rating: rating ?? undefined, comment: comment.trim() || undefined, consentPublish: publish });
              setOut(res);
            } catch (e2) {
              setErr(e2);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Ta note">
            <div className="row" style={{ gap: 6 }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" className={`slot ${rating === n ? 'on' : ''}`} style={{ width: 54 }} aria-pressed={rating === n} onClick={() => setRating(n)}>
                  {n}★
                </button>
              ))}
            </div>
          </Field>
          <Field label={rating && rating <= 3 ? 'Que s’est-il passé ? (privé, envoyé au patron)' : 'Un mot sur le résultat, l’attente, l’équipe ?'}>
            <textarea maxLength={900} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={rating && rating <= 3 ? 'On lit tout, et on rappelle.' : 'Ex : dégradé nickel, pris à l’heure…'} />
          </Field>
          <Check label="Autoriser la publication de cet avis sur le site du salon" checked={publish} onChange={setPublish} hint="Tu peux dire non : l'avis reste interne, il sert juste à améliorer." />
          {rating && rating <= 3 && <p className="mut xs">Pas de publication automatique des notes basses : c'est un échange avec le salon, pas une mise en avant.</p>}
          {err && <div className="note bad">{errText(err)}</div>}
          <button className="btn block lg" disabled={busy || !rating}>
            {busy ? '…' : 'Envoyer'}
          </button>
        </form>
      </Card>
    </div>
  );
}
