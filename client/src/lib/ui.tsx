import {Children, cloneElement, createContext, useCallback, useContext, useEffect, useId, useRef, useState} from 'react';
import { ApiError } from './api';
import { createPortal } from 'react-dom';

/* ── toasts ─────────────────────────────────────────────────────────────── */
type Toast = { id: number; msg: string; kind: 'ok' | 'bad' | 'info' };
const ToastCtx = createContext<(msg: string, kind?: Toast['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function Toasts({ children }: { children: React.ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((msg: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, msg, kind }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), 5200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'bad' ? 'bad' : t.kind === 'ok' ? 'ok' : ''}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ── helpers ────────────────────────────────────────────────────────────── */
export const errText = (e: any) => (e instanceof ApiError ? e.message : String(e?.message ?? e ?? 'Erreur réseau'));
export const errCode = (e: any) => (e instanceof ApiError ? e.code : e?.code ?? '');

export function useAsync<T>(fn: () => Promise<T>, deps: any[] = []) {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: any }>({ data: null, loading: true, error: null });
  const cb = useRef(fn);
  cb.current = fn;
  const run = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    cb
      .current()
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((error) => setState({ data: null, loading: false, error }));
  }, deps);
  useEffect(run, [run]);
  return { ...state, reload: run, setData: (data: T) => setState((s) => ({ ...s, data })) };
}

/* ── atoms ──────────────────────────────────────────────────────────────── */
export const Card = ({ children, className = '', ...rest }: any) => (
  <div className={`card ${className}`} {...rest}>
    {children}
  </div>
);

/**
 * Taille intrinsèque déclarée d'un visuel. Le salon affiche les images dans un cadre fixé par
 * `media.aspect` (ex. « 4/5 ») : déclarer width/height dans le HTML réserve exactement ce cadre
 * avant le téléchargement, donc zéro saut de mise en page (CLS) même si la CSS tarde.
 */
export function frameSize(aspect?: string, base = 800) {
  const m = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(String(aspect ?? ''));
  const w = m ? Number(m[1]) : 4;
  const h = m ? Number(m[2]) : 5;
  return { width: base, height: Math.round((base * h) / w) };
}

export function Chip({ tone = '', children }: { tone?: string; children: React.ReactNode }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}

export const Stars = ({ n, size = 14 }: { n: number; size?: number }) => (
  <span className="stars" style={{ fontSize: size }} aria-label={`${n} sur 5`}>
    {'★★★★★'.slice(0, Math.round(n))}
    <span style={{ opacity: 0.28 }}>{'★★★★★'.slice(Math.round(n))}</span>
  </span>
);

export function Countdown({ to, onEnd }: { to: number; onEnd?: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(i);
  }, []);
  const left = Math.max(0, to - Date.now());
  useEffect(() => {
    if (left === 0) onEnd?.();
  }, [left]);
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  return (
    <span className="nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>
      {m}:{String(s).padStart(2, '0')}
    </span>
  );
}

export const Skeleton = ({ h = 40, n = 3 }: { h?: number; n?: number }) => (
  <div className="col" aria-hidden="true">
    {Array.from({ length: n }, (_, i) => (
      <div key={i} className="sk" style={{ minHeight: h }} />
    ))}
  </div>
);

/**
 * Champ de formulaire avec étiquette *associée*. Un `<label>` posé à côté d'un input ne compte pas
 * comme étiquette pour un lecteur d'écran : on génère donc un id et on le raccorde (htmlFor).
 * Les composants composites (Seg, sélecteurs de créneaux) reçoivent l'id via `aria-labelledby` et
 * gardent leur propre signalisation.
 */
export function Field({ label, hint, children, error, labelled }: any) {
  const id = useId();
  const kids = Children.toArray(children);
  let linked = false;
  const patched = kids.map((k: any) => {
    if (linked || !k || typeof k.type !== 'string' || k.props?.id) return k;
    if (!/^(input|select|textarea)$/i.test(k.type)) return k;
    linked = true;
    return cloneElement(k, { id });
  });
  const labelId = `${id}-lbl`;
  const head = label
    ? linked
      ? <label htmlFor={id}>{label}</label>
      : <span id={labelId}>{label}</span>
    : null;
  const body = linked || !labelled ? patched : patched.map((k: any) => (k && k.props ? cloneElement(k, { 'aria-labelledby': labelId }) : k));
  return (
    <div className="field">
      {head}
      {body}
      {hint && <span className="mut xs">{hint}</span>}
      {error && (
        <span className="err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function Check({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && (
          <span className="mut" style={{ display: 'block', fontSize: 12.5 }}>
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}

/** segmented control clavier + tactile (80% mobile) */
export function Seg<T extends string | number>({ value, options, onChange, label, tone = 'auto' }: { value: T | null; options: { value: T; label: string; hint?: string; disabled?: boolean }[]; onChange: (v: T) => void; label?: string; tone?: 'auto' | 'plain' }) {
  return (
    <div role="radiogroup" aria-label={label} className="row" style={{ gap: 8 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={o.disabled}
            className={on ? 'day on' : 'day'}
            style={{ minWidth: 0, flex: tone === 'auto' ? '1 1 auto' : undefined, opacity: o.disabled ? 0.45 : 1, cursor: o.disabled ? 'not-allowed' : 'pointer' }}
            onClick={() => !o.disabled && onChange(o.value)}
            title={o.hint}
          >
            <b style={{ fontSize: 13.5, fontWeight: on ? 650 : 500 }}>{o.label}</b>
            {o.hint && <span style={{ display: 'block', fontSize: 11, opacity: 0.7 }}>{o.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function Meter({ pct, label }: { pct: number; label?: string }) {
  return (
    <div>
      <div className="bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label ?? 'occupation'}>
        <i style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
      </div>
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer }: any) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const siblings = [...document.body.children].filter(el => !el.contains(ref.current)).map(el => ({ el: el as HTMLElement, inert: (el as HTMLElement).inert }));
    siblings.forEach(({el}) => { el.inert = true; });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); }
      if (e.key === 'Tab') {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]') ?? [])].filter(el => el.getClientRects().length);
        const first = items[0], last = items[items.length - 1];
        if (!first) { e.preventDefault(); ref.current?.focus(); }
        else if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey); ref.current?.focus({ preventScroll: true });
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; siblings.forEach(({el,inert}) => { el.inert = inert; }); if (previous?.isConnected) previous.focus({preventScroll:true}); };
  }, [open]);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    // La géométrie est dans la CSS (.scrim / .sheet) : feuille de saisie en bas sur mobile,
    // boîte centrée dès 720 px. Un style en ligne ici imposerait des !important pour la/media.
    <div className="scrim" onClick={onClose}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="spread mb">
          <h3 className="mb0">{title}</h3>
          <button className="btn ghost sm" onClick={onClose} aria-label="Fermer">
            Fermer
          </button>
        </div>
        {children}
        {footer && <div className="mt">{footer}</div>}
      </div>
    </div>, document.body
  );
}

export const Section = ({ title, kicker, children, right, reveal = true }: any) => (
  <section className={`wrap${reveal ? ' rv' : ''}`} style={{ padding: '34px 18px' }}>
    {(title || kicker) && (
      <div className="spread mb">
        <div>
          {kicker && <div className="tiny gold mb0" style={{ marginBottom: 6 }}>{kicker}</div>}
          {title && <h2 className="mb0">{title}</h2>}
        </div>
        {right}
      </div>
    )}
    {children}
  </section>
);

/**
 * Révélation au défilement, en un seul IntersectionObserver pour toute la page : pas de
 * `scroll` listener (coûteux sur mobile), pas de dépendance. La classe `js-rv` n'est ajoutée
 * qu'ici — sans JavaScript, `html.js-rv .rv` ne s'applique pas et tout reste visible.
 */
export function useReveal() {
  useEffect(() => {
    if (typeof document === 'undefined' || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const root = document.documentElement;
    root.classList.add('js-rv');
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          el.classList.add('rv-in');
          io.unobserve(el);
          // le contenu doit rester lisible même si l'animation est coupée court (print, capture)
          el.addEventListener('animationend', () => el.classList.remove('rv'), { once: true });
        }
      },
      { rootMargin: '0px 0px -6% 0px', threshold: 0.06 },
    );
    const scan = () => document.querySelectorAll<HTMLElement>('.rv:not(.rv-in)').forEach((el) => io.observe(el));
    scan();
    /* Garde-fou : si un élément a été monté d'une façon que l'observateur rate (portail, classe
       ajoutée tardivement, onglet en arrière-plan), on ne laisse jamais une section sous l'opacité 0.
       Une animation perdue est un détail ; un contenu invisible est une panne. */
    const failsafe = window.setTimeout(() => document.querySelectorAll<HTMLElement>('.rv:not(.rv-in)').forEach((el) => el.classList.add('rv-in')), 1500);
    // les écrans chargés après l'hydratation (lazy) doivent être observés aussi
    const mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.clearTimeout(failsafe);
      io.disconnect();
      mo.disconnect();
    };
  }, []);
}
