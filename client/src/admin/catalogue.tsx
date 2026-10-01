import { useState } from 'react';
import { adminApi as A, loadCfg } from '../lib/api';
import { Card, Field, errText, useToast } from '../lib/ui';

export function ServiceEditor({ row = {}, offering, onSaved }: any) {
  const toast = useToast();
  const [f, set] = useState({ name: row.name ?? '', price: String((row.base_price_cents ?? 0) / 100), duration: row.base_duration_min ?? 30, description: row.short_desc ?? '', active: !!row.is_active });
  const [busy, setBusy] = useState(false);
  return <Card><form onSubmit={async e => { e.preventDefault(); setBusy(true); try {
    if (f.active && Number(f.price) <= 0) throw new Error('Confirme un vrai prix avant de publier cette prestation.');
    await A.post('services', { id: row.id, key: row.key, name: f.name, category: row.category ?? 'coupe', shortDesc: f.description, description: row.description ?? undefined, priceCents: Math.round(Number(f.price) * 100), durationMin: Number(f.duration), prepMin: row.prep_min ?? 0, cleanupMin: row.cleanup_min ?? 5, active: f.active, popular: !!offering?.is_popular, bundleAddons: offering?.addon_ids ?? [] });
    toast(f.active ? 'Prestation publiée.' : 'Brouillon enregistré, invisible aux clients.'); await loadCfg(true); onSaved();
  } catch (err) { toast(errText(err), 'bad'); } finally { setBusy(false); } }}>
    <p className="kick">{row.is_active ? 'Publiée' : 'Brouillon privé'}</p>
    <Field label="Nom de la prestation"><input required minLength={2} maxLength={60} value={f.name} onChange={e => set({ ...f, name: e.target.value })} /></Field>
    <div className="grid g2"><Field label="Prix (€)"><input required type="number" min="0" max="2000" step="0.01" value={f.price} onChange={e => set({ ...f, price: e.target.value })} /></Field><Field label="Durée réelle (minutes)"><input required type="number" min="5" max="360" value={f.duration} onChange={e => set({ ...f, duration: Number(e.target.value) })} /></Field></div>
    <Field label="Description courte"><textarea maxLength={160} value={f.description} onChange={e => set({ ...f, description: e.target.value })} /></Field>
    <label className="row mb"><input type="checkbox" checked={f.active} onChange={e => set({ ...f, active: e.target.checked })} />Publier cette prestation — prix et durée validés</label>
    <button className="btn" disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer la prestation'}</button>
  </form></Card>;
}
export function StaffEditor({ row = {}, services = [], onSaved }: any) {
  const toast = useToast();
  const [f, set] = useState({ name: row.name ?? '', title: row.title ?? '', bio: row.bio ?? '', active: !!row.is_active, serviceIds: (row.service_ids ?? []) as number[] });
  const [busy, setBusy] = useState(false);
  return <Card><form onSubmit={async e => { e.preventDefault(); setBusy(true); try {
    if (f.active && /à renommer/i.test(f.name)) throw new Error('Renseigne le vrai nom du barbier avant de l’activer.');
    await A.post('staff', { id: row.id, ...f, color: row.color_hex, acceptNewClients: row.accept_new_clients !== 0 });
    toast(f.active ? 'Barbier activé.' : 'Profil privé enregistré.'); await loadCfg(true); onSaved();
  } catch (err) { toast(errText(err), 'bad'); } finally { setBusy(false); } }}>
    <p className="kick">{row.is_active ? 'Actif' : 'Profil inactif · non réservable'}</p>
    <Field label="Nom public du barbier"><input required minLength={2} maxLength={50} value={f.name} onChange={e => set({ ...f, name: e.target.value })} /></Field>
    <Field label="Titre"><input maxLength={50} value={f.title} onChange={e => set({ ...f, title: e.target.value })} /></Field>
    <Field label="Présentation"><textarea maxLength={600} value={f.bio} onChange={e => set({ ...f, bio: e.target.value })} /></Field>
    <p className="mut xs">Prestations : aucune cochée = toutes les prestations publiées. Les horaires se règlent dans l’onglet Horaires.</p>
    {services.map((s: any) => <label className="row mb" key={s.id}><input type="checkbox" checked={f.serviceIds.includes(s.id)} onChange={e => set({ ...f, serviceIds: e.target.checked ? [...f.serviceIds, s.id] : f.serviceIds.filter(i => i !== s.id) })} />{s.name}</label>)}
    <label className="row mb"><input type="checkbox" checked={f.active} onChange={e => set({ ...f, active: e.target.checked })} />Activer ce vrai barbier pour les réservations</label>
    <button className="btn" disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer le barbier'}</button>
  </form></Card>;
}
export function PasswordEditor() {
  const toast = useToast(); const [f, set] = useState({ currentPassword: '', password: '', confirm: '' }); const [busy, setBusy] = useState(false);
  return <Card><h3>Sécuriser mon accès propriétaire</h3><p className="mut">Change le mot de passe initial. Tes autres sessions seront déconnectées.</p><form onSubmit={async e => { e.preventDefault(); if (f.password !== f.confirm) return toast('Les nouveaux mots de passe ne correspondent pas.', 'bad'); setBusy(true); try { await A.post('account/password', { currentPassword: f.currentPassword, password: f.password }); set({ currentPassword: '', password: '', confirm: '' }); toast('Mot de passe modifié.'); } catch (err) { toast(errText(err), 'bad'); } finally { setBusy(false); } }}>
    <Field label="Mot de passe actuel"><input required type="password" autoComplete="current-password" value={f.currentPassword} onChange={e => set({ ...f, currentPassword: e.target.value })} /></Field>
    <Field label="Nouveau mot de passe — 12 caractères minimum"><input required type="password" minLength={12} maxLength={200} autoComplete="new-password" value={f.password} onChange={e => set({ ...f, password: e.target.value })} /></Field>
    <Field label="Confirmer le nouveau mot de passe"><input required type="password" minLength={12} maxLength={200} autoComplete="new-password" value={f.confirm} onChange={e => set({ ...f, confirm: e.target.value })} /></Field>
    <button className="btn" disabled={busy}>Changer mon mot de passe</button>
  </form></Card>;
}
