import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';

export function AppIcon({ name, size = 24 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-8H9v8H4a1 1 0 0 1-1-1Z" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="4"/><path d="M7 3v4m10-4v4M3 11h18m-14 5h3m4 0h3"/></>,
    appointments: <><rect x="5" y="4" width="14" height="18" rx="3"/><path d="M9 2h6v4H9zM9 12h6m-6 4h4"/></>,
    salon: <><path d="M3 10h18l-2-6H5l-2 6Zm1 0v11h16V10M9 21v-7h6v7M3 10c0 4 4 4 4 0 0 4 5 4 5 0 0 4 5 4 5 0 0 4 4 4 4 0"/></>,
    arrow: <path d="m9 5 7 7-7 7"/>,
    back: <path d="m14 5-7 7 7 7"/>,
    phone: <path d="M5 3h4l2 5-3 2c2 3 3 4 6 6l2-3 5 2v4c0 2-2 3-4 2C9 19 5 15 3 7 2 5 3 3 5 3Z"/>,
    photo: <><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-7 5 8"/></>,
    scissors: <><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m9 8 12 13M9 16 21 3"/></>,
    pin: <><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></>,
    gift: <><path d="M3 9h18v4H3zm2 4v8h14v-8M12 9v12"/><path d="M12 9C4 9 4 2 8 3c3 0 4 6 4 6s1-6 4-6c4-1 4 6-4 6Z"/></>,
    help: <><circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 4 3c-1 0-1 1-1 2m0 3h.01"/></>,
    share: <><path d="M12 15V2m-4 4 4-4 4 4M7 10H4v11h16V10h-3"/></>,
    plus: <path d="M12 4v16M4 12h16"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name] ?? paths.salon}</svg>;
}
export const appTabs = [
  { to: '/', label: 'Accueil', icon: 'home' },
  { to: '/book', label: 'Réserver', icon: 'calendar' },
  { to: '/espace', label: 'Mes RDV', icon: 'appointments' },
  { to: '/salon', label: 'Le salon', icon: 'salon' },
];
export function tabFor(path: string) {
  if (path === '/') return '/';
  if (path === '/book' || path.startsWith('/waitlist')) return '/book';
  if (/^\/(espace|rdv|avis)(\/|$)/.test(path)) return '/espace';
  return '/salon';
}
const detailTitles: Record<string, string> = { '/tarifs': 'Les prestations', '/galerie': 'La galerie', '/infos': 'Venir au salon', '/faq': 'Questions fréquentes', '/cartes-cadeaux': 'Cartes cadeaux', '/waitlist': 'Liste d’attente', '/mentions-legales': 'Mentions légales', '/donnees-personnelles': 'Confidentialité' };
export function MobileHeader() {
  const { pathname } = useLocation();
  const tab = tabFor(pathname);
  const root = appTabs.some(t => t.to === pathname);
  return <header className="app-header">
    {root ? <Link to="/" className="app-mark" aria-label="Z.YASS, accueil"><img src="/brand/logo.png" alt="" width="34" height="34"/></Link> : <Link to={tab === '/salon' ? '/salon' : tab} className="app-icon-button" aria-label="Retour"><AppIcon name="back"/></Link>}
    <div className="app-header-title">{pathname === '/' ? <><span>Z.YASS</span><small>BARBER SHOP</small></> : detailTitles[pathname] ?? appTabs.find(t => t.to === tab)?.label}</div>
    <a className="app-icon-button" href="tel:+33644048385" aria-label="Appeler le salon"><AppIcon name="phone" size={20}/></a>
  </header>;
}
export function BottomTabs() {
  const { pathname } = useLocation(); const selected = tabFor(pathname);
  return <nav className="app-tabs" aria-label="Navigation de l’application">
    {appTabs.map(t => <Link key={t.to} to={t.to} onClick={e => { if (pathname === t.to) { e.preventDefault(); window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); } }} className={selected === t.to ? 'app-tab selected' : 'app-tab'} aria-current={selected === t.to ? 'page' : undefined}>
      <span className="app-tab-icon"><AppIcon name={t.icon}/></span><span>{t.label}</span>
    </Link>)}
  </nav>;
}
/** visualViewport réduit par le clavier iOS : les onglets s'effacent, le formulaire reste défilable. */
export function useMobileViewport() {
  useEffect(() => {
    const root = document.documentElement; const vv = window.visualViewport;
    const update = () => {
      const editing = document.activeElement?.matches('input:not([type=checkbox]):not([type=radio]), textarea, select');
      const compact = window.matchMedia('(max-width: 767px), (orientation: landscape) and (max-height: 500px) and (max-width: 980px) and (pointer: coarse)').matches;
      const keyboard = !!(compact && editing && vv && window.innerHeight - vv.height > 120);
      root.classList.toggle('app-keyboard', keyboard);
      root.style.setProperty('--visible-height', `${vv?.height ?? window.innerHeight}px`);
    };
    vv?.addEventListener('resize', update); window.addEventListener('resize', update);
    document.addEventListener('focusin', update); document.addEventListener('focusout', update); update();
    return () => { vv?.removeEventListener('resize', update); window.removeEventListener('resize', update); document.removeEventListener('focusin', update); document.removeEventListener('focusout', update); root.classList.remove('app-keyboard'); root.style.removeProperty('--visible-height'); };
  }, []);
}
