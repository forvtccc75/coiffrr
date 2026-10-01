import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AppIcon } from '../lib/app-chrome';
import { Modal } from '../lib/ui';
import { useConfig } from '../lib/api';
import { SALON_MAPS_URL } from '../../../shared/salon';

export function Salon() {
  const { cfg } = useConfig(); const [install, setInstall] = useState(false);
  const sections = [
    { to: '/tarifs', icon: 'scissors', title: 'Prestations & tarifs', sub: 'Choisir ce qui te ressemble' },
    { to: '/galerie', icon: 'photo', title: 'La galerie', sub: 'Découvrir le salon en images' },
    { to: '/infos', icon: 'pin', title: 'Horaires & accès', sub: 'Préparer ta prochaine visite' },
    { to: '/cartes-cadeaux', icon: 'gift', title: 'Cartes cadeaux', sub: 'Offrir un moment au salon' },
    { to: '/faq', icon: 'help', title: 'Questions fréquentes', sub: 'Tout savoir avant de venir' },
  ];
  return <div className="wrap pad salon-hub">
    <p className="tiny gold">LES PAVILLONS-SOUS-BOIS</p><h1>Ton salon.<br/><em>À portée de main.</em></h1>
    <p className="mut">20 boulevard Roy · 93320</p>
    <div className="salon-contact"><a href="tel:+33644048385"><AppIcon name="phone" size={19}/>Appeler</a><a href={cfg?.links?.googleMaps || SALON_MAPS_URL} target="_blank" rel="noopener noreferrer"><AppIcon name="pin" size={19}/>Itinéraire</a></div>
    <div className="app-menu">{sections.map(x => <Link to={x.to} key={x.to} className="app-menu-row"><span className="app-menu-icon"><AppIcon name={x.icon}/></span><span><b>{x.title}</b><small>{x.sub}</small></span><AppIcon name="arrow" size={17}/></Link>)}</div>
    <button className="install-card" onClick={() => setInstall(true)}><span className="app-menu-icon"><AppIcon name="plus"/></span><span><b>Z.YASS sur ton écran d’accueil</b><small>Un raccourci, et tu es au salon.</small></span><AppIcon name="arrow" size={17}/></button>
    {(cfg?.links?.whatsappHref || cfg?.links?.instagram || cfg?.links?.tiktok) && <div className="salon-secondary">{[[cfg.links.whatsappHref, 'WhatsApp'], [cfg.links.instagram, 'Instagram'], [cfg.links.tiktok, 'TikTok']].filter(([url]) => !!url).map(([url, label]) => <a href={url} key={label} target="_blank" rel="noopener noreferrer">{label} ↗</a>)}</div>}
    <div className="salon-secondary"><Link to="/accessibilite">Accessibilité</Link><Link to="/mentions-legales">Mentions légales</Link><Link to="/donnees-personnelles">Confidentialité</Link><Link to="/guides">Conseils & guides</Link><Link to="/sitemap-view">Plan du site</Link><Link to="/admin">Espace salon</Link></div>
    <Modal open={install} onClose={() => setInstall(false)} title="Z.YASS, comme une app">
      <p className="mut">Pas d’App Store, pas de compte à créer pour réserver.</p>
      <ol className="install-steps"><li><b>Ouvre ce site dans Safari sur iPhone.</b></li><li>Touche <b>Partager</b> <AppIcon name="share" size={18}/> puis <b>Sur l’écran d’accueil</b> (le menu peut varier selon ta version d’iOS).</li><li>Si l’option apparaît, active <b>Ouvrir comme app web</b>, puis touche <b>Ajouter</b>.</li></ol>
      <p className="note">Une connexion reste nécessaire pour les disponibilités et la confirmation d’un rendez-vous.</p>
      <p className="mut sm">Sur Android : menu du navigateur → Installer l’application ou Ajouter à l’écran d’accueil.</p>
      <button className="btn block" onClick={() => setInstall(false)}>Compris</button>
    </Modal>
  </div>;
}
