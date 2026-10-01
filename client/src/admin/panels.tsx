import { ServiceEditor, StaffEditor, PasswordEditor } from './catalogue';
import { useState } from 'react';
import { adminApi as A, eur, time, useConfig, loadCfg } from '../lib/api';
import { frameSize, Card, Chip, Field, Meter, Seg, Skeleton, errText, useAsync, useToast } from '../lib/ui';
import { HoursEditor } from './hours';

const pick = (d: any, keys: string[]): any[] => {
  if (Array.isArray(d)) return d;
  for (const k of keys) if (Array.isArray(d?.[k])) return d[k];
  return [];
};

/* ───────────────────────── CLIENTS / CRM ───────────────────────── */
export function Clients() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [segment, setSegment] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const list = useAsync(() => A.get('customers', { q, segment, limit: 60 }), [q, segment]);
  const detail = useAsync(() => (open ? A.get(`customers/${open}`) : Promise.resolve(null)), [open]);
  const rows = pick(list.data, ['rows', 'customers']);

  return (
    <>
      <div className="spread mb">
        <h2 className="mb0">Clients</h2>
        <span className="mut xs">{(list.data?.segments ?? []).reduce((a: number, s: any) => a + Number(s.n), 0)} fiches</span>
      </div>
      <form
        className="row mb"
        onSubmit={(e) => {
          e.preventDefault();
          list.reload();
        }}
      >
        <div style={{ flex: 1, minWidth: 190 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="nom, téléphone, e-mail…" aria-label="Rechercher un client" />
        </div>
        <button className="btn sm">Chercher</button>
      </form>
      <div className="row mb" style={{ gap: 6 }}>
        <button className={`chip ${!segment ? 'gold' : ''}`} style={{ background: 'none', cursor: 'pointer' }} onClick={() => setSegment('')}>
          tous
        </button>
        {(list.data?.segments ?? []).map((s: any) => (
          <button key={s.key} className={`chip ${segment === s.key ? 'gold' : ''}`} style={{ background: 'none', cursor: 'pointer' }} onClick={() => setSegment(s.key)}>
            {s.label} · {s.n}
          </button>
        ))}
      </div>
      <Card>
        <div className="tx" tabIndex={0} role="region" aria-label="Tableau — défilement horizontal"><table className="t">
          <thead>
            <tr>
              <th>Nom</th>
              <th>Dernière visite</th>
              <th>Visites</th>
              <th>Dépensé</th>
              <th>Points</th>
              <th>Risque</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.id}>
                <td>
                  <b style={{ fontWeight: 600 }}>
                    {r.first_name} {r.last_name}
                  </b>
                  <span className="mut xs" style={{ display: 'block' }}>{r.phone}</span>
                </td>
                <td>{r.lastVisit ?? '—'}</td>
                <td>{r.visits_count ?? r.visits}</td>
                <td>{eur(r.spent_cents)}</td>
                <td>{r.loyalty_points}</td>
                <td>{r.noshow_count > 1 ? <Chip tone="bad">{r.noshow_count} absences</Chip> : r.risk_level ? <Chip tone="warn">{r.risk_level}</Chip> : <Chip tone="ok">RAS</Chip>}</td>
                <td className="right">
                  <button className="btn ghost sm" onClick={() => setOpen(r.id)}>
                    fiche
                  </button>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={7} className="mut">
                  {list.loading ? 'chargement…' : 'Aucun résultat.'}
                </td>
              </tr>
            )}
          </tbody>
        </table></div>
      </Card>

      {open && (
        <Card className="mt hl">
          {detail.loading ? (
            <Skeleton n={3} />
          ) : (
            (() => {
              const c = detail.data?.customer ?? detail.data ?? {};
              return (
                <>
                  <div className="spread">
                    <h3 className="mb0">
                      {c.first_name} {c.last_name}
                    </h3>
                    <div className="row" style={{ gap: 6 }}>
                      <button
                        className="btn ghost sm"
                        onClick={() =>
                          A.post(`customers/${open}`, { note: prompt('Note interne (visible barbiers uniquement) :', c.notes ?? '') ?? '' }).then(() => {
                            toast('Noté');
                            detail.reload();
                          })
                        }
                      >
                        note
                      </button>
                      <button
                        className="btn ghost sm"
                        onClick={async () => {
                          const label = prompt('Raison de la relance ?', 'client à risque');
                          await A.post(`customers/${open}`, { flag: 'yes', label: label ?? '' }).catch((e) => toast(errText(e), 'bad'));
                          toast('Marqué — la file de relance est recalculée.');
                          detail.reload();
                        }}
                      >
                        marquer à risque
                      </button>
                      <button
                        className="btn sm"
                        onClick={async () => {
                          await A.post(`customers/${open}`, { campaign: 'relance' }).catch((e) => toast(errText(e), 'bad'));
                          toast('Message de relance mis dans la file (respect des heures de silence).');
                        }}
                      >
                        relancer
                      </button>
                      <button className="btn ghost sm" onClick={() => setOpen(null)}>
                        fermer
                      </button>
                    </div>
                  </div>
                  <div className="grid g4" style={{ marginTop: 12 }}>
                    {[
                      ['Segment', c.segment],
                      ['Visites', c.visits_count ?? c.visits],
                      ['Dépensé', eur(c.spent_cents)],
                      ['Panier moyen', c.visits ? eur(Math.round((c.spent_cents ?? 0) / (c.visits || 1))) : '—'],
                      ['No-shows', c.noshow_count],
                      ['Annulations', c.cancelled_count],
                      ['Loyalty', c.loyalty_points],
                      ['Depuis', c.last_visit_ts ? Math.round((Date.now() - c.last_visit_ts) / 86_400_000) + ' j' : '—'],
                    ].map(([l, v]: any) => (
                      <div key={l}>
                        <span className="mut xs">{l}</span>
                        <b style={{ display: 'block' }}>{v ?? '—'}</b>
                      </div>
                    ))}
                  </div>
                  {(c.notes || c.notes === '') && (
                    <p className="mut sm">
                      <b>Notes internes :</b> {c.notes || '—'}
                    </p>
                  )}
                  <div className="hr" />
                  <h4>Historique</h4>
                  {pick(c.history ?? detail.data?.history, ['history']).map((a: any) => (
                    <div className="item" key={a.id ?? a.start_ts}>
                      <span>
                        <b style={{ fontWeight: 600 }}>{a.service_name ?? a.service}</b>
                        <span className="mut xs" style={{ display: 'block' }}>{new Date(a.start_ts ?? a.start).toLocaleDateString('fr-FR')} · {a.staff_name ?? a.staff}</span>
                      </span>
                      <span className="sm">{eur(a.price_cents ?? a.priceCents)}</span>
                    </div>
                  ))}
                </>
              );
            })()
          )}
        </Card>
      )}
    </>
  );
}

/* ───────────────────────── ANALYTIQUE ───────────────────────── */
export function Analytics() {
  const [tab, setTab] = useState<'kpis' | 'funnel' | 'sources' | 'revenue' | 'services' | 'capacity' | 'heatmap' | 'forecast' | 'risk' | 'recos' | 'obs'>('kpis');
  const r = useAsync(() => A.get(`analytics/${tab}`, tab === 'heatmap' ? { weeks: 6 } : { days: 30 }), [tab]);
  const d = r.data ?? {};
  return (
    <>
      <h2 className="mb">Analytique</h2>
      <div className="tabs mb">
        {([
          ['kpis', 'Indicateurs'],
          ['funnel', 'Entonnoir'],
          ['sources', 'Sources'],
          ['revenue', 'CA'],
          ['services', 'Prestations'],
          ['capacity', 'Charge'],
          ['heatmap', 'Affluence'],
          ['forecast', 'Prévision'],
          ['risk', 'À risque'],
          ['recos', 'Recommandations'],
          ['obs', 'Technique'],
        ] as const).map(([k, l]) => (
          <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {r.loading && !r.data ? <Skeleton n={4} /> : r.error ? <div className="note bad">{errText(r.error)}</div> : <Report tab={tab} d={d} />}
    </>
  );
}

function Report({ tab, d }: any) {
  if (tab === 'kpis')
    return (
      <div className="grid g4">
        {[
          ['RDV honorés', d.completed ?? d.appointmentsCompleted],
          ['Taux d’occupation', d.occupancyPct != null ? `${d.occupancyPct}%` : '—'],
          ['No-show', d.noShowRate != null ? `${d.noShowRate}%` : '—'],
          ['Panier moyen', d.avgTicketCents ? eur(d.avgTicketCents) : '—'],
          ['CA', d.revenueCents ? eur(d.revenueCents) : '—'],
          ['Nouveaux', d.newCustomers],
          ['Réservations en ligne', d.onlineShare != null ? `${d.onlineShare}%` : '—'],
          ['Waitlist convertie', d.waitlistConverted != null ? `${d.waitlistConverted}` : '—'],
        ].map(([l, v]: any) => (
          <div className="tile" key={String(l)}>
            <span className="mut xs">{l}</span>
            <b>{v ?? '—'}</b>
          </div>
        ))}
        {d.delta && <p className="mut sm">Évolution vs période précédente : {JSON.stringify(d.delta)}</p>}
      </div>
    );
  if (tab === 'funnel')
    return (
      <Card>
        {(d.steps ?? []).map((s: any) => (
          <div key={s.key ?? s.label} style={{ marginBottom: 12 }}>
            <div className="spread">
              <b style={{ fontWeight: 600 }}>{s.label}</b>
              <span className="mut sm">
                {s.value} · {s.pct}%
              </span>
            </div>
            <Meter pct={s.pct} label={s.label} />
          </div>
        ))}
        {d.recovered && <p className="mut sm mb0">Créneaux récupérés via waitlist : {d.recovered}</p>}
      </Card>
    );
  if (tab === 'sources')
    return (
      <Card>
        <div className="tx" tabIndex={0} role="region" aria-label="Tableau — défilement horizontal"><table className="t">
          <thead>
            <tr>
              <th>Source</th>
              <th>Visites</th>
              <th>RDV</th>
              <th>CA</th>
              <th>Conv.</th>
            </tr>
          </thead>
          <tbody>
            {pick(d, ['rows', 'sources']).map((x: any) => (
              <tr key={x.source}>
                <td>
                  <b style={{ fontWeight: 600 }}>{x.source}</b>
                </td>
                <td>{x.visits ?? '—'}</td>
                <td>{x.bookings ?? x.appointments}</td>
                <td>{eur(x.revenueCents ?? x.revenue)}</td>
                <td>{x.conv != null ? `${x.conv}%` : x.conversionPct != null ? `${x.conversionPct}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Card>
    );
  if (tab === 'revenue')
    return (
      <Card>
        <div className="row" style={{ gap: 3, alignItems: 'flex-end', height: 140 }}>
          {pick(d, ['series', 'days', 'rows']).map((x: any, i: number) => {
            const v = Number(x.revenueCents ?? x.revenue ?? x.value ?? 0);
            const max = Math.max(1, ...pick(d, ['series', 'days', 'rows']).map((y: any) => Number(y.revenueCents ?? y.revenue ?? y.value ?? 0)));
            return (
              <div key={i} title={`${x.day ?? x.date ?? ''} · ${eur(v)}`} style={{ flex: 1, height: `${Math.max(2, (v / max) * 100)}%`, background: 'linear-gradient(180deg,var(--gold),rgba(232,201,138,.25))', borderRadius: '4px 4px 0 0', minWidth: 4 }} />
            );
          })}
        </div>
        <div className="spread xs mut" style={{ marginTop: 6 }}>
          <span>{pick(d, ['series', 'days', 'rows'])[0]?.day ?? ''}</span>
          <span>{pick(d, ['series', 'days', 'rows']).slice(-1)[0]?.day ?? ''}</span>
        </div>
      </Card>
    );
  if (tab === 'services')
    return (
      <Card>
        <div className="tx" tabIndex={0} role="region" aria-label="Tableau — défilement horizontal"><table className="t">
          <thead>
            <tr>
              <th>Prestation</th>
              <th>Volume</th>
              <th>CA</th>
              <th>Panier</th>
              <th>Part</th>
            </tr>
          </thead>
          <tbody>
            {pick(d, ['rows', 'services']).map((x: any) => (
              <tr key={x.service ?? x.name}>
                <td>{x.service ?? x.name}</td>
                <td>{x.count ?? x.n}</td>
                <td>{eur(x.revenueCents ?? x.revenue)}</td>
                <td>{eur(x.avgCents ?? x.avgTicketCents)}</td>
                <td style={{ width: 110 }}>
                  <Meter pct={x.sharePct ?? 0} />
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Card>
    );
  if (tab === 'capacity')
    return (
      <Card>
        <div className="tx" tabIndex={0} role="region" aria-label="Tableau — défilement horizontal"><table className="t">
          <thead>
            <tr>
              <th>Jour</th>
              <th>Occupation</th>
              <th>CA</th>
              <th>Trous</th>
            </tr>
          </thead>
          <tbody>
            {pick(d, ['days', 'rows']).map((x: any) => (
              <tr key={x.day}>
                <td>{x.day}</td>
                <td style={{ width: 160 }}>
                  <Meter pct={x.occupancyPct ?? x.pct ?? 0} />
                </td>
                <td>{eur(x.revenueCents ?? x.revenue)}</td>
                <td>{x.deadMinutes ?? x.gapMinutes ?? '—'} min</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Card>
    );
  if (tab === 'heatmap') {
    const cells = pick(d, ['cells', 'rows', 'grid']);
    const max = Math.max(1, ...cells.map((c: any) => Number(c.n ?? c.count ?? 0)));
    return (
      <Card>
        <p className="mut xs">Affluence réelle par jour × heure (6 dernières semaines) — c’est ça qui dit où ouvrir des créneaux.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '44px repeat(22, 1fr)', gap: 2 }}>
          <span />
          {Array.from({ length: 22 }, (_, i) => (
            <span key={i} className="mut xs" style={{ textAlign: 'center', fontSize: 9 }}>
              {9 + Math.floor(i / 2)}
            </span>
          ))}
          {['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'].map((day, di) => (
            <>
              <span key={'h' + di} className="mut xs">
                {day}
              </span>
              {Array.from({ length: 22 }, (_, hi) => {
                const cell = cells.find((c: any) => Number(c.dow ?? c.day) === di + 1 && Number(c.slot ?? c.hour) === hi);
                const v = Number(cell?.n ?? cell?.count ?? 0);
                return <span key={`${di}-${hi}`} title={`${day} ${9 + Math.floor(hi / 2)}h30 · ${v} rdv`} style={{ height: 16, borderRadius: 3, background: `rgba(232,201,138,${v ? 0.15 + (v / max) * 0.75 : 0.04})` }} />;
              })}
            </>
          ))}
        </div>
      </Card>
    );
  }
  if (tab === 'forecast')
    return (
      <Card>
        <div className="tx" tabIndex={0} role="region" aria-label="Tableau — défilement horizontal"><table className="t">
          <thead>
            <tr>
              <th>Jour</th>
              <th>Prévu</th>
              <th>Déjà pris</th>
              <th>Écart</th>
              <th>Confiance</th>
            </tr>
          </thead>
          <tbody>
            {pick(d, ['days', 'rows']).map((x: any) => (
              <tr key={x.day}>
                <td>{x.label ?? x.day}</td>
                <td>{x.predicted}</td>
                <td>{x.booked}</td>
                <td>{(x.gap ?? 0) > 0 ? <Chip tone="warn">+{x.gap}</Chip> : (x.gap ?? 0) < 0 ? <Chip tone="ok">{x.gap}</Chip> : '—'}</td>
                <td>{x.confidence != null ? `${Math.round(x.confidence * 100)}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Card>
    );
  if (tab === 'risk')
    return (
      <Card>
        <div className="tx" tabIndex={0} role="region" aria-label="Tableau — défilement horizontal"><table className="t">
          <thead>
            <tr>
              <th>Client</th>
              <th>Dernière visite</th>
              <th>Visites</th>
              <th>Valeur</th>
              <th>Signal</th>
            </tr>
          </thead>
          <tbody>
            {pick(d, ['rows', 'customers']).map((x: any) => (
              <tr key={x.id}>
                <td>{x.name ?? `${x.first_name} ${x.last_name ?? ''}`}</td>
                <td>{x.lastVisit ?? x.last_visit_days ?? '—'}</td>
                <td>{x.visits ?? x.visits_count}</td>
                <td>{eur(x.spentCents ?? x.spent_cents)}</td>
                <td>
                  <Chip tone="warn">{x.reason ?? x.signal ?? 'inactif'}</Chip>
                </td>
              </tr>
            ))}
            {!pick(d, ['rows', 'customers']).length && <tr><td colSpan={5} className="mut">Personne à relancer sur la période.</td></tr>}
          </tbody>
        </table></div>
      </Card>
    );
  if (tab === 'recos')
    return (
      <div className="grid g2">
        {pick(d, ['recommendations', 'items', 'rows']).map((x: any, i: number) => (
          <Card key={i}>
            <div className="spread">
              <b style={{ fontWeight: 650 }}>{x.title ?? x.label}</b>
              {x.impactCents ? <Chip tone="gold">{eur(x.impactCents)}/mois</Chip> : x.impact ? <Chip>{x.impact}</Chip> : null}
            </div>
            <p className="mut sm mb0">{x.detail ?? x.body ?? x.text}</p>
            {x.action && (
              <p className="xs mb0" style={{ marginTop: 8 }}>
                <span className="gold">Action :</span> {x.action}
              </p>
            )}
          </Card>
        ))}
        {!pick(d, ['recommendations', 'items', 'rows']).length && <p className="mut">Pas de recommandation — le planning est équilibré.</p>}
      </div>
    );
  return (
    <Card>
      <div className="tx" tabIndex={0} role="region" aria-label="Tableau — défilement horizontal"><table className="t">
        <thead>
          <tr>
            <th>Élément</th>
            <th>Valeur</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(d).slice(0, 24).map(([k, v]) => (
            <tr key={k}>
              <td className="mut">{k}</td>
              <td>{typeof v === 'object' ? JSON.stringify(v).slice(0, 90) : String(v)}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </Card>
  );
}

/* ───────────────────────── AVIS ───────────────────────── */
export function Reviews() {
  const toast = useToast();
  const r = useAsync(() => A.get('reviews'), []);
  const rows = pick(r.data, ['rows', 'reviews']);
  const [reply, setReply] = useState<number | null>(null);
  const s = r.data?.stats ?? {};
  return (
    <>
      <div className="spread mb">
        <h2 className="mb0">Avis</h2>
        <span className="mut xs">
          {s.count ?? 0} au total · moyenne {s.avg ?? '—'}/5 · note externe {s.googleRating?.value ?? '—'} ({s.googleRating?.count ?? 0})
        </span>
      </div>
      <div className="note mb">
        <span className="sm">Règle du salon : un client satisfait est orienté vers Google, un client mécontent est traité en privé. Aucun avis n'est acheté, publié sans consentement, ni trié pour gonfler la note.</span>
      </div>
      <Card>
        <div className="tx" tabIndex={0} role="region" aria-label="Tableau — défilement horizontal"><table className="t">
          <thead>
            <tr>
              <th>Note</th>
              <th>Commentaire</th>
              <th>Canal</th>
              <th>Visibilité</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x: any) => (
              <tr key={x.id}>
                <td>{'★'.repeat(x.rating ?? 0)}</td>
                <td>
                  {x.comment ? String(x.comment).slice(0, 130) : <span className="mut">—</span>}
                  {x.first_name && <span className="mut xs" style={{ display: 'block' }}>{x.first_name} {x.last_name} · {x.appointmentLabel ?? ''}</span>}
                </td>
                <td>
                  <Chip tone={x.channel === 'demo' ? 'warn' : ''}>{x.channel}</Chip>
                </td>
                <td>{x.visibility === 'public' ? <Chip tone="ok">public</Chip> : <Chip>interne</Chip>}</td>
                <td className="right">
                  {x.visibility !== 'public' && x.rating && x.rating >= 4 ? (
                    <button
                      className="btn sm"
                      onClick={() => A.post(`reviews/${x.id}/publish`, {}).then(() => { toast('Publié sur le site'); r.reload(); }).catch((e) => toast(errText(e), 'bad'))}
                    >
                      publier
                    </button>
                  ) : null}{' '}
                  <button className="btn ghost sm" onClick={() => setReply(reply === x.id ? null : x.id)}>
                    répondre
                  </button>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={5} className="mut">
                  Aucun avis collecté pour l’instant.
                </td>
              </tr>
            )}
          </tbody>
        </table></div>
        {reply && (
          <form
            className="row mt"
            onSubmit={(e: any) => {
              e.preventDefault();
              const text = new FormData(e.target).get('text');
              A.post(`reviews/${reply}/reply`, { text }).then(() => {
                toast('Réponse enregistrée');
                setReply(null);
                r.reload();
              });
            }}
          >
            <div style={{ flex: 1 }}>
              <input name="text" placeholder="Réponse publique, courtoise et factuelle…" maxLength={600} autoFocus />
            </div>
            <button className="btn sm">Envoyer</button>
          </form>
        )}
      </Card>
    </>
  );
}

/* ───────────────────────── MARKETING ───────────────────────── */
export function Marketing() {
  const toast = useToast();
  const cfg = useConfig().cfg;
  const c = useAsync(() => A.get('campaigns'), []);
  const refs = useAsync(() => A.get('referrals'), []);
  const gifts = useAsync(() => A.get('gift-cards'), []);
  const [form, setForm] = useState({ name: '', segment: 'inactif_60', channel: 'sms', text: '' });
  const rows = pick(c.data, ['rows', 'campaigns']);
  return (
    <>
      <h2 className="mb">Marketing</h2>
      <div className="grid" style={{ gridTemplateColumns: '1.25fr 1fr', alignItems: 'start' }}>
        <Card>
          <h4>Campagnes</h4>
          <div className="tx" tabIndex={0} role="region" aria-label="Tableau — défilement horizontal"><table className="t">
            <thead>
              <tr>
                <th>Nom</th>
                <th>Segment</th>
                <th>Envois</th>
                <th>Résa</th>
                <th>Statut</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x: any) => (
                <tr key={x.id}>
                  <td>{x.name}</td>
                  <td className="mut xs">{x.segment ?? '—'}</td>
                  <td>{x.sent ?? x.stats?.sent ?? 0}</td>
                  <td>{x.bookings ?? x.stats?.bookings ?? 0}</td>
                  <td>
                    <Chip tone={x.status === 'sent' ? 'ok' : x.status === 'draft' ? '' : 'warn'}>{x.status}</Chip>
                  </td>
                  <td className="right nowrap">
                    {x.status !== 'sent' && (
                      <>
                        <button className="btn sm" onClick={() => A.post(`campaigns/${x.id}/approve`, { decision: 'send' }).then(() => { toast('Programmé'); c.reload(); }).catch((e) => toast(errText(e), 'bad'))}>
                          envoyer
                        </button>{' '}
                        <button className="btn ghost sm" onClick={() => A.post(`campaigns/${x.id}/approve`, { decision: 'cancel' }).then(c.reload)}>
                          annuler
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={6} className="mut">
                    Aucune campagne.
                  </td>
                </tr>
              )}
            </tbody>
          </table></div>
          <div className="hr" />
          <form
            className="col"
            style={{ gap: 0 }}
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await A.post('campaigns', { ...form, serviceKey: 'coupe-homme' });
                toast('Campagne créée en brouillon — rien n’est envoyé sans validation.');
                c.reload();
              } catch (err) {
                toast(errText(err), 'bad');
              }
            }}
          >
            <h4>Nouvelle campagne</h4>
            <div className="grid g2">
              <Field label="Nom">
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={3} maxLength={80} />
              </Field>
              <Field label="Canal">
                <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
                  <option value="sms">SMS</option>
                  <option value="email">E-mail</option>
                  <option value="both">les deux</option>
                </select>
              </Field>
            </div>
            <Field label="Segment">
              <select value={form.segment} onChange={(e) => setForm({ ...form, segment: e.target.value })}>
                {['inactif_60', 'inactif_90', 'fidele', 'nouveau', 'no_show_risque', 'anniversaire', 'tous'].map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Message" hint="Les variables {prenom}, {service}, {link_book} sont remplacées automatiquement. Fréquence plafonnée : 4 messages / 7 jours par client, jamais la nuit.">
              <textarea value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} maxLength={600} placeholder="{prenom}, un créneau se libère souvent vendredi — tu réserves en 1 clic : {link_book}" />
            </Field>
            <button className="btn block sm">Créer le brouillon</button>
          </form>
        </Card>

        <div className="col" style={{ gap: 12 }}>
          <Card>
            <h4>Parrainage</h4>
            <div className="tx" tabIndex={0} role="region" aria-label="Tableau — défilement horizontal"><table className="t">
              <tbody>
                {pick(refs.data?.leaderboard, ['leaderboard', 'rows']).slice(0, 6).map((x: any, i: number) => (
                  <tr key={i}>
                    <td className="rank">{i + 1}</td>
                    <td>{x.name ?? x.first_name}</td>
                    <td className="right">
                      {x.converted ?? x.n} amené(s) · {eur((x.rewardCents ?? 0) || (x.reward ?? 0))}
                    </td>
                  </tr>
                ))}
                {!pick(refs.data?.leaderboard, ['leaderboard', 'rows']).length && (
                  <tr>
                    <td className="mut">Aucun parrainage converti pour l’instant.</td>
                  </tr>
                )}
              </tbody>
            </table></div>
          </Card>
          <Card>
            <h4>Cartes cadeaux</h4>
            <button className="btn sm mb" onClick={async () => {
              const buyerName = prompt('Nom de l’acheteur :'); if (!buyerName) return;
              const buyerEmail = prompt('E-mail de l’acheteur :'); if (!buyerEmail) return;
              const euros = prompt('Montant encaissé au comptoir, en euros (10 à 500) :'); if (!euros) return;
              const amountCents = Math.round(Number(euros.replace(',', '.')) * 100);
              if (!Number.isFinite(amountCents) || amountCents < 1000 || amountCents > 50000) { toast('Montant invalide', 'bad'); return; }
              if (!confirm(`Confirmer l’encaissement de ${eur(amountCents)} au salon ? La carte sera activée immédiatement.`)) return;
              try { const r = await A.post('gift-cards', { buyerName, buyerEmail, amountCents }); toast(`Carte activée : ${r.code}`); gifts.reload(); }
              catch (e) { toast(errText(e), 'bad'); }
            }}>Émettre après encaissement au salon</button>
            <div className="tx" tabIndex={0} role="region" aria-label="Tableau — défilement horizontal"><table className="t">
              <tbody>
                {pick(gifts.data, ['rows', 'items']).slice(0, 8).map((g: any) => (
                  <tr key={g.id}>
                    <td>{g.code}</td>
                    <td className="mut xs">{g.buyer_name}</td>
                    <td className="right">
                      {eur(g.balance_cents)} <Chip>{g.status}</Chip>
                    </td>
                  </tr>
                ))}
                {!pick(gifts.data, ['rows', 'items']).length && (
                  <tr>
                    <td className="mut">Aucune carte vendue.</td>
                  </tr>
                )}
              </tbody>
            </table></div>
          </Card>
        </div>
      </div>
    </>
  );
}

/* ───────────────────────── AUTOMATISATIONS ───────────────────────── */
export function Automations() {
  const toast = useToast();
  const a = useAsync(() => A.get('automations'), []);
  const rows = pick(a.data, ['automations']);
  const [edit, setEdit] = useState<any>(null);
  return (
    <>
      <div className="spread mb">
        <h2 className="mb0">Automatisations</h2>
        <span className="mut xs">
          files d’envoi : {a.data?.outbox?.queued ?? 0} en attente · {a.data?.outbox?.sent ?? 0} envoyés
        </span>
      </div>
      <div className="grid g2">
        {rows.map((x: any) => (
          <Card key={x.key}>
            <div className="spread">
              <div>
                <b style={{ fontWeight: 650 }}>{x.name ?? x.key}</b>
                <p className="mut xs mb0" style={{ marginTop: 2 }}>{x.description}</p>
              </div>
              <button
                className={`btn sm ${x.is_active ? '' : 'ghost'}`}
                onClick={() => A.post(`automations/${x.key}`, { is_active: !x.is_active }).then(() => { toast(x.is_active ? 'Désactivée' : 'Activée'); a.reload(); })}
              >
                {x.is_active ? 'active' : 'éteinte'}
              </button>
            </div>
            <div className="row xs mut" style={{ marginTop: 8, gap: 8 }}>
              <span>tonalité : {x.tone ?? 'auto'}</span>
              {x.cooldown_hours ? <span>· cooldown {x.cooldown_hours} h</span> : null}
              {x.max_per_week ? <span>· {x.max_per_week}/sem max</span> : null}
              {x.requires_owner_approval ? <Chip tone="warn">validation manuel</Chip> : null}
            </div>
            <div className="row" style={{ marginTop: 10, gap: 6 }}>
              <button className="btn ghost sm" onClick={() => setEdit(x)}>
                config
              </button>
              <button className="btn ghost sm" onClick={() => A.post(`automations/${x.key}/run`, {}).then((r: any) => toast(`Exécutée : ${r?.fired ?? r?.count ?? 'ok'}`)).catch((e) => toast(errText(e), 'bad'))}>
                lancer maintenant
              </button>
            </div>
          </Card>
        ))}
      </div>

      {edit && (
        <Card className="mt hl">
          <h4>{edit.key}</h4>
          <form
            onSubmit={(e: any) => {
              e.preventDefault();
              const raw = new FormData(e.target).get('cfg');
              try {
                const cfgv = JSON.parse(String(raw ?? '{}'));
                A.post(`automations/${edit.key}`, { config: cfgv }).then(() => {
                  toast('Réglé — le moteur prend la main dès le prochain tick.');
                  setEdit(null);
                  a.reload();
                });
              } catch {
                toast('JSON invalide', 'bad');
              }
            }}
          >
            <textarea name="cfg" defaultValue={JSON.stringify(edit.config ?? {}, null, 2)} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }} rows={10} />
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn sm">Enregistrer</button>
              <button type="button" className="btn ghost sm" onClick={() => setEdit(null)}>
                fermer
              </button>
            </div>
          </form>
        </Card>
      )}

      <Card className="mt">
        <h4>Sur les 100 derniers messages</h4>
        {pick(a.data?.outbox?.rows, ['rows', 'items']).slice(0, 12).map((n: any) => (
          <div className="item" key={n.id}>
            <span>
              <b style={{ fontWeight: 600 }}>{n.kind}</b>
              <span className="mut xs" style={{ display: 'block' }}>
                {n.channel} → {n.recipient} · {new Date(n.created_ts).toLocaleString('fr-FR')}
              </span>
            </span>
            <span className="row" style={{ gap: 8 }}>
              <Chip tone={n.status === 'sent' ? 'ok' : n.status === 'failed' ? 'bad' : ''}>{n.status}</Chip>
              {n.status !== 'sent' && (
                <button className="btn ghost sm" onClick={() => A.post(`notifications/${n.id}/resend`, {}).then(() => toast('Renvoyé'))}>
                  renvoyer
                </button>
              )}
            </span>
          </div>
        ))}
        {!pick(a.data?.outbox?.rows, ['rows', 'items']).length && <p className="mut sm mb0">Aucun message en file : tout est parti.</p>}
      </Card>
    </>
  );
}

/* ───────────────────────── ASSISTANT ───────────────────────── */
export function Assistant() {
  const toast = useToast();
  const [log, setLog] = useState<{ q: string; a: any }[]>([
    { q: '', a: { text: 'Pose une question en français naturel : « combien de RDV demain », « qui relancer cette semaine », « bloque vendredi après-midi pour Rayan ». Les réponses viennent du vrai planning — rien n’est modifié sans que tu valides.', chips: [{ label: 'Combien de RDV demain ?', query: 'combien de rendez-vous demain' }, { label: 'Qui relancer ?', query: 'quels clients dois-je relancer' }, { label: 'CA de la semaine', query: 'revenu de la semaine' }] } } as any,
  ]);
  const [busy, setBusy] = useState(false);
  const ask = async (question: string) => {
    setBusy(true);
    try {
      const a = await A.post('assistant/ask', { question });
      setLog((l) => [...l, { q: question, a }]);
    } catch (e) {
      toast(errText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h2 className="mb">Assistant</h2>
      <div className="col" style={{ maxWidth: 760 }}>
        {log.map((x, i) => (
          <div key={i} className="col" style={{ gap: 8 }}>
            {x.q && <p className="mut sm mb0" style={{ textAlign: 'right' }}>{x.q}</p>}
            <Card className="hl">
              <p className="mb0">{x.a?.text}</p>
              {x.a?.rows?.length > 0 && (
                <div className="tx" tabIndex={0} role="region" aria-label="Tableau — défilement horizontal"><table className="t mt">
                  <tbody>
                    {x.a.rows.slice(0, 8).map((r: any, j: number) => (
                      <tr key={j}>
                        {Object.entries(r).map(([k, v]) => (
                          <td key={k}>
                            <span className="mut xs" style={{ display: 'block' }}>{k}</span>
                            {String(v)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
              {x.a?.cards?.length > 0 && (
                <div className="grid g3 mt">
                  {x.a.cards.map((c: any, j: number) => (
                    <div className="tile" key={j}>
                      <span className="mut xs">{c.label}</span>
                      <b>{c.value}</b>
                    </div>
                  ))}
                </div>
              )}
              {x.a?.action && (
                <div className="note mt">
                  <div className="spread">
                    <span className="sm">{x.a.action.label} — {x.a.action.preview}</span>
                    <button
                      className="btn sm"
                      onClick={async () => {
                        try {
                          const out = await A.post('assistant/confirm', { token: x.a.action.confirmToken });
                          toast('Exécuté ✔');
                          setLog((l) => [...l, { q: '', a: { text: `Action confirmée : ${JSON.stringify(out).slice(0, 160)}` } }]);
                        } catch (e) {
                          toast(errText(e), 'bad');
                        }
                      }}
                    >
                      Valider
                    </button>
                  </div>
                  <span className="mut xs">Rien n'a été fait avant ce clic. Le jeton expire dans 10 minutes.</span>
                </div>
              )}
              {x.a?.chips?.length > 0 && (
                <div className="row" style={{ marginTop: 10 }}>
                  {x.a.chips.map((c: any) => (
                    <button key={c.query} className="chip" style={{ cursor: 'pointer', background: 'none' }} onClick={() => ask(c.query)}>
                      {c.label}
                    </button>
                  ))}
                </div>
              )}
            </Card>
          </div>
        ))}
        <form
          className="row"
          onSubmit={(e: any) => {
            e.preventDefault();
            const v = String(new FormData(e.target).get('q') ?? '').trim();
            if (v) {
              e.target.reset();
              ask(v);
            }
          }}
        >
          <div style={{ flex: 1 }}>
            <input name="q" placeholder="ex : combien de clients en waitlist ?" disabled={busy} autoFocus />
          </div>
          <button className="btn" disabled={busy}>
            {busy ? '…' : 'Demander'}
          </button>
        </form>
      </div>
    </>
  );
}


/* ------------------------------------------------------------------------- */
/*  Marque & contact — le salon écrit son nom, son numéro, ses réseaux et      */
/*  son accroche. Rien n'est codé en dur dans la vitrine : ces valeurs vivent   */
/*  dans brand_json, que lisent à la fois le site (hero, pied de page, boutons  */
/*  de contact) et les messages automatiques (formule d'appel, WhatsApp).       */
/*  Le serveur fusionne les clés : on n'écrase donc jamais ce qui existe déjà.  */
/* ------------------------------------------------------------------------- */
function BrandCard({ d, onSaved }: any) {
  const loc = d?.location ?? {};
  const b = loc.brand ?? {};
  const { cfg } = useConfig(); // les liens publics tels que le visiteur les reçoit
  const links = cfg?.links ?? {};
  const [f, setF] = useState(() => ({
    name: loc.name ?? '',
    phone: loc.phone ?? '',
    email: loc.email ?? '',
    whatsapp: b.whatsapp ?? '',
    tagline: b.tagline ?? '',
    promise: b.promise ?? '',
    instagram: b.instagram ?? '',
    tiktok: b.tiktok ?? '',
    facebook: b.facebook ?? '',
    reviewUrl: b.reviewUrl ?? '',
    googleMapsUrl: b.googleMapsUrl || b.mapsUrl || 'https://www.google.com/maps?cid=14672622159112713981&hl=fr',
  }));
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: string) => setF((old: any) => ({ ...old, [k]: v }));

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      await A.post('settings', {
        name: f.name.trim(),
        phone: f.phone.trim(),
        email: f.email.trim(),
        brand: {
          whatsapp: f.whatsapp.replace(/[^\d+]/g, ''),
          tagline: f.tagline.trim(),
          promise: f.promise.trim(),
          instagram: f.instagram.trim(),
          tiktok: f.tiktok.trim(),
          facebook: f.facebook.trim(),
          reviewUrl: f.reviewUrl.trim(),
          googleMapsUrl: f.googleMapsUrl.trim(),
        },
      });
      toast('Marque enregistrée — le site et les messages utilisent ces valeurs immédiatement.');
      onSaved?.();
    } catch (e: any) {
      setErr(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const waNum = (f.whatsapp || '').replace(/[^\d]/g, '').replace(/^0+/, '33');

  return (
    <Card
      title="Marque & contact"
      actions={
        <button className="btn" disabled={saving || !f.name.trim()} onClick={save}>
          {saving ? '…' : 'Enregistrer'}
        </button>
      }
    >
      <p className="mut xs">
        Le nom signe les pages, les e-mails et les SMS ; le numéro WhatsApp devient le bouton de contact du site. Un champ
        laissé vide est enregistré vide — si vous ne voulez pas changer une valeur, ne la touchez pas.
      </p>
      <div className="grid g2">
        <Field label="Nom du salon">
          <input className="in" value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={80} />
        </Field>
        <Field label="Téléphone" hint="Affiché en bouton d'appel sur mobile.">
          <input className="in" value={f.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" placeholder="06 44 04 83 85" />
        </Field>
        <Field label="E-mail de contact">
          <input className="in" value={f.email} onChange={(e) => set('email', e.target.value)} inputMode="email" />
        </Field>
        <Field
          label="Numéro WhatsApp du salon"
          hint="Avec l'indicatif (+33…). Les clients écrivent ici ; les rappels, eux, partent du numéro Business déclaré dans les variables d'environnement."
        >
          <input className="in" value={f.whatsapp} onChange={(e) => set('whatsapp', e.target.value)} inputMode="tel" placeholder="+33 6 44 04 83 85" />
        </Field>
      </div>
      <div className="grid g2 mt">
        <Field label="Accroche du hero" hint="La phrase sous le titre de la page d'accueil.">
          <input className="in" value={f.tagline} onChange={(e) => set('tagline', e.target.value)} maxLength={140} />
        </Field>
        <Field label="Promesse (tuile du hero)" hint="Doit être vraie : c'est un engagement, pas un slogan.">
          <input className="in" value={f.promise} onChange={(e) => set('promise', e.target.value)} maxLength={80} />
        </Field>
      </div>
      <h4 className="mt">Réseaux, avis, itinéraire</h4>
      <div className="grid g2">
        <Field label="Instagram" hint="URL complète. Vide = aucun lien affiché (jamais de lien mort).">
          <input className="in" value={f.instagram} onChange={(e) => set('instagram', e.target.value)} placeholder="https://instagram.com/…" />
        </Field>
        <Field label="TikTok">
          <input className="in" value={f.tiktok} onChange={(e) => set('tiktok', e.target.value)} placeholder="https://tiktok.com/@…" />
        </Field>
        <Field label="Facebook">
          <input className="in" value={f.facebook} onChange={(e) => set('facebook', e.target.value)} placeholder="https://facebook.com/…" />
        </Field>
        <Field label="Laisser un avis (Google)" hint="Là où partent les demandes d'avis après une prestation notée 4 ou 5.">
          <input className="in" value={f.reviewUrl} onChange={(e) => set('reviewUrl', e.target.value)} />
        </Field>
        <Field label="Itinéraire Google Maps">
          <input className="in" value={f.googleMapsUrl} onChange={(e) => set('googleMapsUrl', e.target.value)} />
        </Field>
        <Field label="Aperçu du lien WhatsApp" hint="Ce que le bouton du site ouvrira dans l'application.">
          {waNum ? (
            <a className="link xs" href={`https://wa.me/${waNum}`} target="_blank" rel="nofollow noopener">
              wa.me/{waNum}
            </a>
          ) : (
            <span className="mut xs">Numéro vide ou non reconnu → le bouton WhatsApp reste masqué sur le site.</span>
          )}
        </Field>
      </div>
      {links.whatsappHref ? (
        <p className="xs ok mt">
          ✓ Lien WhatsApp actif sur la vitrine : <span className="mono">{String(links.whatsappHref).slice(0, 52)}…</span>
        </p>
      ) : (
        <p className="xs warn mt">Bouton WhatsApp éteint côté visiteurs : enregistrez un numéro valide pour l'allumer.</p>
      )}
      {err ? <p className="danger sm">{err}</p> : null}
    </Card>
  );
}

/* ───────────────────────── RÉGLAGES ───────────────────────── */
export function Settings() {
  const toast = useToast();
  const remote = useAsync(() => A.get('settings'), []);
  const s = { ...remote, reload: () => { remote.reload(); void loadCfg(true).catch(() => undefined); } };
  const [tab, setTab] = useState<'services' | 'staff' | 'policy' | 'hours' | 'brand' | 'media' | 'security'>('services');
  const [media, setMedia] = useState({ path: '', alt: '', serviceKey: '', kind: 'photo' });
  if (s.loading && !s.data) return <Skeleton n={4} />;
  // un 403 doit être dit, pas masqué : sinon le barbier voit un écran de réglages vide qui a l'air d'un bug
  if (s.error) return <div className="note bad">{errText(s.error)}</div>;
  const d = s.data ?? {};
  const services = pick(d.services, ['services']);
  const staff = pick(d.staff, ['staff']);
  const pol = d.policy ?? {};
  return (
    <>
      <h2 className="mb">Réglages</h2>
      <div className="tabs mb">
        {([['services', 'Prestations'], ['staff', 'Équipe'], ['policy', 'Règles'], ['hours', 'Horaires'], ['brand', 'Marque'], ['media', 'Médias'], ['security', 'Sécurité']] as const).map(([k, l]) => (
          <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>

      {(!services.some((x: any) => x.is_active) || !staff.some((x: any) => x.is_active)) && <div className="note mb"><b>Ouverture des réservations</b><p>1. Valide les prix et durées, puis publie tes prestations. 2. Renomme et active les vrais barbiers. 3. Vérifie leurs horaires. Les modèles inactifs restent invisibles aux clients.</p>{!services.length && !staff.length && <button className="btn sm" onClick={() => A.post('settings/drafts').then(() => s.reload()).catch(e => toast(errText(e), 'bad'))}>Préparer les modèles privés</button>}</div>}
      {tab === 'services' && <><div className="grid g2">{services.map((x: any) => <ServiceEditor key={`${x.id}-${x.updated_ts}`} row={x} offering={d.offerings?.find((o: any) => o.service_id === x.id && !o.staff_id)} onSaved={s.reload} />)}</div><details className="mt"><summary className="link">Ajouter une prestation</summary><ServiceEditor onSaved={s.reload} /></details></>}
      {tab === 'staff' && <><div className="grid g2">{staff.map((x: any) => <StaffEditor key={`${x.id}-${x.name}-${x.is_active}`} row={x} services={services} onSaved={s.reload} />)}</div><details className="mt"><summary className="link">Ajouter un barbier</summary><StaffEditor services={services} onSaved={s.reload} /></details></>}
      {tab === 'security' && <PasswordEditor />}

      {tab === 'policy' && (
        <Card>
          <div className="grid g2">
            {[
              ['Pas des créneaux (min)', 'slotStepMin'],
              ['Préavis mini (min)', 'leadTimeMin'],
              ['Horizon de réservation (j)', 'horizonDays'],
              ['Délai d’annulation libre (min)', 'cancelCutoffMin'],
              ['Grâce no-show (min)', 'noShowGraceMin'],
              ['TTL offre waitlist (min)', 'waitlistOfferTtlMin'],
              ['Acompte à partir de (cts)', 'depositAboveCents'],
              ['RDV actifs max / client', 'maxActivePerCustomer'],
            ].map(([l, k]) => (
              <Field label={l} key={k}>
                <input
                  type="number"
                  defaultValue={(pol as any)[k] ?? ''}
                  onChange={() => undefined}
                  id={`pol-${k}`}
                />
              </Field>
            ))}
          </div>
          <button
            className="btn"
            onClick={() => {
              const patch: any = {};
              for (const [, k] of [
                ['a', 'slotStepMin'],
                ['b', 'leadTimeMin'],
                ['c', 'horizonDays'],
                ['d', 'cancelCutoffMin'],
                ['e', 'noShowGraceMin'],
                ['f', 'waitlistOfferTtlMin'],
                ['g', 'maxActivePerCustomer'],
              ] as const) {
                const el = document.getElementById(`pol-${k}`) as HTMLInputElement;
                if (el && el.value) patch[k] = Number(el.value);
              }
              A.post('settings', { policy: patch }).then(() => {
                toast('Règles enregistrées — les listes de créneaux sont recalculées à la volée.');
                s.reload();
              }).catch((e) => toast(errText(e), 'bad'));
            }}
          >
            Enregistrer les règles
          </button>
          <p className="mut xs mb0 mt">Ces réglages changent réellement le moteur : préavis, horizon, acomptes, waitlist. Le fichier de règles est versionné et journalisé (audit).</p>
        </Card>
      )}

      {tab === 'hours' && <HoursEditor d={d} onSaved={() => s.reload()} />}

      {tab === 'brand' && <BrandCard d={d} onSaved={() => s.reload()} />}

      {tab === 'media' && (
        <Card>
          <p className="mut sm">
            Les visuels actuels sont des <b>illustrations de démonstration</b> : à remplacer par les vraies photos du salon (droits cédés). Le formulaire accepte une URL, un upload direct étant branché sur le stockage objet en production.
          </p>
          <form
            className="col"
            style={{ gap: 0 }}
            onSubmit={(e) => {
              e.preventDefault();
              A.post('media', media).then(() => {
                toast('Ajouté à la galerie (à valider publiquement).');
                setMedia({ ...media, path: '', alt: '' });
                s.reload();
              });
            }}
          >
            <div className="grid g2">
              <Field label="URL de l’image">
                <input value={media.path} onChange={(e) => setMedia({ ...media, path: e.target.value })} placeholder="/uploads/coupe-01.jpg" required pattern="^/[^\s]*" />
              </Field>
              <Field label="Légende / alt">
                <input value={media.alt} onChange={(e) => setMedia({ ...media, alt: e.target.value })} maxLength={140} />
              </Field>
            </div>
            <div className="grid g2">
              <Field label="Type">
                <select value={media.kind} onChange={(e) => setMedia({ ...media, kind: e.target.value })}>
                  <option value="photo">photo</option>
                  <option value="before_after">avant / après</option>
                  <option value="reel">reel</option>
                </select>
              </Field>
              <Field label="Prestation liée">
                <select value={media.serviceKey} onChange={(e) => setMedia({ ...media, serviceKey: e.target.value })}>
                  <option value="">aucune</option>
                  {pick(d.services, ['services']).map((x: any) => (
                    <option key={x.key} value={x.key}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <button className="btn sm block">Ajouter</button>
          </form>
          <div className="hr" />
          <div className="gal">
            {pick(d.media, ['media', 'gallery']).map((m: any) => (
              <figure key={m.id} style={{ margin: 0 }}>
                <img src={m.path} alt={m.alt ?? ''} {...frameSize(m.aspect)} style={{ borderRadius: 10, aspectRatio: m.aspect ?? '4/5', objectFit: 'cover' }} />
                <figcaption className="xs mut">{m.label ?? m.alt}</figcaption>
                <button className="btn ghost sm block" style={{ marginTop: 6 }} onClick={() => A.post(`media/${m.id}/delete`, {}).then(s.reload)}>
                  retirer
                </button>
              </figure>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
