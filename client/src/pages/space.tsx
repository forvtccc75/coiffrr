import { useState } from 'react';
import { Link } from 'react-router-dom';
import { apptAction, availability, clientApi, me, sendCode, track, useConfig, verifyCode } from '../lib/api';
import { Card, Chip, Field, Skeleton, errText, useAsync, useToast } from '../lib/ui';

/** Espace client : code à 6 chiffres par SMS (pas de mot de passe à retenir). */
export function Space() {
  const { cfg, reload } = useConfig();
  const [who, setWho] = useState({ target: '', code: '', sent: false });
  const [session, setSession] = useState<{ ok: boolean; user: any } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  /* Un `me()` qui échoue (réseau, session expirée) = visiteur anonyme, pas un écran vide. */
  const meState = useAsync(() => me().catch(() => ({ user: null, anonymous: true } as { user: any; anonymous: boolean })), []);

  // le « shell » statique doit déjà porter le titre : sans ça, la page pré-rendue (vue des
  // moteurs, et du lecteur d’écran au premier rendu) narrerait une page sans <h1>.
  if (meState.loading)
    return (
      <div className="wrap pad">
        <h1 className="mb0">Mes rendez-vous</h1>
        <Skeleton n={2} />
      </div>
    );

  /* `user` d'abord, le drapeau ensuite : l'un des deux suffit à rendre le formulaire plutôt
     qu'un tableau de bord construit sur un utilisateur inexistant. */
  if (meState.data?.user && !meState.data.anonymous) {
    return <Dashboard cfg={cfg} user={meState.data.user} onLogout={async () => { await fetch('/api/public/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => undefined); meState.reload(); }} />;
  }

  return (
    <div className="wrap pad" style={{ maxWidth: 520 }}>
      <h1>Mes rendez-vous</h1>
      <p className="mut">Tes rendez-vous, tes points fidélité, tes cartes cadeaux. Aucun mot de passe : un code envoyé par SMS ou e-mail.</p>
      <div className="note mb"><b>Tu as déjà un rendez-vous ?</b><p className="sm mb0">Ouvre le lien de gestion reçu par e-mail ou SMS pour le retrouver sans te connecter. Sinon, connecte-toi ci-dessous.</p></div>
      <Card className="hl">
        {!who.sent ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setErr(null);
              try {
                const r: any = await sendCode(who.target.trim());
                setWho({ ...who, sent: true });
                track('space_login_sent', '/espace');
                if (r?.demoCode) setWho((w) => ({ ...w, code: r.demoCode }));
              } catch (e2) {
                setErr(e2);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Téléphone ou e-mail" hint={cfg?.demo ? 'Démo : le code est affiché à l’écran.' : 'On envoie un code de connexion, jamais de message commercial ici.'}>
              <input value={who.target} onChange={(e) => setWho({ ...who, target: e.target.value })} placeholder="06 12 34 56 78" autoCapitalize="none" autoComplete="username" />
            </Field>
            {err && <div className="note bad">{errText(err)}</div>}
            <button className="btn block lg" disabled={busy || who.target.length < 6}>
              {busy ? '…' : 'Recevoir mon code'}
            </button>
            <p className="mut xs center mt mb0">
              Premier passage ? <Link className="link" to="/book">Réserve un créneau</Link> — ton espace se crée tout seul.
            </p>
          </form>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setErr(null);
              try {
                await verifyCode(who.target.trim(), who.code.trim());
                await reload();
                meState.reload();
              } catch (e2) {
                setErr(e2);
              } finally {
                setBusy(false);
              }
            }}
          >
            <p className="sm mut mb">Code envoyé au <b>{who.target}</b>.</p>
            <Field label="Code à 6 chiffres">
              <input className="code" inputMode="numeric" maxLength={6} autoFocus value={who.code} onChange={(e) => setWho({ ...who, code: e.target.value.replace(/\D/g, '') })} placeholder="••••••" autoComplete="one-time-code" />
            </Field>
            {err && <div className="note bad">{errText(err)}</div>}
            <button className="btn block lg" disabled={busy || who.code.length < 4}>
              {busy ? '…' : 'Entrer'}
            </button>
            <button type="button" className="link sm mt" style={{ display: 'block', margin: '10px auto 0' }} onClick={() => setWho({ ...who, sent: false })}>
              changer de numéro
            </button>
          </form>
        )}
      </Card>
    </div>
  );
}

function Dashboard({ cfg, user, onLogout }: any) {
  const toast = useToast();
  const sum = useAsync(() => clientApi.summary(), []);
  const gifts = useAsync(() => clientApi.giftCards().catch(() => ({ items: [] })), []);
  const [exporting, setExporting] = useState(false);
  if (sum.loading) return <div className="wrap pad"><Skeleton n={4} /></div>;
  const s = sum.data ?? {};
  const upcoming = s.upcoming ?? [];
  const loy = s.loyalty ?? {};
  const ref = s.referral ?? {};

  return (
    <div className="wrap pad">
      <div className="spread mb">
        <div>
          <h1 className="mb0">Salut {user.name?.split(' ')[0] ?? 'toi'}</h1>
          <span className="mut sm">{s.customer?.segment ? `client ${s.customer.segment}` : 'ton salon, ton fauteuil'}</span>
        </div>
        <button className="btn ghost sm" onClick={onLogout}>
          Se déconnecter
        </button>
      </div>

      <div className="grid g2" style={{ alignItems: 'start' }}>
        <div className="col" style={{ gap: 12 }}>
          <Card className="hl">
            <h4>Tes rendez-vous</h4>
            {upcoming.length ? (
              upcoming.map((a: any) => <ApptRow key={a.id} a={a} cfg={cfg} onChange={sum.reload} toast={toast} />)
            ) : (
              <p className="mut sm">
                Rien de prévu. <Link className="link" to="/book">Prendre un créneau</Link>.
              </p>
            )}
            {s.rebookHint && (
              <div className="note mt mb0" style={{ fontSize: 13.5 }}>
                {s.rebookHint}
              </div>
            )}
          </Card>

          <Card>
            <div className="spread">
              <h4 style={{ margin: 0 }}>Fidélité</h4>
              <Chip tone={loy.nextReward ? 'gold' : ''}>{loy.points ?? 0} pts</Chip>
            </div>
            <p className="mut sm" style={{ marginTop: 8 }}>
              {loy.nextReward ? `Plus que ${Math.max(0, (loy.nextReward.atPoints ?? 100) - (loy.points ?? 0))} points pour ${loy.nextReward.label}.` : 'Un point par euro dépensé, un soin offert tous les 100 pts.'}
            </p>
            {(loy.rewards ?? []).filter((r: any) => r.redeemable).map((r: any) => (
              <div className="item" key={r.key}>
                <div>
                  <b style={{ fontWeight: 600 }}>{r.label}</b>
                  <span className="mut xs" style={{ display: 'block' }}>{r.atPoints} pts</span>
                </div>
                <button
                  className="btn sm"
                  onClick={async () => {
                    try {
                      await clientApi.redeem({ rewardKey: r.key });
                      toast('Récompense activée ✔ — elle est notée sur ton prochain RDV.');
                      sum.reload();
                    } catch (e) {
                      toast(errText(e), 'bad');
                    }
                  }}
                >
                  Utiliser
                </button>
              </div>
            ))}
          </Card>

          <Card>
            <h4>Parrainage</h4>
            <p className="sm mb0">
              Ton code : <code className="gold">{ref.code ?? '—'}</code> — un ami qui réserve avec lui te fait gagner {ref.rewardCents ? (ref.rewardCents / 100).toFixed(0) + ' €' : '10 €'} de soin.
            </p>
            <div className="row" style={{ marginTop: 10 }}>
              <button
                className="btn ghost sm"
                onClick={() => {
                  navigator.clipboard?.writeText(`${location.origin}/book?ref=${ref.code}`);
                  toast('Lien copié, à coller en story ou en DM.');
                }}
              >
                Copier mon lien
              </button>
              <span className="mut xs">{ref.converted ?? 0} ami(s) venus grâce à toi</span>
            </div>
          </Card>
        </div>

        <div className="col" style={{ gap: 12 }}>
          <Card>
            <h4>Historique</h4>
            {(s.history ?? []).slice(0, 6).map((a: any) => (
              <div className="item" key={a.id}>
                <span>
                  <b style={{ fontWeight: 600 }}>{a.service}</b>
                  <span className="mut xs" style={{ display: 'block' }}>{new Date(a.start).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })} · {a.staff}</span>
                </span>
                <span className="row" style={{ gap: 8 }}>
                  <span className="sm">{a.priceCents ? (a.priceCents / 100).toFixed(0) + ' €' : ''}</span>
                  {!a.reviewToken && a.status === 'completed' && <Link className="link xs" to="/book">rebooker</Link>}
                </span>
              </div>
            ))}
            {!(s.history ?? []).length && <p className="mut sm">Aucune visite enregistrée.</p>}
          </Card>

          <Card>
            <h4>Cartes cadeaux</h4>
            {(gifts.data?.items ?? []).map((g: any) => (
              <div className="item" key={g.code}>
                <span>
                  <b style={{ fontWeight: 600 }}>{(g.balanceCents / 100).toFixed(0)} €</b>
                  <span className="mut xs" style={{ display: 'block' }}>{g.code} · {g.status}</span>
                </span>
                <Link className="btn sm ghost" to={`/book?gift=${g.code}`}>
                  Utiliser
                </Link>
              </div>
            ))}
            {!(gifts.data?.items ?? []).length && <p className="mut sm mb0">Aucune carte. <Link className="link" to="/cartes-cadeaux">En offrir une</Link>.</p>}
          </Card>

          <Card>
            <h4>Tes données (RGPD)</h4>
            <p className="mut xs">Tu peux exporter tout ce que le salon détient sur toi, ou demander la suppression : le compte est anonymisé, le créneau supprimé, et les consentements journalisés.</p>
            <div className="row">
              <button
                className="btn ghost sm"
                disabled={exporting}
                onClick={async () => {
                  setExporting(true);
                  try {
                    const data = await clientApi.export();
                    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'zyass-mes-donnees.json';
                    a.click();
                    URL.revokeObjectURL(url);
                  } catch (e) {
                    toast(errText(e), 'bad');
                  } finally {
                    setExporting(false);
                  }
                }}
              >
                Exporter mes données
              </button>
              <button
                className="btn danger sm"
                onClick={async () => {
                  if (!confirm('Supprimer ton compte client ? Tes rendez-vous à venir seront annulés.')) return;
                  try {
                    await clientApi.del({ confirm: true });
                    toast('Compte supprimé. Bon vent — et merci pour ces années.');
                    onLogout();
                  } catch (e) {
                    toast(errText(e), 'bad');
                  }
                }}
              >
                Supprimer mon compte
              </button>
            </div>
          </Card>

          <Card>
            <h4>Préférences</h4>
            <form
              onSubmit={async (e: any) => {
                e.preventDefault();
                const f = new FormData(e.target);
                try {
                  await clientApi.profile({
                    firstName: f.get('firstName'),
                    lastName: f.get('lastName'),
                    email: f.get('email') || undefined,
                    birthDay: f.get('birthDay') || undefined,
                    preferredStaffId: Number(f.get('preferredStaffId')) || undefined,
                    note: f.get('note') || undefined,
                    consentMarketingEmail: f.get('marketingEmail') === 'on',
                    consentMarketingSms: f.get('marketingSms') === 'on',
                  });
                  toast('Enregistré ✔');
                  sum.reload();
                } catch (e2) {
                  toast(errText(e2), 'bad');
                }
              }}
              className="col"
              style={{ gap: 0 }}
            >
              <div className="grid g2">
                <Field label="Prénom">
                  <input name="firstName" defaultValue={s.customer?.firstName} maxLength={40} />
                </Field>
                <Field label="Nom">
                  <input name="lastName" defaultValue={s.customer?.lastName} maxLength={40} />
                </Field>
              </div>
              <Field label="E-mail">
                <input name="email" type="email" defaultValue={s.customer?.email ?? ''} />
              </Field>
              <div className="grid g2">
                <Field label="Anniversaire" hint="Un seul message, ce jour-là.">
                  <input name="birthDay" type="date" defaultValue={s.customer?.birthDay ?? ''} />
                </Field>
                <Field label="Barbier préféré">
                  <select name="preferredStaffId" defaultValue={s.customer?.preferredStaffId ?? ''}>
                    <option value="">Peu importe</option>
                    {(cfg?.staff ?? []).map((x: any) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Notes pour le barbier">
                <textarea name="note" defaultValue={s.customer?.notes ?? ''} maxLength={500} placeholder="Ex : ne pas trop raccourcir sur le dessus, peau sensible au rasoir." />
              </Field>
              <label className="check">
                <input type="checkbox" name="marketingSms" defaultChecked={!!s.customer?.consent?.sms} /> SMS créneaux libérés + offres
              </label>
              <label className="check">
                <input type="checkbox" name="marketingEmail" defaultChecked={!!s.customer?.consent?.email} /> E-mails (max 4 / 7 jours, désinscription 1 clic)
              </label>
              <button className="btn sm block">Enregistrer</button>
            </form>
          </Card>
        </div>
      </div>
    </div>
  );
}

function ApptRow({ a, cfg, onChange, toast }: any) {
  const [mode, setMode] = useState<'none' | 'move'>('none');
  const av = useAsync(() => (mode === 'move' ? availability({ service: a.serviceKey, days: 14 }) : Promise.resolve(null)), [mode]);
  return (
    <div className="tile" style={{ marginBottom: 8 }}>
      <div className="spread">
        <div>
          <b style={{ fontSize: 15.5 }}>{a.service}</b>
          <p className="mut xs mb0" style={{ marginTop: 2 }}>
            {new Date(a.start).toLocaleString('fr-FR', { weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' })} · {a.staff}
            {a.confirmRequired && !a.confirmed ? ' · à confirmer' : ''}
          </p>
        </div>
        {mode === 'none' && (
          <div className="row" style={{ gap: 6 }}>
            {!a.confirmRequired || a.confirmed ? null : (
              <button
                className="btn sm"
                onClick={async () => {
                  await apptAction('appointment/confirm', { token: a.token }).catch(() => fetch(`/api/public/actions/confirm?token=${a.token}`, { credentials: 'same-origin' }));
                  toast('Confirmé ✔');
                  onChange();
                }}
              >
                Confirmer
              </button>
            )}
            <button className="btn ghost sm" onClick={() => setMode('move')}>
              Décaler
            </button>
            <button
              className="btn danger sm"
              onClick={async () => {
                if (!confirm('Annuler ce rendez-vous ?')) return;
                try {
                  await apptAction('appointment/cancel', { token: a.token });
                  toast('Annulé — le créneau repart en waitlist.');
                  onChange();
                } catch (e) {
                  toast(errText(e), 'bad');
                }
              }}
            >
              Annuler
            </button>
          </div>
        )}
      </div>
      {mode === 'move' && (
        <div className="mt">
          {av.loading ? <Skeleton n={1} /> : (
            <div className="slots">
              {(av.data?.days ?? []).flatMap((d: any) => (d.slots ?? []).slice(0, 4).map((x: any) => ({ ...x, day: d.day }))).slice(0, 14).map((x: any) => (
                <button
                  key={x.ts}
                  className="slot"
                  onClick={async () => {
                    try {
                      await apptAction('appointment/reschedule', { token: a.token, start: x.ts });
                      toast('Déplacé ✔');
                      setMode('none');
                      onChange();
                    } catch (e) {
                      toast(errText(e), 'bad');
                    }
                  }}
                >
                  {x.time}
                  <span className="tag">{x.day.slice(5)}</span>
                </button>
              ))}
            </div>
          )}
          <button className="link xs mt" onClick={() => setMode('none')}>
            annuler le décalage
          </button>
        </div>
      )}
    </div>
  );
}
