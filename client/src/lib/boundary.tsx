import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isAssetLoadError, recoverAssetOnce, reloadDocument } from './asset-recovery';

/**
 * Filet de sécurité de rendu. Sans lui, la moindre exception dans un écran démonte l'arbre
 * entier et le visiteur reste devant un fond noir vide : c'est exactement ce qui est arrivé à
 * `/espace` le 28/09/2026 (session absente → `user.name` sur null → page blanche, zéro texte,
 * zéro issue). Un écran cassé doit rester une page : on explique, et on propose la sortie utile.
 *
 * `resetKey` (typiquement le pathname) remonte l'enfant tout seul quand on navigue ailleurs :
 * inutile de faire payer une page morte au reste du site.
 */
type Props = { children: ReactNode; resetKey?: unknown; label?: string };
type State = { err: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    // Journalisé côté client, et visible en dev : un blanc silencieux est impossible à diagnostiquer
    // après coup pour l'exploitant. On n'envoie rien dehors (RGPD) — pas de service de trace tiers.
    if (isAssetLoadError(err)) recoverAssetOnce();
    console.error('[zyass] écran interrompu :', err?.message ?? err, info?.componentStack?.slice(0, 400));
  }

  componentDidUpdate(prev: Props) {
    if (this.state.err && prev.resetKey !== this.props.resetKey) this.setState({ err: null });
  }

  render() {
    if (!this.state.err) return this.props.children as any;
    const msg = String(this.state.err.message || this.state.err).slice(0, 180);
    return (
      <div className="wrap pad page" role="alert" aria-live="assertive">
        <div className="card hl" style={{ maxWidth: 620 }}>
          <p className="kick">Cet écran n’a pas pu s’afficher</p>
          <h1>Ce n’est pas toi, c’est nous.</h1>
          <p className="mut">
            Les rendez-vous déjà confirmés restent enregistrés. Recharge cet écran pour reprendre,
            ou appelle le salon si le problème persiste.
          </p>
          <div className="row" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
            <button className="btn" onClick={() => isAssetLoadError(this.state.err) ? reloadDocument() : this.setState({ err: null })}>
              Réessayer
            </button>
            <a className="btn ghost" href="/book">
              Réserver un créneau
            </a>
            <a className="btn ghost" href="/infos">
              Adresse &amp; téléphone
            </a>
            <a className="btn ghost" href="tel:+33644048385">Appeler le salon</a>
          </div>
          <details className="mt">
            <summary className="mut xs">Détail technique (pour le salon)</summary>
            <p className="mono xs mt" style={{ opacity: 0.75, wordBreak: 'break-word' }}>
              {this.props.label ? `${this.props.label} — ` : ''}
              {msg}
            </p>
          </details>
        </div>
      </div>
    );
  }
}
