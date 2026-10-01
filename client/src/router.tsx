import { compactHours, REFERENCE_HOURS, SALON_MAPS_URL } from '../../shared/salon';
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { RouteSeo } from './lib/seo';
import { ErrorBoundary } from './lib/boundary';
import { useReveal } from './lib/ui';
import { useConfig } from './lib/api';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { Home } from './pages/home';
import { BottomTabs, MobileHeader, useMobileViewport } from './lib/app-chrome';

const Book = lazy(() => import('./pages/book').then((m) => ({ default: m.Book })));
const Waitlist = lazy(() => import('./pages/waitlist').then((m) => ({ default: m.WaitlistPage })));
const Appt = lazy(() => import('./pages/waitlist').then((m) => ({ default: m.Appt })));
const Review = lazy(() => import('./pages/waitlist').then((m) => ({ default: m.Review })));
const Space = lazy(() => import('./pages/space').then((m) => ({ default: m.Space })));
const Pages = lazy(() => import('./pages/pages').then((m) => ({ default: m.Pages })));
const Admin = lazy(() => import('./admin/admin').then((m) => ({ default: m.Admin })));

/** Le boundary est réarmé à chaque changement de route : une page morte ne contamine pas la suivante. */
function Guarded({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary resetKey={pathname} label={pathname}>
      {children}
    </ErrorBoundary>
  );
}

function Reveal(){ useReveal(); return null; }

function ScrollTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    document.getElementById('main')?.focus({ preventScroll: true });
  }, [pathname]);
  return null;
}

const nav = [
  { to: '/', label: 'Accueil' },
  { to: '/tarifs', label: 'Tarifs' },
  { to: '/galerie', label: 'Galerie' },
  { to: '/salon', label: 'Le salon' },
  { to: '/cartes-cadeaux', label: 'Cartes cadeaux' },
  { to: '/espace', label: 'Mon espace' },
];

export function Header() {
  const { pathname } = useLocation();
  return (
    <header className="hd">
      <div className="wrap hd-in">
        <Link to="/" className="logo" aria-label="Z.YASS, accueil">
          <img src="/brand/logo.png" width="38" height="38" alt="" style={{ borderRadius: 7, verticalAlign: 'middle', marginRight: 8 }} />Z.YASS
        </Link>
        <nav aria-label="Navigation principale">
          {nav.map((n) => (
            <Link key={n.to} to={n.to} className={pathname === n.to ? 'on' : ''}>
              {n.label}
            </Link>
          ))}
        </nav>
        <Link className="btn sm" to="/book">
          Réserver
        </Link>
      </div>
    </header>
  );
}

export function Footer() {
  const { cfg } = useConfig();
  const links = cfg?.links;
  return (
    <footer className="ft">
      <div className="wrap">
        <div className="ft-grid">
          <div>
            <div className="logo">Z.YASS</div>
            <p>
              20 boulevard Roy
              <br />
              93320 Les Pavillons-sous-Bois
              <br />
              <a href="tel:+33644048385">06 44 04 83 85</a>
            </p>
            <p className="mut sm">{compactHours(cfg?.salon?.hours ?? REFERENCE_HOURS)}</p>
          </div>
          <div>
            <h4>Réserver</h4>
            <Link to="/book">Choisir un créneau</Link>
            <Link to="/waitlist">Waitlist (annulations récupérées)</Link>
            <Link to="/cartes-cadeaux">Cartes cadeaux</Link>
            <Link to="/espace">Mon espace client</Link>
          </div>
          <div>
            <h4>Le salon</h4>
            <Link to="/tarifs">Tarifs & prestations</Link>
            <Link to="/galerie">Galerie</Link>
            <Link to="/infos">Accès, parking, FAQ</Link>
            <Link to="/faq">Questions fréquentes</Link>
          </div>
          <div>
            <h4>Suivre &amp; écrire</h4>
            {links?.whatsappHref ? (
              <a href={links.whatsappHref} rel="nofollow noopener" target="_blank">
                WhatsApp
              </a>
            ) : null}
            {links?.instagram ? (
              <a href={links.instagram} rel="nofollow noopener" target="_blank">
                Instagram
              </a>
            ) : (
              <span className="mut xs">Instagram : à renseigner dans Réglages → Marque</span>
            )}
            {links?.tiktok ? (
              <a href={links.tiktok} rel="nofollow noopener" target="_blank">
                TikTok
              </a>
            ) : null}
            <a href={links?.googleMaps || SALON_MAPS_URL} rel="nofollow noopener noreferrer" target="_blank">
              Google Maps
            </a>
            <Link to="/sitemap-view">Plan du site</Link>
          </div>
        </div>
        <div className="ft-bot">
          <span>
            Z YASS BARBER SHOP — SARL · SIRET 918 535 071 00016 · RCS Bobigny · gérant Amiour Zineddine
          </span>
          <span>
            <Link to="/mentions-legales">Mentions légales</Link> · <Link to="/donnees-personnelles">Données personnelles</Link> ·{' '}
            <Link to="/admin">Espace salon</Link>
          </span>
        </div>
      </div>
    </footer>
  );
}

export default function Router() {
  const { pathname } = useLocation();
  const admin = /^\/admin(?:\/|$)/.test(pathname);
  useMobileViewport();
  return (
    <div className={admin ? 'app-shell admin-shell' : 'app-shell client-shell'}>
      <ScrollTop /><RouteSeo />
      <Reveal />
      <a className="skip" href="#main">
        Aller au contenu
      </a>
      <Header />
      {!admin && <MobileHeader />}
      <main id="main" tabIndex={-1}>
        <Guarded>
        <Suspense fallback={<div className="wrap pad page"><p className="mut">Chargement…</p></div>}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/book" element={<Book />} />
            <Route path="/waitlist" element={<Waitlist />} />
            <Route path="/waitlist/reserver" element={<Waitlist />} />
            <Route path="/waitlist/refuser" element={<Waitlist />} />
            <Route path="/rdv/:id" element={<Appt />} />
            <Route path="/avis/:id" element={<Review />} />
            <Route path="/espace" element={<Space />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/admin/*" element={<Admin />} />
            <Route path="*" element={<Pages />} />
          </Routes>
        </Suspense>
        </Guarded>
      </main>
      <Footer />
      {!admin && <><div className="mobile-legal"><Link to="/salon">Z.YASS · Le salon & les infos utiles</Link></div><BottomTabs /></>}
    </div>
  );
}
