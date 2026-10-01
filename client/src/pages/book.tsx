import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { availability, book, getDraft, parseUtm, readAttribution, saveDraft, track, useConfig } from '../lib/api';
import { Card, Check, Field, Meter, Modal, Seg, Skeleton, errCode, errText, useAsync, useToast } from '../lib/ui';

/**
 * Le moteur de réservation. 3 étapes, 4 champs, mobile first.
 * Toute la logique de disponibilité vient du serveur : ici on n'invente jamais un créneau,
 * on n'affiche jamais « complet » sans porte de sortie, et on ne ment pas sur la rareté.
 */
export function Book() {
  const { cfg, error: configError, reload: reloadConfig } = useConfig();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const services = cfg?.services ?? [];
  const staff = cfg?.staff ?? [];

  const [serviceKey, setServiceKey] = useState<string | null>(null);
  const [addonIds, setAddonIds] = useState<number[]>([]);
  const [staffId, setStaffId] = useState<number | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<{ ts: number; time: string } | null>(null);
  const [step, setStep] = useState(1);
  const [staffSheet, setStaffSheet] = useState(false);
  useEffect(() => { window.scrollTo({ top: 0, behavior: "instant" }); }, [step]);
  const [part, setPart] = useState<'any' | 'am' | 'pm' | 'soir'>('any');
  const [contact, setContact] = useState({ firstName: '', lastName: '', phone: '', email: '', note: '' });
  const [consent, setConsent] = useState({ terms: false, marketingSms: false, marketingEmail: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [done, setDone] = useState<any>(null);
  const [conflict, setConflict] = useState<any[]>([]);
  const draftToken = useRef<string | null>(null);
  const startedAt = useRef(0);
  const [visitor] = useState(() => 'v' + Math.random().toString(36).slice(2, 10));
  const [giftCode, setGiftCode] = useState<string>(params.get('gift') ?? '');

  /* ── entrée : deep links Instagram/TikTok/Google + reprise de brouillon ── */
  useEffect(() => {
    if (!services.length) return;
    parseUtm();
    const s = params.get('service');
    const d = params.get('draft');
    const st = params.get('staff');
    const sl = params.get('slot');
    const svc = services.find((x: any) => x.key === s || String(x.id) === s) ?? null;
    setServiceKey(svc?.key ?? null);
    setStep(svc ? 2 : 1);
    const sid = staff.find((x: any) => x.slug === st)?.id ?? null;
    if (sid) setStaffId(sid);
    if (sl) {
      const ts = Number(sl);
      if (Number.isFinite(ts)) {
        setSlot({ ts, time: new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) });
        setDay(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(ts)));
        setStep(svc ? 3 : 1);
      }
    }
    if (d) {
      getDraft(d)
        .then((dr: any) => {
          const off = services.find((x: any) => x.offeringId === dr.offeringId);
          if (off) setServiceKey(off.key);
          if (dr.staffId) setStaffId(dr.staffId);
          if (dr.addonIds?.length) setAddonIds(dr.addonIds);
          if (dr.slot) {
            setSlot({ ts: dr.slot, time: new Date(dr.slot).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) });
            setDay(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(dr.slot)));
          }
          setContact({ firstName: dr.contact?.firstName ?? '', lastName: dr.contact?.lastName ?? '', phone: dr.contact?.phone ?? '', email: dr.contact?.email ?? '', note: dr.contact?.note ?? '' });
          setConsent((c) => ({ ...c, marketingEmail: !!dr.contact?.marketingEmail }));
          setStep(dr.slot ? 3 : off ? 2 : 1);
          draftToken.current = d;
          toast('Brouillon restauré, on reprend où tu t’es arrêté.');
        })
        .catch(() => undefined);
    }
    startedAt.current = Date.now();
    track('availability_view', '/book', { service: s, staff: st, slot: sl });
  }, [!!cfg, params]);

  // le tunnel d'acquisition n'existait que sur le papier entre « créneau choisi » et « confirmé » :
  // sans cette étape, l'entonnoir du back-office affichait un trou Inventé-par-défaut (estimation).
  useEffect(() => {
    if (step === 3) track('contact_step', '/book', { service: serviceKey });
  }, [step]);

  const service = useMemo(() => services.find((s: any) => s.key === serviceKey) ?? null, [services, serviceKey]);
  const av = useAsync(() => (service ? availability({ service: service.key, days: 14, staff: staffId ? staff.find((s: any) => s.id === staffId)?.slug : undefined }) : Promise.resolve(null)), [service?.key, staffId]);
  const days: any[] = av.data?.days ?? [];
  const selDay = days.find((d) => d.day === day) ?? null;

  const slots = useMemo(() => {
    let s = selDay?.slots ?? [];
    if (part === 'am') s = s.filter((x: any) => new Date(x.ts).getHours() < 13);
    if (part === 'pm') s = s.filter((x: any) => { const h = new Date(x.ts).getHours(); return h >= 13 && h < 17; });
    if (part === 'soir') s = s.filter((x: any) => new Date(x.ts).getHours() >= 17);
    if (staffId) s = s.filter((x: any) => x.staffIds.includes(staffId));
    return s;
  }, [selDay, part, staffId]);

  /* ── autosauvegarde du brouillon (panier abandonné = relance, pas de spam) ── */
  useEffect(() => {
    if (!service || (!slot && !contact.phone)) return;
    const t = setTimeout(() => {
      saveDraft({
        visitorId: visitor,
        offeringId: service.offeringId,
        staffId,
        addonIds,
        slot: slot?.ts,
        step: slot ? 'contact' : 'slot',
        contact: contact.phone || contact.email ? contact : undefined,
        attribution: readAttribution(),
      })
        .then((r: any) => (draftToken.current = r.token ?? draftToken.current))
        .catch(() => undefined);
    }, 900);
    return () => clearTimeout(t);
  }, [service, slot, contact.phone, contact.email, staffId, addonIds.join(',')]);

  useEffect(() => {
    if (selDay && slot && !slots.some((x: any) => x.ts === slot.ts)) setSlot(null);
  }, [part, staffId, selDay]);

  if (configError || (cfg && (!services.length || !staff.length))) return (
    <div className="wrap pad" style={{ maxWidth: 760 }}><p className="kick">Z.YASS · Réservation</p>
      <h1>{configError ? 'Les créneaux ne sont pas accessibles.' : 'La réservation en ligne arrive bientôt.'}</h1>
      <Card><p>{configError ? 'Impossible de charger le planning pour le moment. Réessaie ou contacte directement le salon.' : 'Le salon prépare ses prestations et son équipe. Aucun créneau n’est encore publié : appelle-nous pour prendre rendez-vous.'}</p>
        <div className="row" style={{ flexWrap: 'wrap' }}><a className="btn" href="tel:+33644048385">Appeler le salon</a>
        <button className="btn ghost" onClick={() => void reloadConfig().catch(() => undefined)}>Réessayer</button><Link className="link" to="/infos">Adresse et horaires</Link></div>
      </Card>
    </div>
  );
  if (!cfg)
    return (
      <div className="wrap pad">
        {/* Le titre est posé dès le premier pixel : un rectangle gris sans énoncé n'est pas un
            « chargement », c'est une page blanche qui dure — et un lecteur d'écran n'a rien à lire. */}
        <p className="kick">Z.YASS · Les Pavillons-sous-Bois</p>
        <h1>Réserve ton créneau</h1>
        <p className="mut">Chargement des prestations et des disponibilités réelles…</p>
        <Skeleton h={60} n={4} />
      </div>
    );

  if (done) return <Done res={done} onGoHome={() => nav('/')} />;

  const total = av.data?.summary?.totalCount ?? 0;
  const price = (service?.priceCents ?? 0) + addonIds.reduce((a, id) => a + (cfg.addons.find((x: any) => x.id === id)?.priceCents ?? 0), 0);
  const duration = (service?.durationMin ?? 0) + addonIds.reduce((a, id) => a + (cfg.addons.find((x: any) => x.id === id)?.durationMin ?? 0), 0);
  const deposit = av.data?.policy?.depositText;

  const submit = async () => {
    if (!service || !slot) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await book({
        offeringId: service.offeringId,
        addonIds,
        staffId,
        start: slot.ts,
        visitorId: visitor,
        draftId: undefined,
        customer: { firstName: contact.firstName.trim(), lastName: contact.lastName?.trim() || undefined, phone: contact.phone.trim(), email: contact.email.trim() || undefined, note: contact.note.trim() || undefined },
        consent,
        attribution: readAttribution(),
        paymentMode: 'deposit',
        giftCardCode: giftCode || undefined,
        referrerCode: new URLSearchParams(location.search).get('ref') ?? undefined,
      });
      track('booking_confirmed', '/book', { price: res.priceCents });
      setDone(res);
      window.scrollTo({ top: 0 });
    } catch (e: any) {
      const code = errCode(e);
      if (code === 'creneau_pris' || code === 'slot_trop_proche' || code === 'creneau_reserve') {
        setConflict(e.data?.alternatives ?? []);
        setErr(e);
        setStep(2);
        av.reload();
      } else if (code === 'paiement_echoue') {
        setErr(e);
        setConflict(e.data?.alternatives ?? []);
      } else {
        setErr(e);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wrap pad booking-page" style={{ paddingBottom: 120 }}>
      <ol className="booking-progress" aria-label="Étapes de réservation">
        {['Prestation', 'Créneau', 'Coordonnées'].map((label, i) => <li key={label} className={step >= i + 1 ? 'reached' : ''} aria-current={step === i + 1 ? 'step' : undefined}>
          <button type="button" disabled={i + 1 > step} onClick={() => setStep(i + 1)}><span>{step > i + 1 ? '✓' : i + 1}</span>{label}</button>
        </li>)}
      </ol>

      <div className="split">
        <div className="col" style={{ gap: 14 }}>
          {/* ÉTAPE 1 */}
          {step === 1 && (
            <>
              <h1>Réserve ton créneau</h1>
              <p className="mut">Choisis ta prestation — tu pourras ajouter une option juste après.</p>
              <div className="col" style={{ gap: 8 }}>
                {services.map((s: any) => (
                  <button
                    key={s.key}
                    className={`svc ${serviceKey === s.key ? 'on' : ''}`}
                    onClick={() => {
                      setServiceKey(s.key);
                      setStep(2);
                      track('service_view', '/book', { service: s.key });
                    }}
                  >
                    <span className="ico">{s.name.slice(0, 1)}</span>
                    <span>
                      <b>{s.name}</b>
                      <span className="sub">{s.short ?? `${s.durationMin} min`}</span>
                    </span>
                    <span className="price">{eur(s.priceCents)}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {/* ÉTAPE 2 */}
          {step === 2 && service && (
            <>
              <div className="spread">
                <h2 className="mb0">{service.name}</h2>
                <button className="link sm" onClick={() => setStep(1)}>
                  changer de prestation
                </button>
              </div>
              {service.addons?.length > 0 && (
                <Card>
                  <h4>Options</h4>
                  {service.addons.map((a: any) => {
                    const on = addonIds.includes(a.id);
                    return (
                      <div className="item" key={a.id}>
                        <div>
                          <b style={{ fontWeight: 600 }}>{a.name}</b>
                          <div className="mut xs">{a.hint ?? (a.durationMin ? `+${a.durationMin} min` : 'sans temps additionnel')}</div>
                        </div>
                        <div className="row" style={{ gap: 10 }}>
                          <span className="nowrap sm">{eur(a.priceCents)}</span>
                          <button className={`btn sm ${on ? '' : 'ghost'}`} aria-pressed={on} onClick={() => setAddonIds((x) => (on ? x.filter((i) => i !== a.id) : [...x, a.id]))}>
                            {on ? 'ajoutée' : 'ajouter'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </Card>
              )}

              <div>
                <div className="spread" style={{ marginBottom: 8 }}>
                  <h4 style={{ margin: 0 }}>Barbier</h4>
                  <span className="mut xs">{av.loading ? 'calcul des dispos…' : `${total} créneaux sur 14 jours`}</span>
                </div>
                <button type="button" className="staff-picker mobile-only" aria-haspopup="dialog" onClick={() => setStaffSheet(true)}><span><small>AVEC QUI ?</small><b>{staff.find((s: any) => s.id === staffId)?.name ?? 'Le premier disponible'}</b></span><span aria-hidden="true">⌄</span></button>
                <div className="desktop-only"><Seg
                  label="Choix du barbier"
                  value={staffId ?? 0}
                  options={[{ value: 0, label: 'Peu importe' }, ...staff.map((s: any) => ({ value: s.id, label: s.name, hint: s.title }))]}
                  onChange={(v) => setStaffId(v === 0 ? null : (v as number))}
                /></div>
                <Modal open={staffSheet} title="Choisir ton barbier" onClose={() => setStaffSheet(false)}>
                  <p className="mut sm">Choisis une personne ou laisse le planning te proposer le premier disponible.</p>
                  <div className="col">{[{ id: 0, name: 'Le premier disponible', title: 'Tous les barbiers disponibles' }, ...staff].map((s: any) => <button type="button" className={`svc ${s.id === (staffId ?? 0) ? 'on' : ''}`} key={s.id} aria-pressed={s.id === (staffId ?? 0)} onClick={() => { setStaffId(s.id || null); setStaffSheet(false); }}><span className="ico">{s.id ? s.name.slice(0, 1) : '↗'}</span><span><b>{s.name}</b><span className="sub">{s.title}</span></span><span aria-hidden="true">{s.id === (staffId ?? 0) ? '✓' : ''}</span></button>)}</div>
                </Modal>
              </div>

              <div>
                <h4>Moment de la journée</h4>
                <Seg label="Moment" value={part} options={[{ value: 'any', label: 'Toute la journée' }, { value: 'am', label: 'Matin' }, { value: 'pm', label: 'Après-midi' }, { value: 'soir', label: 'Soir (après 17h)' }]} onChange={(v) => setPart(v as any)} />
              </div>

              <div aria-live="polite" aria-busy={av.loading}>
                <h4>Jour</h4>
                {av.loading && !days.length ? (
                  <Skeleton h={64} n={1} />
                ) : (
                  <div className="days">
                    {days.map((d: any) => (
                      <button key={d.day} className={`day ${day === d.day ? 'on' : ''}`} onClick={() => { setDay(d.day); setSlot(null); track('booking_start', '/book', { day: d.day }); }}>
                        <b>{d.weekday}</b>
                        <span>{d.label}</span>
                        <span style={{ color: d.count ? 'var(--gold)' : 'var(--bad)' }}>{d.count ? `${d.count} créx` : d.closed === 'complet' ? 'complet' : '—'}</span>
                      </button>
                    ))}
                  </div>
                )}

                {selDay && (
                  <>
                    {slots.length > 0 ? (
                      <div className="slots">
                        {slots.map((s: any) => (
                          <button key={s.ts} className={`slot ${slot?.ts === s.ts ? 'on' : ''} ${s.tight ? 'tight' : ''}`} onClick={() => { setSlot({ ts: s.ts, time: s.time }); setErr(null); }}>
                            {s.time}
                            {s.tight && <span className="tag">juste avant la fermeture</span>}
                            {staffId === null && s.staffIds.length === 1 && <span className="tag">{staff.find((x: any) => x.id === s.staffIds[0])?.name}</span>}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <NoSlot day={selDay} data={av.data} serviceKey={service.key} onPick={(ts: number, t: string) => { setSlot({ ts, time: t }); setErr(null); }} />
                    )}
                  </>
                )}

                {!selDay && days.length > 0 && <p className="mut sm">Sélectionne un jour pour voir les heures.</p>}
              </div>

              {conflict.length > 0 && (
                <Card className="hl">
                  <h4 style={{ color: 'var(--gold)' }}>Autres créneaux réellement libres</h4>
                  <div className="col" style={{ gap: 6 }}>
                    {conflict.map((a: any, i: number) => (
                      <button
                        key={i}
                        className="item"
                        style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 10, cursor: 'pointer', color: 'inherit' }}
                        onClick={() => {
                          setDay(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(a.ts)));
                          setSlot({ ts: a.ts, time: a.time });
                          setStaffId(a.staffId ?? staffId);
                          setConflict([]);
                        }}
                      >
                        <span>
                          <b style={{ fontWeight: 600 }}>
                            {a.day} {a.time}
                          </b>
                          <span className="mut xs" style={{ display: 'block' }}>
                            {a.staffName} · {a.kind === 'other_day' ? 'autre jour' : a.kind === 'same_day_other_staff' ? 'autre barbier' : 'autre horaire'}
                          </span>
                        </span>
                        <span className="link xs">prendre</span>
                      </button>
                    ))}
                  </div>
                </Card>
              )}

              {err && <div className="note bad">{errText(err)}</div>}
            </>
          )}

          {/* ÉTAPE 3 */}
          {step === 3 && service && slot && (
            <>
              <h2>Tes coordonnées</h2>
              <p className="mut sm">
                {when(slot.ts)} · {duration} min · {eur(price)}
              </p>
              <form id="booking-contact"
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
                className="col"
                style={{ gap: 0 }}
                noValidate
              >
                <div className="grid g2">
                  <Field label="Prénom" error={err && !contact.firstName ? 'requis' : undefined}>
                    <input value={contact.firstName} onChange={(e) => setContact({ ...contact, firstName: e.target.value })} autoComplete="given-name" required maxLength={40} />
                  </Field>
                  <Field label="Nom">
                    <input value={contact.lastName} onChange={(e) => setContact({ ...contact, lastName: e.target.value })} autoComplete="family-name" maxLength={40} />
                  </Field>
                </div>
                <Field label="Téléphone" hint="Pour le rappel et le lien de modification. Jamais utilisé pour du démarchage.">
                  <input type="tel" inputMode="tel" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} autoComplete="tel" placeholder="06 12 34 56 78" required />
                </Field>
                <Field label="E-mail (facultatif)" hint="Confirmation + .ics. Utile si tu veux retrouver ton espace client.">
                  <input type="email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} autoComplete="email" />
                </Field>
                <Field label="Une précision pour le barbier ?">
                  <textarea value={contact.note} onChange={(e) => setContact({ ...contact, note: e.target.value })} placeholder="Ex : dégradé bas, garder la longueur dessus, je suis en retard de 5 min…" maxLength={400} />
                </Field>

                <Check label="J'accepte que le salon me contacte pour ce rendez-vous (SMS)." checked={consent.terms} onChange={(v) => setConsent({ ...consent, terms: v })} hint="Obligatoire : sans ça, on ne peut pas t'envoyer le rappel ni le lien de modification." />
                <Check
                  label="Bons plans, créneaux libérés en avant-première (2–3 msgs/mois max)."
                  checked={consent.marketingSms}
                  onChange={(v) => setConsent({ ...consent, marketingSms: v, marketingEmail: v })}
                  hint="Désinscription en 1 clic depuis n'importe quel message. Désactivé la nuit (21h–8h30)."
                />

                {err && <div className="note bad">{errText(err)}</div>}
                {conflict.length > 0 && (
                  <div className="note">
                    Créneau devenu indisponible : <button type="button" className="link" onClick={() => setStep(2)}>choisis-en un autre</button> ou <Link className="link" to="/waitlist">rejoins la waitlist</Link>.
                  </div>
                )}
                <button className="btn lg block booking-submit-inline" type="submit" disabled={busy || !consent.terms || !contact.firstName || contact.phone.length < 9}>
                  {busy ? '…' : `Confirmer — ${eur(price)}`}
                </button>
                <span className="mut xs center">{deposit}</span>
              </form>
            </>
          )}
        </div>

        {/* récap latéral */}
        <aside className="col" style={{ gap: 10 }}>
          <Card>
            <h4>Ton créneau</h4>
            {service ? (
              <>
                <b style={{ fontSize: 17 }}>{service.name}</b>
                <p className="mut sm mb0">
                  {slot ? when(slot.ts) : 'jour et heure à choisir'}
                  <br />
                  {duration} min · {eur(price)}
                </p>
                {staffId && <p className="sm mb0">avec {staff.find((s: any) => s.id === staffId)?.name}</p>}
                {addonIds.length > 0 && (
                  <ul className="mut sm" style={{ paddingLeft: 16, margin: '6px 0 0' }}>
                    {addonIds.map((id) => {
                      const a = cfg.addons.find((x: any) => x.id === id);
                      return <li key={id}>{a?.name} +{eur(a?.priceCents ?? 0)}</li>;
                    })}
                  </ul>
                )}
              </>
            ) : (
              <p className="mut sm mb0">Choisis d'abord ta prestation.</p>
            )}
            <div className="hr" />
            {slot && step < 3 ? (
              <button className="btn block desktop-only" onClick={() => setStep(3)}>
                Continuer
              </button>
            ) : (
              <button className="btn block desktop-only" disabled>
                {step === 3 ? 'Confirme avec tes coordonnées' : 'Choisis un créneau'}
              </button>
            )}
            {step === 2 && (
              <p className="mut xs center" style={{ marginTop: 8 }}>
                <Link className="link xs" to={`/waitlist?service=${serviceKey ?? ''}`}>
                  je n'ai pas d'horaire précis, me rappeler
                </Link>{' '}
                → waitlist
              </p>
            )}
          </Card>
          {selDay && slots.length > 0 && slots.length <= 4 && (
            <Card className="flat">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="tiny gold">Ce jour-là</span>
                <span className="xs mut">{slots.length}/{(selDay.count ?? 0) + (selDay.bookedCount ?? 0)} libres</span>
              </div>
              <Meter pct={Math.round((slots.length / Math.max(1, (selDay.count ?? 0) + (selDay.bookedCount ?? 0))) * 100)} label="créneaux restants" />
              <p className="mut xs mb0" style={{ marginTop: 8 }}>
                Chiffre réel calculé sur le planning, pas une technique d'urgence.
              </p>
            </Card>
          )}
          {cfg?.links?.whatsappHref ? (
            <Card className="flat">
              <h4>Besoin d’un cas particulier ?</h4>
              <p className="mut xs mb0">
                Mariage, coupe d’enfant, client en fauteuil, horaire hors ouverture : écrivez sur WhatsApp, on vous répond
                avec un créneau réel — la demande n’est pas perdue.
              </p>
              <a className="btn ghost sm mt" href={cfg.links.whatsappHref} rel="nofollow noopener" target="_blank">
                Ouvrir WhatsApp
              </a>
            </Card>
          ) : null}
          <Card className="flat">
            <h4>Le salon</h4>
            <p className="sm mb0">
              20 boulevard Roy
              <br />
              93320 Les Pavillons-sous-Bois
              <br />
              <a className="link" href={cfg.links?.tel}>06 44 04 83 85</a>
            </p>
          </Card>
        </aside>
      </div>

      {slot && step >= 2 && (
        <div className={`sticky booking-dock ${step === 3 ? 'booking-dock-confirm' : ''}`}>
          <div className="wrap spread">
            <span className="sm"><b>{eur(price)}</b><small>{when(slot.ts)} · {duration} min</small></span>
            {step === 3 ? <button className="btn" form="booking-contact" type="submit" disabled={busy || !consent.terms || !contact.firstName || contact.phone.length < 9}>{busy ? 'Confirmation…' : `Confirmer — ${eur(price)}`}</button> : <button className="btn" onClick={() => setStep(3)}>Continuer <span aria-hidden="true">→</span></button>}
          </div>
        </div>
      )}
    </div>
  );
}

/** écran « pas de créneau » : jamais un simple "complet" */
function NoSlot({ day, data, serviceKey, onPick }: any) {
  const alts: any[] = data?.alternatives ?? [];
  return (
    <Card className="hl">
      <h3>Ce jour-là, plus de créneau libre.</h3>
      <p className="mut sm">{day.closed === 'complet' ? 'Le planning est plein — mais des créneaux se libèrent presque chaque jour (annulations, reports).' : day.closed}</p>
      {alts.length > 0 ? (
        <>
          <h4 style={{ marginTop: 12 }}>Voilà ce qui est vraiment libre autour</h4>
          <div className="col" style={{ gap: 6 }}>
            {alts.slice(0, 6).map((a: any, i: number) => (
              <button key={i} className="item" style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 10, cursor: 'pointer', color: 'inherit' }} onClick={() => onPick(a.ts, a.time)}>
                <span>
                  <b style={{ fontWeight: 600 }}>
                    {a.weekday} {a.day} · {a.time}
                  </b>
                  <span className="mut xs" style={{ display: 'block' }}>
                    {a.staffName} · {a.kind === 'other_day' ? 'autre jour' : a.kind === 'same_day_other_staff' ? 'autre barbier' : 'autre horaire'}
                  </span>
                </span>
                <span className="link xs">prendre</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
      <div className="row" style={{ marginTop: 12 }}>
        <Link className="btn" to={`/waitlist?service=${serviceKey}`}>
          Me prévenir dès qu'un créneau se libère
        </Link>
        <a className="btn ghost" href="tel:+33644048385">
          Appeler le salon
        </a>
      </div>
      <p className="mut xs mb0" style={{ marginTop: 8 }}>
        La waitlist est automatique : dès qu'un client annule ou décale, le créneau est proposé en 1 clic au premier compatible (offre valable quelques minutes).
      </p>
    </Card>
  );
}

function Done({ res, onGoHome }: { res: any; onGoHome: () => void }) {
  return (
    <div className="wrap pad center" style={{ maxWidth: 620 }}>
      <h1>C'est booké ✔</h1>
      <p className="lead" style={{ margin: '0 auto 18px' }}>
        {when(res.start)} avec {res.staffName}. Ton rendez-vous est enregistré. Garde le lien de gestion ci-dessous ; les messages de confirmation et de rappel dépendent des canaux activés par le salon.
      </p>
      <Card className="hl">
        <div className="grid g3" style={{ textAlign: 'left' }}>
          <div>
            <span className="mut xs">Prestation</span>
            <b style={{ display: 'block' }}>{res.serviceName}</b>
          </div>
          <div>
            <span className="mut xs">Durée</span>
            <b style={{ display: 'block' }}>{res.durationMin} min</b>
          </div>
          <div>
            <span className="mut xs">Sur place</span>
            <b style={{ display: 'block' }}>{eur(res.balanceCents ?? res.priceCents)}</b>
          </div>
        </div>
        <div className="hr" />
        <div className="row" style={{ justifyContent: 'center' }}>
          <a className="btn" href={res.manageUrl}>
            Gérer mon RDV
          </a>
          <a className="btn ghost" href={res.icsUrl}>
            Ajouter à mon agenda
          </a>
          <button className="btn ghost" onClick={onGoHome}>
            Fermer
          </button>
        </div>
        {res.needsConfirm && (
          <p className="note mt mb0" style={{ textAlign: 'left' }}>
            Dernière étape : confirme dans le SMS reçu (1 tap). Sans confirmation 24 h avant, on t'appelle — on garde ton créneau jusque-là.
          </p>
        )}
        {res.loyalty?.points ? (
          <p className="mut xs mt mb0">
            +{res.loyalty.pointsEarned ?? 25} points fidélité · total {res.loyalty.points}
          </p>
        ) : null}
      </Card>
    </div>
  );
}

const eur = (c: number) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: c % 100 ? 2 : 0 }).format(c / 100);
const when = (ts: number) => new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
