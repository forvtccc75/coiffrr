import { Salon } from './salon';
import { SALON_MAPS_URL, hoursForDay, REFERENCE_HOURS } from '../../../shared/salon';
import { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { api, availability, clientApi, track, useConfig } from '../lib/api';
import { frameSize, Card, Chip, Field, Seg, Skeleton, Modal, errText, useAsync, useToast } from '../lib/ui';

/** Toutes les pages éditoriales / secondaires : un seul fichier, un seul routeur « catch-all ». */
export function Pages() {
  const { pathname } = useLocation();
  const { cfg } = useConfig();
  const key = pathname.split('/')[1] || '';
  const service = cfg?.services?.find((s: any) => s.key === key);
  if (service) return <ServicePage svc={service} cfg={cfg} />;
  const staff = cfg?.staff?.find((s: any) => s.slug === (key === 'barbier' ? pathname.split('/')[2] : key.replace('barbier-', '')));
  if (staff) return <StaffPage st={staff} cfg={cfg} />;
  switch (key) {
    case 'salon': return <Salon />;
    case 'tarifs':
      return <Tarifs cfg={cfg} />;
    case 'galerie':
      return <Galerie cfg={cfg} />;
    case 'infos':
    case 'infos-pratique':
      return <Infos cfg={cfg} />;
    case 'faq':
      return <Faq cfg={cfg} />;
    case 'cartes-cadeaux':
      return <Gifts cfg={cfg} />;
    case 'mentions-legales':
      return <Legal cfg={cfg} />;
    case 'donnees-personnelles':
      return <Privacy />;
    case 'accessibilite':
      return <Access cfg={cfg} />;
    case 'sitemap-view':
      return <SiteMap />;
    case 'guides':
    case 'guide': {
      // /guides/<court> et l'ancien /guide/<slug-stocké> doivent tous les deux fonctionner :
      // un lien déjà partagé depuis Instagram ne doit jamais atterrir sur un 404.
      const slug = pathname.split('/')[2] ?? '';
      return slug ? <Guide slug={slug} /> : <Guides />;
    }
    default:
      return <NotFound path={pathname} />;
  }
}

function ServicePage({ svc, cfg }: any) {
  const av = useAsync(() => availability({ service: svc.key, days: 10 }), [svc.key]);
  const first = (av.data?.days ?? []).find((d: any) => d.count > 0);
  return (
    <>
      <div className="wrap pad" style={{ paddingBottom: 8 }}>
        <span className="tiny gold">{svc.category}</span>
        <h1>{svc.name}</h1>
        <p className="lead">{svc.description ?? svc.short}</p>
        <div className="row" style={{ margin: '14px 0 20px' }}>
          <Chip>{svc.durationMin} min</Chip>
          <Chip tone="gold">{eur(svc.priceCents)}</Chip>
          {svc.problem && <Chip>{svc.problem}</Chip>}
        </div>
        <div className="grid g2" style={{ alignItems: 'start' }}>
          <Card>
            <h4>Ce qui est inclus</h4>
            <p className="sm">{svc.solution ?? 'Diagnostic, coupe, finitions au rasoir, conseils d’entretien.'}</p>
            {svc.addons?.length > 0 && (
              <>
                <div className="hr" />
                <h4>À combiner</h4>
                {svc.addons.map((a: any) => (
                  <div className="item" key={a.id}>
                    <span>
                      <b style={{ fontWeight: 600 }}>{a.name}</b>
                      <span className="mut xs" style={{ display: 'block' }}>{a.hint ?? ''}</span>
                    </span>
                    <span className="sm">{eur(a.priceCents)}</span>
                  </div>
                ))}
              </>
            )}
          </Card>
          <Card className="hl">
            <h4>Prochaine dispos</h4>
            {first ? (
              <>
                <p className="sm mb0">
                  {first.weekday} {first.label} — {first.count} créneaux libres · dès {first.slots[0].time}
                </p>
                <div className="row" style={{ marginTop: 10 }}>
                  <Link className="btn" to={`/book?service=${svc.key}&slot=${first.slots[0].ts}&day=${first.day}`}>
                    Prendre {first.slots[0].time}
                  </Link>
                  <Link className="btn ghost" to={`/book?service=${svc.key}`}>
                    Choisir l’horaire
                  </Link>
                </div>
              </>
            ) : (
              <>
                <p className="sm">
                  Rien dans les 10 jours — <Link className="link" to={`/waitlist?service=${svc.key}`}>la waitlist récupère les annulations</Link>.
                </p>
                {/* jamais de porte fermée : on propose aussi d’aller voir plus loin dans l’agenda */}
                <div className="row" style={{ marginTop: 10 }}>
                  <Link className="btn sm" to={`/book?service=${svc.key}`}>
                    Choisir un autre jour
                  </Link>
                </div>
              </>
            )}
            {av.loading && <Skeleton n={1} />}
          </Card>
        </div>
      </div>
      {svc.faq?.length > 0 && (
        <div className="wrap" style={{ paddingBottom: 40 }}>
          <h2>Questions sur cette prestation</h2>
          <div className="grid g2">
            {svc.faq.map((f: any) => (
              <Card key={f.q}>
                <h3 style={{ fontSize: 16 }}>{f.q}</h3>
                <p className="mut sm mb0">{f.a}</p>
              </Card>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function StaffPage({ st, cfg }: any) {
  const av = useAsync(() => availability({ service: 'coupe-homme', days: 14, staff: st.slug }), [st.slug]);
  const total = av.data?.summary?.totalCount ?? 0;
  return (
    <div className="wrap pad" style={{ maxWidth: 720 }}>
      <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
        <span className="avatar" style={{ width: 64, height: 64, fontSize: 26 }}>
          {st.name.slice(0, 1)}
        </span>
        <div>
          <span className="tiny gold">{st.title ?? 'Barbier'}</span>
          <h1 className="mb0">{st.name}</h1>
        </div>
      </div>
      <p className="mut" style={{ marginTop: 12 }}>{st.bio ?? 'Spécialiste du dégradé et des finitions au rasoir.'}</p>
      <Card className="hl">
        <h4>{total > 0 ? `${total} créneaux libres chez ${st.name.split(' ')[0]}` : 'Aucun créneau libre pour l’instant'}</h4>
        <div className="row">
          <Link className="btn" to={`/book?staff=${st.slug}`}>
            Réserver avec {st.name.split(' ')[0]}
          </Link>
          {total === 0 && (
            <Link className="btn ghost" to={`/waitlist?staff=${st.slug}`}>
              Waitlist
            </Link>
          )}
        </div>
      </Card>
    </div>
  );
}

function Tarifs({ cfg }: any) {
  const groups = useMemoCategories(cfg?.services ?? []);
  return (
    <div className="wrap pad">
      <span className="tiny gold">Catalogue</span>
      <h1>Tarifs</h1>
      <p className="mut">Prix nets, sans supplément caché. Le temps indiqué inclut la préparation et le nettoyage du poste — c’est pour ça que tu es pris à l’heure.</p>
      {Object.entries(groups).map(([cat, list]: any) => (
        <section key={cat} style={{ marginTop: 22 }}>
          <h2 style={{ fontSize: 20 }}>{cat}</h2>
          <div className="col" style={{ gap: 8 }}>
            {list.map((s: any) => (
              <Link key={s.key} to={`/book?service=${s.key}`} className="svc" style={{ cursor: 'pointer' }}>
                <span className="ico">{s.name.slice(0, 1)}</span>
                <span>
                  <b>{s.name}</b>
                  <span className="sub">{s.short ?? `${s.durationMin} min`}</span>
                </span>
                <span className="price">
                  {eur(s.priceCents)}
                  <span className="sub" style={{ display: 'block', textAlign: 'right' }}>{s.durationMin} min</span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      ))}
      {cfg?.addons?.length > 0 && (
        <section style={{ marginTop: 22 }}>
          <h2 style={{ fontSize: 20 }}>Options</h2>
          <div className="grid g3">
            {cfg.addons.map((a: any) => (
              <Card key={a.id}>
                <b>{a.name}</b>
                <p className="mut xs mb0">
                  {eur(a.priceCents)} {a.durationMin ? `· +${a.durationMin} min` : ''}
                  <br />
                  {a.hint ?? ''}
                </p>
              </Card>
            ))}
          </div>
        </section>
      )}
      <div className="row" style={{ marginTop: 22 }}>
        <Link className="btn" to="/book">
          Réserver
        </Link>
        <Link className="btn ghost" to="/cartes-cadeaux">
          Offrir une carte cadeau
        </Link>
      </div>
    </div>
  );
}

function Galerie({ cfg }: any) {
  const [kind, setKind] = useState<'all' | 'coupe' | 'barbe' | 'salon'>('all');
  const [photo, setPhoto] = useState<any>(null);
  const items = (cfg?.gallery ?? []).filter((g: any) => (kind === 'all' ? true : g.kind === kind || g.label?.toLowerCase().includes(kind)));
  useEffect(() => track('gallery_view', '/galerie'), []);
  return (
    <div className="wrap pad">
      <h1>Galerie</h1>
      <p className="mut">Découvre le salon en images. Clique sur une photo pour l’agrandir.</p>
      <Seg label="Filtrer" value={kind} options={[{ value: 'all', label: 'Tout' }, { value: 'coupe', label: 'Coupes' }, { value: 'barbe', label: 'Barbes' }, { value: 'salon', label: 'Le salon' }]} onChange={(v) => setKind(v as any)} />
      <div className="gal mt" style={items.length === 1 ? { gridTemplateColumns: 'minmax(0, 900px)', justifyContent: 'center' } : undefined}>
        {items.map((g: any) => (
          <button key={g.id} type="button" aria-label={`Agrandir : ${g.alt || g.label || 'photo du salon'}`} onClick={() => setPhoto(g)} style={{ padding: 0, background: 'none', color: 'inherit', border: 0, textAlign: 'left', cursor: 'zoom-in' }}>
            <figure>
              <img src={g.path} alt={g.alt ?? 'Réalisation Z.YASS'} loading="lazy" {...frameSize(g.aspect)} style={{ aspectRatio: g.aspect, height: 'auto', objectFit: 'contain' }} />
              <figcaption>
                <span>{g.label ?? g.alt}</span>
                {g.service_key && <span className="gold xs">{g.price_cents ? eur(g.price_cents) : 'réserver'}</span>}
              </figcaption>
            </figure>
          </button>
        ))}
        {!items.length && (
          <Card>
            <p className="mb0 mut sm">Aucune image pour ce filtre.</p>
          </Card>
        )}
      </div>
      {cfg?.demo && <div className="note mt">En mode démo, les illustrations ne constituent pas des réalisations du salon.</div>}
      {photo && <Modal open title={photo.label || 'Photo du salon'} onClose={() => setPhoto(null)}><img src={photo.path} alt={photo.alt || 'Le salon'} style={{ width: '100%', height: 'auto', maxHeight: '70vh', objectFit: 'contain' }} />{String(photo.path).includes('google') && <p className="mut xs">Photo issue de la fiche Google du salon, republiée avec autorisation. <a className="link" href={SALON_MAPS_URL} target="_blank" rel="noopener noreferrer">Voir la fiche</a></p>}{photo.service_key && <Link className="btn" to={`/book?service=${photo.service_key}`}>Réserver cette prestation</Link>}</Modal>}
    </div>
  );
}

function Infos({ cfg }: any) {
  const walk = useAsync(() => api('/api/public/walkin').catch(() => null), []);
  return (
    <div className="wrap pad" style={{ maxWidth: 860 }}>
      <h1>Infos pratiques</h1>
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <Card>
          <h4>Adresse</h4>
          <p className="sm mb0">
            Z.YASS Barber Shop
            <br />
            20 boulevard Roy, 93320 Les Pavillons-sous-Bois
          </p>
          <div className="row" style={{ marginTop: 10 }}>
            <a className="btn ghost sm" href={cfg?.links?.googleMaps || SALON_MAPS_URL} target="_blank" rel="nofollow noopener noreferrer">
              Itinéraire
            </a>
            <a className="btn ghost sm" href={cfg?.links?.tel ?? 'tel:+33644048385'}>
              06 44 04 83 85
            </a>
          </div>
          <div className="hr" />
          <p className="sm mut mb0">{cfg?.salon?.address?.directions ?? 'Parking gratuit sur le boulevard, face au boulanger.'}</p>
        </Card>
        <Card>
          <h4>Horaires</h4>
          {cfg?.salon?.brand?.hoursSource && !cfg?.salon?.brand?.hoursConfirmed && <p className="mut xs">Horaires de référence à confirmer auprès du salon.</p>}
          <div className="tx" tabIndex={0} role="region" aria-label="Tableau — défilement horizontal"><table className="t">
            <tbody>
              {['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'].map((d, i) => {
                const formattedHours = hoursForDay(cfg?.salon?.hours ?? REFERENCE_HOURS, (i + 1) % 7);
                return (
                  <tr key={d}>
                    <td>{d}</td>
                    <td className="right">{formattedHours}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
          {walk.data?.enabled && (
            <p className="sm mb0" style={{ marginTop: 10 }}>
              <b className="gold">Sans RDV :</b> {walk.data.waiting} en attente, {walk.data.freeNow > 0 ? `${walk.data.freeNow} fauteuil(s) libre(s) maintenant` : 'complet pour l’instant'} — estimation basée sur les RDV en cours.
            </p>
          )}
        </Card>
        <Card>
          <h4>Règles du salon</h4>
          <ul className="sm" style={{ paddingLeft: 18, margin: 0, color: 'rgba(244,241,234,.8)' }}>
            <li>Annulation libre jusqu’à {Math.round((cfg?.policy?.cancelCutoffMin ?? 240) / 60)} h avant, sinon appelle-nous.</li>
            <li>Plus de 10 min de retard : le créneau peut être raccourci pour ne pas décaler les suivants.</li>
            <li>Acompte demandé seulement au-delà de {eur(cfg?.policy?.deposit?.aboveCents ?? 4500)} (longues prestations).</li>
            <li>Enfants bienvenus, chaise adaptée ; deux adultes simultanés sur demande.</li>
            <li>Non-fumeur, animaux d’assistance acceptés.</li>
          </ul>
        </Card>
        <Card>
          <h4>Paiements</h4>
          <p className="sm mb0">Espèces, carte, tickets restaurant non acceptés. Carte cadeau acceptée en ligne (code saisi à la réservation). Facture sur demande au 06 44 04 83 85.</p>
          <div className="hr" />
          <h4>Suivre le salon</h4>
          <div className="row">
            {cfg?.links?.whatsappHref && (
              <a className="chip gold" href={cfg.links.whatsappHref} target="_blank" rel="nofollow noopener">
                WhatsApp
              </a>
            )}
            {cfg?.links?.instagram && <a className="chip" href={cfg.links.instagram} target="_blank" rel="nofollow noopener">Instagram</a>}
            {cfg?.links?.tiktok && <a className="chip" href={cfg.links.tiktok} target="_blank" rel="nofollow noopener">TikTok</a>}
            <a className="chip" href={cfg?.links?.googleMaps || SALON_MAPS_URL} target="_blank" rel="nofollow noopener">Google Maps</a>
            {cfg?.links?.review && (
              <a className="chip gold" href={cfg.links.review} target="_blank" rel="nofollow noopener">
                Laisser un avis
              </a>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Faq({ cfg }: any) {
  const faqs = useMemoFaq(cfg);
  return (
    <div className="wrap pad" style={{ maxWidth: 760 }}>
      <h1>Questions fréquentes</h1>
      {faqs.map((f: any) => (
        <details key={f.q} className="card" style={{ marginBottom: 8 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600, padding: '2px 0' }}>{f.q}</summary>
          <p className="mut sm mb0" style={{ marginTop: 8 }}>
            {f.a}
          </p>
        </details>
      ))}
      <div className="note mt">
        Une autre question ? <a className="link" href={cfg?.links?.tel ?? 'tel:+33644048385'}>06 44 04 83 85</a> — on répond entre deux coupes.
      </div>
    </div>
  );
}

function Gifts({ cfg }: any) {
  const toast = useToast();
  const [amount, setAmount] = useState(3000);
  const [form, setForm] = useState({ buyerName: '', buyerEmail: '', recipientName: '', message: '', serviceKey: '' });
  const [out, setOut] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [check, setCheck] = useState({ code: '', data: null as any, error: '' });
  useEffect(() => track('gift_view', '/cartes-cadeaux'), []);

  if (cfg?.payments?.online === false) return (
    <div className="wrap pad" style={{ maxWidth: 700 }}>
      <p className="kick">Un cadeau, un vrai moment au salon</p>
      <h1>Offrir une carte cadeau</h1>
      <Card><h2>À retirer et régler au salon</h2>
        <p>Aucun achat en ligne. Choisis le montant au comptoir : l’équipe active la carte après encaissement.</p>
        <p>20 boulevard Roy, 93320 Les Pavillons-sous-Bois.</p>
        <a className="btn" href={`tel:${cfg?.salon?.phone ?? '+33644048385'}`}>Appeler le salon</a>
      </Card>
    </div>
  );
  if (out)
    return (
      <div className="wrap pad center" style={{ maxWidth: 560 }}>
        <h1>Carte prête à offrir ✔</h1>
        <p className="lead" style={{ margin: '0 auto 14px' }}>{out.note}</p>
        <Card className="hl">
          <span className="mut xs">Code</span>
          <div className="code" style={{ fontSize: 26, letterSpacing: '.18em' }}>{out.code ?? 'en attente de paiement'}</div>
          <p className="sm mut mb0">
            {eur(out.amountCents)} · valable 12 mois · utilisable en ligne au moment de la réservation.
            {out.recipientName ? ` Destinataire : ${out.recipientName}.` : ''}
          </p>
          <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
            <button
              className="btn ghost sm"
              onClick={() => {
                navigator.clipboard?.writeText(out.code ?? '');
                toast('Code copié.');
              }}
            >
              Copier le code
            </button>
            <a className="btn sm" href={out.bookUrl}>
              Ouvrir la réservation
            </a>
          </div>
        </Card>
      </div>
    );

  return (
    <div className="wrap pad" style={{ maxWidth: 780 }}>
      <h1>Cartes cadeaux</h1>
      <p className="mut">Le cadeau qui ne rate jamais son effet : le destinataire choisit son créneau, son barbier, son heure. Valable 12 mois, cumulable avec les points fidélité.</p>
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <Card className="hl">
          <h4>Montant</h4>
          <Seg label="Montant" value={amount} options={[{ value: 2000, label: '20 €' }, { value: 3000, label: '30 €' }, { value: 5000, label: '50 €' }, { value: 10000, label: '100 €' }]} onChange={(v) => setAmount(v as number)} />
          <form
            className="col"
            style={{ gap: 0, marginTop: 12 }}
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setErr(null);
              try {
                const f = new FormData(e.target as HTMLFormElement);
                const res = await api('/api/public/gift-cards', {
                  method: 'POST',
                  body: {
                    amountCents: amount,
                    buyerName: String(f.get('buyerName')),
                    buyerEmail: String(f.get('buyerEmail')),
                    recipientName: String(f.get('recipientName')) || undefined,
                    message: String(f.get('message')) || undefined,
                    serviceKey: String(f.get('serviceKey')) || undefined,
                  },
                });
                setOut(res);
              } catch (e2) {
                setErr(e2);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Ton nom">
              <input name="buyerName" required minLength={2} maxLength={60} value={form.buyerName} onChange={(e) => setForm({ ...form, buyerName: e.target.value })} autoComplete="name" />
            </Field>
            <Field label="Ton e-mail" hint="Tu reçois le code, prêt à imprimer ou envoyer.">
              <input name="buyerEmail" type="email" required value={form.buyerEmail} onChange={(e) => setForm({ ...form, buyerEmail: e.target.value })} autoComplete="email" />
            </Field>
            <div className="grid g2">
              <Field label="Pour qui ?">
                <input name="recipientName" maxLength={60} value={form.recipientName} onChange={(e) => setForm({ ...form, recipientName: e.target.value })} />
              </Field>
              <Field label="Prestation ciblée (facultatif)">
                <select name="serviceKey" value={form.serviceKey} onChange={(e) => setForm({ ...form, serviceKey: e.target.value })}>
                  <option value="">Carte libre</option>
                  {(cfg?.services ?? []).map((s: any) => (
                    <option key={s.key} value={s.key}>
                      {s.name} — {eur(s.priceCents)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Message">
              <textarea name="message" maxLength={240} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} placeholder="Bon anniv — offre-toi un dégradé propre." />
            </Field>
            {err && <div className="note bad">{errText(err)}</div>}
            <button className="btn lg block" disabled={busy}>
              {busy ? '…' : `Acheter — ${eur(amount)}`}
            </button>
            <p className="mut xs center mb0" style={{ marginTop: 8 }}>
              Paiement sécurisé (Stripe). En démo : la carte est activée sans débit.
            </p>
          </form>
        </Card>
        <div className="col" style={{ gap: 12 }}>
          <Card>
            <h4>Vérifier un code</h4>
            <form
              onSubmit={async (e: any) => {
                e.preventDefault();
                const code = new FormData(e.target).get('code');
                try {
                  const d = await api(`/api/public/gift-cards/${encodeURIComponent(String(code))}`);
                  setCheck({ code: String(code), data: d, error: '' });
                } catch (e2) {
                  setCheck({ code: String(code), data: null, error: errText(e2) });
                }
              }}
              className="row"
              style={{ alignItems: 'flex-end' }}
            >
              <div style={{ flex: 1 }}>
                <Field label="">
                  <input name="code" placeholder="ZY-XXXX-XXXX" className="code" style={{ fontSize: 16, letterSpacing: '.1em', textAlign: 'left' }} />
                </Field>
              </div>
              <button className="btn sm">Vérifier</button>
            </form>
            {check.data && (
              <p className="sm mb0">
                <b className="gold">{eur(check.data.balanceCents)}</b> disponibles · statut {check.data.status}
                {check.data.service ? ` · ${check.data.service}` : ''}
                <br />
                <Link className="link" to={`/book?gift=${check.code}`}>
                  réserver avec ce code
                </Link>
              </p>
            )}
            {check.error && <p className="err sm mb0">{check.error}</p>}
          </Card>
          <Card>
            <h4>Pourquoi ça marche</h4>
            <ul className="sm" style={{ paddingLeft: 18, margin: 0, color: 'rgba(244,241,234,.8)' }}>
              <li>Le destinataire prend lui-même le créneau : zéro échange de SMS compliqué.</li>
              <li>Le solde restant reste utilisable (pas de perte si la prestation coûte moins cher).</li>
              <li>Paiement en ligne, code immédiat, valable 12 mois.</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Legal({ cfg }: any) {
  return (
    <div className="wrap pad" style={{ maxWidth: 720 }}>
      <h1>Mentions légales</h1>
      <Card>
        <p className="sm">
          <b>Éditeur</b> : Z YASS BARBER SHOP, SARL au capital de 1 000 €, 20 boulevard Roy, 93320 Les Pavillons-sous-Bois.
          <br />
          SIREN 918 535 071 · SIRET (siège) 918 535 071 00016 · RCS Bobigny (918 535 071 R.C.S. Bobigny, immatriculation
          du 23/08/2022) · TVA intracommunautaire FR28918535071 · activité exercée sous le code APE 96.02A
          (coiffure), forme artisanale non réglementée.
          <br />
          Gérant : M. Amiour Zineddine. Téléphone : 06 44 04 83 85 · Courriel : contact@zyass.fr
        </p>
        <p className="sm">
          <b>Hébergement</b> : application web — Vercel Inc. (États-Unis), contact via vercel.com/legal. Base de
          données — Supabase (Postgres managé, zone UE). La loi pour la confiance dans la communication numérique
          exige le nom, l’adresse et le contact de l’hébergeur : à compléter au moment de la mise en ligne à partir
          de la page légale du prestataire retenu (le guide de déploiement fournit le bloc prêt à remplir).
          <br />
          <b>Responsable de traitement</b> : le gérant susnommé. DPO interne : contact@zyass.fr.
        </p>
        <p className="sm mb0">
          <b>Propriété</b> : les visuels de prestations sont la propriété du salon. Les photos de démonstration générées pour la maquette sont signalées comme telles et destinées à être remplacées.
        </p>
      </Card>
    </div>
  );
}

function Privacy() {
  return (
    <div className="wrap pad" style={{ maxWidth: 720 }}>
      <h1>Données personnelles</h1>
      <Card>
        <p className="sm">Ce que le salon conserve pour te réserver un créneau : prénom, nom, téléphone, e-mail (facultatif), notes transmises au barbier, historique de visites, consentements.</p>
        <p className="sm">
          <b>Finalités</b> : exécution du rendez-vous, rappels de sécurité (SMS), fidélité et parrainage, et uniquement avec ton accord : messages marketing (max 4 / 7 jours, aucune nuit).
        </p>
        <p className="sm">
          <b>Durées</b> : 3 ans après le dernier rendez-vous pour la relation client ; 10 ans pour les pièces comptables (obligation légale), sous forme anonymisée pour les statistiques.
        </p>
        <p className="sm">
          <b>Tes droits</b> : accès, rectification, effacement, portabilité, limitation, opposition. Tout est automatisé depuis <Link className="link" to="/espace">ton espace</Link> (export JSON en 1 clic, suppression en 1 clic), ou par courriel à contact@zyass.fr. Réponse sous 30 jours.
        </p>
        <p className="sm mb0">
          <b>Traceurs</b> : un identifiant de visite anonyme (localStorage, 12 mois) sert uniquement à mesurer l'entonnoir de réservation et à reprendre un panier abandonné. Aucun cookie publicitaire, aucun pistage tiers.
        </p>
      </Card>
    </div>
  );
}

function Access({ cfg }: any) {
  return (
    <div className="wrap pad" style={{ maxWidth: 720 }}>
      <h1>Accessibilité</h1>
      <Card>
        <p className="sm mb0">
          Ce site vise le niveau AA du RGAA 4.1 : contraste des textes ≥ 4,5:1, navigation clavier complète (tabulation, Entrée, Échap), libellés de champ, focus visible, zone tactile ≥ 44 px, messages d’état annoncés en <code>aria-live</code>, respect de
          <code> prefers-reduced-motion</code>, texte alternatif sur les images, et réservation possible intégralement au clavier.
        </p>
        <p className="sm mb0">
          Réservation par téléphone pour les personnes qui préfèrent : <a className="link" href={cfg?.links?.tel}>06 44 04 83 85</a>. Signalement d’un obstacle : contact@zyass.fr (correction sous 30 jours).
        </p>
      </Card>
    </div>
  );
}

function Guides() {
  const { data } = useAsync(() => api('/api/public/content-pages').catch(() => ({ pages: [] })), []);
  return (
    <div className="wrap pad">
      <h1>Guides du salon</h1>
      <div className="grid g2">
        {(data?.pages ?? []).filter((p: any) => p.kind === 'guide' || String(p.slug).startsWith('guide-')).map((p: any) => (
          <Card key={p.slug}>
            <h3>{p.title}</h3>
            <p className="mut sm">{p.summary}</p>
            <Link className="link xs" to={`/guides/${String(p.slug).replace(/^guide-/, '')}`}>
              lire
            </Link>
          </Card>
        ))}
        {!(data?.pages ?? []).length && <p className="mut sm">Les guides seront publiés ici.</p>}
      </div>
    </div>
  );
}

function Guide({ slug }: { slug: string }) {
  const { data, loading, error } = useAsync(() => api(`/api/public/content-pages/${encodeURIComponent(slug)}`), [slug]);
  if (loading)
    return (
      <div className="wrap pad">
        <h1 className="mb0">Guide du salon</h1>
        <Skeleton n={4} />
      </div>
    );
  if (error || !data?.page)
    return (
      <div className="wrap pad">
        <div className="note">Ce guide n’est pas encore publié. <Link className="link" to="/guides">Voir les guides disponibles</Link>.</div>
      </div>
    );
  const p = data.page;
  return (
    <div className="wrap pad" style={{ maxWidth: 720 }}>
      <span className="tiny gold">Guide · {p.readingMin} min</span>
      <h1>{p.title}</h1>
      <p className="lead">{p.summary}</p>
      {(p.blocks ?? []).map((b: any, i: number) =>
        typeof b === 'string' ? (
          <p key={i} className="mut">
            {b}
          </p>
        ) : b.type === 'h2' ? (
          <h2 key={i} style={{ fontSize: 20, marginTop: 20 }}>
            {b.text}
          </h2>
        ) : b.type === 'cta' ? (
          <div className="row" key={i} style={{ margin: '16px 0' }}>
            <Link className="btn" to={b.to ?? '/book'}>
              {b.label ?? 'Réserver'}
            </Link>
          </div>
        ) : (
          <p key={i} className="mut">
            {b.text ?? ''}
          </p>
        ),
      )}
      {p.faq?.length > 0 && (
        <>
          <h2 style={{ fontSize: 20, marginTop: 24 }}>Questions fréquentes</h2>
          {p.faq.map((f: any) => (
            <details key={f.q} className="card" style={{ marginBottom: 8 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{f.q}</summary>
              <p className="mut sm mb0" style={{ marginTop: 8 }}>{f.a}</p>
            </details>
          ))}
        </>
      )}
      <div className="row mt">
        <Link className="btn" to="/book">
          Réserver après lecture
        </Link>
        <Link className="btn ghost" to="/guides">
          autres guides
        </Link>
      </div>
    </div>
  );
}

function SiteMap() {
  const { cfg } = useConfig();
  const links = [
    ['/', 'Accueil'],
    ['/book', 'Réserver'],
    ['/waitlist', 'Waitlist'],
    ['/tarifs', 'Tarifs'],
    ['/galerie', 'Galerie'],
    ['/infos', 'Infos pratiques'],
    ['/faq', 'FAQ'],
    ['/cartes-cadeaux', 'Cartes cadeaux'],
    ['/espace', 'Espace client'],
    ['/accessibilite', 'Accessibilité'],
    ['/mentions-legales', 'Mentions légales'],
    ['/donnees-personnelles', 'Données personnelles'],
  ];
  return (
    <div className="wrap pad" style={{ maxWidth: 640 }}>
      <h1>Plan du site</h1>
      {links.map(([to, label]) => (
        <div className="item" key={to}>
          <Link to={to} className="link">
            {label}
          </Link>
          <span className="mut xs">{to}</span>
        </div>
      ))}
      <h4 style={{ marginTop: 18 }}>Prestations</h4>
      {(cfg?.services ?? []).map((s: any) => (
        <div className="item" key={s.key}>
          <Link to={`/book?service=${s.key}`} className="link">
            {s.name}
          </Link>
          <span className="sm">{eur(s.priceCents)}</span>
        </div>
      ))}
    </div>
  );
}

function NotFound({ path }: { path: string }) {
  const { cfg } = useConfig();
  return (
    <div className="wrap pad" style={{ maxWidth: 620 }}>
      <h1>Page introuvable</h1>
      <p className="mut">Rien à cette adresse ({path}). Pas de panique : le plus utile est juste là.</p>
      <div className="row">
        <Link className="btn lg" to="/book">
          Réserver un créneau
        </Link>
        <Link className="btn ghost" to="/waitlist">
          Waitlist
        </Link>
        <a className="btn ghost" href={cfg?.links?.tel}>
          Appeler
        </a>
      </div>
      <Card className="mt">
        <h4>Les plus consultés</h4>
        {['/tarifs', '/infos', '/galerie', '/cartes-cadeaux'].map((to) => (
          <Link key={to} to={to} className="item" style={{ background: 'none', color: 'inherit' }}>
            <span className="link">{to}</span> <span className="mut xs">→</span>
          </Link>
        ))}
      </Card>
    </div>
  );
}

const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: c % 100 ? 2 : 0 }).format(c / 100));

function useMemoCategories(list: any[]) {
  const out: Record<string, any[]> = {};
  for (const s of list ?? []) (out[s.category || 'Autres'] ||= []).push(s);
  return out;
}

function useMemoFaq(cfg: any) {
  const base = [
    { q: 'Faut-il payer à la réservation ?', a: 'Non : tu réserves en ligne et tu règles ta prestation au salon. Aucun acompte en ligne.' },
    { q: 'Et si je ne peux plus venir ?', a: `Tu annules ou tu décales depuis le lien reçu, jusqu’à ${Math.round((cfg?.policy?.cancelCutoffMin ?? 240) / 60)} h avant. Le créneau libéré peut être proposé à la liste d’attente.` },
    { q: 'C’est complet, je fais quoi ?', a: 'Tu rejoins la waitlist en 30 secondes. Dès qu’un créneau compatible se libère, tu reçois un SMS avec un lien de réservation prioritaire valable quelques minutes.' },
    { q: 'Puis-je choisir mon barbier ?', a: 'Oui. Tu peux aussi choisir « peu importe » : le moteur attribue le premier barbier compétent libre, ce qui débloque des créneaux plus tôt.' },
    { q: 'Les prix sont-ils les mêmes en ligne et au salon ?', a: 'Identiques, sans supplément de réservation. Les forfaits étudiants et enfants sont dans le catalogue.' },
    { q: 'Acceptez-vous les enfants ?', a: 'Oui, à partir de 3 ans (coupe enfant 25 min). Une chaise adaptée et un barbier patient ; viens 5 min avant pour la mise en place.' },
    { q: 'Retard ?', a: 'Jusqu’à 10 minutes, on rattrape. Au-delà, la prestation peut être raccourcie pour ne pas décaler les clients suivants — préviens-nous par téléphone.' },
    { q: 'Comment nettoyer les outils entre deux clients ?', a: 'Systématiquement : désinfection des peignes/tondeuses, lames neuves à usage unique pour le rasage, serviettes propres par client. Les 5 minutes entre deux RDV sont prévues dans le planning.' },
  ];
  const svcFaq = (cfg?.services ?? []).flatMap((s: any) => (s.faq ?? []).map((f: any) => ({ q: `${s.name} — ${f.q}`, a: f.a })));
  return [...base, ...svcFaq].slice(0, 14);
}
