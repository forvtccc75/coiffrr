import { SALON_MAPS_URL, compactHours, REFERENCE_HOURS } from '../../../shared/salon';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { availability, loadCfg, track, useConfig, when } from '../lib/api';
import { frameSize, Card, Chip, Section, Skeleton, Stars, useAsync } from '../lib/ui';

/**
 * Page d'accueil = argument commercial + moteur de réservation visible immédiatement.
 * Rien d'inventé : les compteurs viennent du serveur (live.nextSlot, slotsThisWeek).
 */
export function Home() {
  const { cfg, error } = useConfig();
  const [svcKey, setSvcKey] = useState<string>('coupe-homme');
  const [hideUi, setHideUi] = useState(false);
  const services = cfg?.services ?? [];
  const openingSoon = !!cfg && (!services.length || !cfg.staff?.length);

  useEffect(() => {
    if (!cfg) return;
    const popular = [...services].sort((a: any, b: any) => (b.popular ? 1 : 0) - (a.popular ? 1 : 0))[0];
    if (popular) setSvcKey(popular.key);
    const p = new URLSearchParams(location.search);
    if (p.get('service')) setSvcKey(p.get('service')!);
    try { if (sessionStorage.getItem('zyass_book_ui') === '1') setHideUi(true); } catch { /* navigation privée sans stockage */ }
    track('visit', '/', { referrer: document.referrer ? location.origin : null });
  }, [!!cfg]);

  const av = useAsync(() => (services.length ? availability({ service: svcKey, days: 4 }) : Promise.resolve(null)), [svcKey, services.length]);
  const days = av.data?.days ?? [];
  const live = useMemo(() => {
    const out: { day: string; slots: any[]; label: string; closed?: string }[] = [];
    for (const d of days) out.push({ day: d.day, label: d.label, slots: (d.slots ?? []).slice(0, 8), closed: d.closed });
    return out;
  }, [days]);
  const total = av.data?.summary?.totalCount ?? 0;

  const firstReal = cfg?.reviews?.list?.filter((r: any) => r.comment && r.comment.length > 12).slice(0, 3) ?? [];
  const rating = cfg?.reviews;

  /* Le titre est l'engagement SEO de la page ; la ligne du dessous ne doit pas le répéter mot
     pour mot (à l'écran comme dans le résumé des moteurs). Une seule source pour les deux. */
  const titleA = 'Le dégradé net, la barbe propre,';
  const titleB = 'sans attendre.';
  const title = `${titleA} ${titleB}`;
  const tagline = String(cfg?.salon?.brand?.tagline ?? '').trim();
  const same = tagline.toLowerCase().replace(/[^a-z0-9à-ÿ]/g, '') === title.toLowerCase().replace(/[^a-z0-9à-ÿ]/g, '');
  const lead =
    tagline && !same
      ? tagline
      : 'Coupe, barbe et rasage traditionnel aux Pavillons-sous-Bois. Règlement au salon et liste d’attente pour être prévenu lorsqu’un créneau compatible se libère.';

  return (
    <>
      <section className="hero">
        <div className="hero-bg">
          <img src="/brand/hero.jpg" alt="" width={1600} height={1000} {...({ fetchpriority: "high" } as any)} />
        </div>
        <div className="wrap hero-in">
          <span className="kicker">
            <span className="dot" /> {cfg?.live?.nextSlot ? `prochaine dispo : ${cfg.live.nextSlot.label}` : openingSoon ? 'réservation en ligne en préparation' : 'réservation en ligne'}
          </span>
          <h1>
            {titleA}
            <br />
            <em>{titleB}</em>
          </h1>
          {/* le tagline de la marque est parfois la promesse du titre : le répéter en dessous
              ferait doublon à l'écran et deux lignes identiques dans le résumé des moteurs. */}
          <p className="lead">{lead}</p>
          <div className="actions">
            <Link className="btn lg" to={openingSoon ? '/book' : `/book?service=${svcKey}`}>
              Réserver un créneau
            </Link>
            <Link className="btn lg ghost" to="/waitlist">
              {openingSoon ? 'Être prévenu de l’ouverture du planning' : 'Rejoindre la liste d’attente'}
            </Link>
          </div>
          {cfg?.links?.whatsappHref ? (
            <p className="mut xs" style={{ marginTop: 10 }}>
              Un cas particulier, une question ?{' '}
              <a className="link" href={cfg.links.whatsappHref} rel="nofollow noopener" target="_blank">
                écrivez-nous sur WhatsApp
              </a>{' '}
              — on répond entre deux fauteuils.
            </p>
          ) : null}
          <ul className="hero-foot">
            {['Paiement sur place', 'Rappel J-1 et confirmation en 1 clic', 'Annulé ? on te rappelle en priorité'].map((x) => (
              <li key={x}>
                <Chip>{x}</Chip>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <Section kicker={openingSoon ? "Ouverture prochaine" : "Disponibilités"} title={openingSoon ? "Le planning se prépare" : `Choisis ton créneau — ${cfg?.services?.find((s: any) => s.key === svcKey)?.name ?? ''}`}>
        <Card className="hl">
          <div className="spread" style={{ marginBottom: 12 }}>
            <div className="row" style={{ gap: 8 }}>
              {[...services]
                .sort((a: any, b: any) => (b.popular ? 1 : 0) - (a.popular ? 1 : 0))
                .slice(0, 4)
                .map((s: any) => (
                  <button
                    key={s.key}
                    className={`chip ${svcKey === s.key ? 'gold' : ''}`}
                    style={{ cursor: 'pointer', background: 'none', border: 'none', boxShadow: svcKey === s.key ? 'inset 0 0 0 1px var(--gold)' : 'inset 0 0 0 1px var(--line)' }}
                    onClick={() => setSvcKey(s.key)}
                  >
                    {s.name}
                  </button>
                ))}
              <Link to="/tarifs" className="chip" style={{ background: 'none' }}>
                tout le catalogue →
              </Link>
            </div>
            {error ? <Chip tone="bad">hors ligne</Chip> : openingSoon ? <Chip>À venir</Chip> : av.loading ? <Chip>chargement…</Chip> : <Chip tone="ok">{total} créneaux sur 4 jours</Chip>}
          </div>

          {error || av.error ? <div className="note bad">Planning temporairement inaccessible. <button className="link" onClick={() => { void loadCfg(true).catch(() => undefined); av.reload(); }}>Réessayer</button> ou <a href="tel:+33644048385" className="link">appeler le salon</a>.</div> : cfg && (!services.length || !cfg.staff?.length) ? <div className="note">La réservation en ligne est en préparation. <a className="link" href="tel:+33644048385">Appelle le salon pour prendre rendez-vous.</a></div> : av.loading && !days.length ? (
            <Skeleton h={46} n={2} />
          ) : (
            <div className="col" style={{ gap: 10 }}>
              {live.map((d) => (
                <div key={d.day} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <div className="tiny" style={{ width: 92, paddingTop: 12, color: 'var(--gold)' }}>
                    {d.label}
                  </div>
                  <div className="slots" style={{ flex: 1, gridTemplateColumns: 'repeat(auto-fill,minmax(78px,1fr))' }}>
                    {d.slots.map((s: any) => (
                      <Link key={s.ts} className={`slot ${s.tight ? 'tight' : ''}`} to={`/book?service=${svcKey}&slot=${s.ts}&day=${d.day}`} onClick={() => track('booking_start', '/book', { ts: s.ts })}>
                        {s.time}
                      </Link>
                    ))}
                    {!d.slots.length && (
                      <span className="mut sm" style={{ paddingTop: 12 }}>
                        {d.closed === 'complet' ? 'Complet — ' : d.closed ? d.closed + ' — ' : ''}
                        <Link className="link" to="/waitlist">
                          me prévenir si ça se libère
                        </Link>
                      </span>
                    )}
                  </div>
                </div>
              ))}
              <div className="spread" style={{ marginTop: 4 }}>
                <span className="mut xs">
                  Horaires réels, calculés côté serveur. {cfg?.live?.waitlistActive ? ` ${cfg.live.waitlistActive} demande(s) en attente.` : ''}
                </span>
                <div className="row" style={{ gap: 6 }}>
                  <button
                    className="link xs"
                    onClick={() => {
                      const next = !hideUi;
                      setHideUi(next);
                      sessionStorage.setItem('zyass_book_ui', next ? '1' : '0');
                    }}
                  >
                    {hideUi ? 'afficher le sélecteur complet' : 'réserver autrement'}
                  </button>
                  <Link className="btn sm" to={openingSoon ? '/book' : `/book?service=${svcKey}`}>
                    Choisir l'horaire exact
                  </Link>
                </div>
              </div>
              {hideUi && (
                <Link className="btn block" style={{ marginTop: 6 }} to={openingSoon ? '/book' : `/book?service=${svcKey}`}>
                  Ouvrir la réservation complète (jour, heure, barbier)
                </Link>
              )}
            </div>
          )}
        </Card>
      </Section>

      <Section kicker="Pourquoi réserver ici" title="Tu réserves en 20 secondes, on gère le reste">
        <div className="grid g3">
          {[
            { t: 'Zéro demande perdue', d: "Laisse tes préférences : la liste d’attente peut te proposer un créneau compatible lorsqu’il devient disponible.", k: '/waitlist' },
            { t: 'Zéro oubli', d: 'Confirmation immédiate, rappel J-1, décalage en 1 clic. Tu reçois aussi le .ics pour ton agenda.', k: '/faq' },
            { t: 'Zéro attente au fauteuil', d: "Un créneau = un barbier dédié. Les 5 minutes de nettoyage entre deux clients sont déjà comptées.", k: '/infos' },
          ].map((x) => (
            <Link key={x.t} to={x.k}>
              <Card>
                <h3>{x.t}</h3>
                <p className="mut mb0">{x.d}</p>
              </Card>
            </Link>
          ))}
        </div>
      </Section>

      <Section kicker="Le catalogue" title="Prestations et prix, sans surprise">
        <div className="grid g2">
          {services.slice(0, 8).map((s: any) => (
            <Link key={s.key} to={`/book?service=${s.key}`}>
              <button className="svc" type="button" style={{ width: '100%' }}>
                <span className="ico">{s.name.slice(0, 1)}</span>
                <span>
                  <b>{s.name}</b>
                  <span className="sub">
                    {s.durationMin} min {s.staffIds?.length > 1 ? `· ${s.staffIds.length} barbiers` : ''}
                  </span>
                </span>
                <span className="price">
                  {new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(s.priceCents / 100)}
                  {s.priceFrom !== s.priceCents && <span className="sub"> dès</span>}
                </span>
              </button>
            </Link>
          ))}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <Link className="btn ghost sm" to="/tarifs">
            Tous les tarifs + options
          </Link>
          <Link className="btn ghost sm" to="/faq">
            « Est-ce que je peux venir avec mon fils ? » …
          </Link>
        </div>
      </Section>

      {rating && (rating.list?.length || rating.count) ? (
        <Section kicker="Avis vérifiés" title={`Ce que disent les clients${rating.googleRating ? ` · ${rating.googleRating.value}/5 sur ${rating.googleRating.source}` : ''}`}>
          <div className="grid gauto">
            {firstReal.map((r: any) => (
              <Card key={r.id}>
                <Stars n={r.rating} />
                <p style={{ marginTop: 8 }}>« {r.comment} »</p>
                <p className="mut xs mb0">
                  {r.first_name ? r.first_name + ' ' : ''}
                  {new Date(r.created_ts).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })} · via {r.channel}
                </p>
              </Card>
            ))}
            {!firstReal.length && (
              <Card>
                <p className="mb0">
                  Seuls les avis collectés auprès de clients réels sont publiés. Tu peux nous laisser le tien après ta venue :{' '}
                  <a className="link" href={cfg?.links?.review ?? cfg?.links?.googleMaps} rel="nofollow">
                    laisser un avis
                  </a>
                  .
                </p>
              </Card>
            )}
          </div>
        </Section>
      ) : null}

      <Section kicker="L'équipe" title="Trois barbiers, un niveau">
        <div className="grid g3">
          {(cfg?.staff ?? []).map((st: any) => (
            <Card key={st.id}>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <span className="avatar" style={{ width: 46, height: 46, fontSize: 18 }}>
                  {st.name.slice(0, 1)}
                </span>
                <div>
                  <h3 className="mb0">{st.name}</h3>
                  <span className="mut xs">{st.title ?? 'Barbier'}</span>
                </div>
              </div>
              {st.bio && <p className="mut sm" style={{ marginTop: 10 }}>{st.bio}</p>}
              <Link className="btn ghost sm" to={`/book?staff=${st.slug}`} style={{ marginTop: 8 }}>
                Réserver avec {st.name.split(' ')[0]}
              </Link>
            </Card>
          ))}
        </div>
      </Section>

      <Section kicker="Où ?" title="20 boulevard Roy, Les Pavillons-sous-Bois">
        <div className="grid g2">
          <Card>
            <p className="mut sm mb0">
              {cfg?.salon?.address?.directions ?? 'À 6 min à pied du RER E, face au boulanger.'}
              <br />
              <span className="tiny gold" style={{ display: 'block', marginTop: 10 }}>
                {compactHours(cfg?.salon?.hours ?? REFERENCE_HOURS)}
              </span>
            </p>
            <div className="row" style={{ marginTop: 12 }}>
              <a className="btn ghost sm" href={cfg?.links?.googleMaps || SALON_MAPS_URL} rel="nofollow noopener noreferrer" target="_blank">
                Itinéraire
              </a>
              <a className="btn ghost sm" href={cfg?.links?.tel ?? 'tel:+33644048385'}>
                Appeler
              </a>
              <Link className="btn sm" to="/book">
                Réserver
              </Link>
            </div>
          </Card>
          <Card>
            <h4>Le salon en images</h4>
            <div className="gal" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
              {(cfg?.gallery ?? []).slice(0, 3).map((g: any) => (
                <figure key={g.id}>
                  <img src={g.path} alt={g.alt ?? 'Le salon'} loading="lazy" {...frameSize(g.aspect)} />
                </figure>
              ))}
            </div>
            <Link className="link xs" to="/galerie">
              voir la galerie complète
            </Link>
          </Card>
        </div>
      </Section>

      <div className="wrap" style={{ paddingBottom: 46 }}>
        <Card className="hl">
          <div className="spread">
            <div>
              <h3 className="mb0">Prêt ? Le créneau est à toi en 20 secondes.</h3>
              <span className="mut sm">Aucun compte à créer pour réserver. Ton espace client se remplit tout seul.</span>
            </div>
            <Link className="btn" to="/book">
              Réserver maintenant
            </Link>
          </div>
        </Card>
      </div>
    </>
  );
}

