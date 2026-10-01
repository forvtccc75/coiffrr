/** Fiche Google vérifiée le 29/09/2026 : adresse et CID, aucun horaire publié.
 * Horaires de référence : Planity, à confirmer par le propriétaire. Jamais annoncés « importés de Google ».
 */
export const SALON_MAPS_URL = 'https://www.google.com/maps?cid=14672622159112713981&hl=fr';
export const SALON_DIRECTIONS_URL = 'https://www.google.com/maps/dir/?api=1&destination=20%20boulevard%20Roy%2093320%20Les%20Pavillons-sous-Bois';
export const REFERENCE_HOURS: Record<string, [string, string][]> = {
  '0': [], '1': [['09:30', '20:00']], '2': [['09:30', '20:00']], '3': [['09:30', '20:00']],
  '4': [['09:30', '20:00']], '5': [['09:30', '20:00']], '6': [['09:30', '20:00']],
};
export function publicMapsUrl(brand: any = {}) {
  for (const raw of [brand.googleMapsUrl, brand.mapsUrl]) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    try { const url = new URL(raw.trim()); if (url.protocol === 'https:') return url.href; } catch { /* fallback réel */ }
  }
  return SALON_MAPS_URL;
}
export function hoursForDay(hours: any, dow: number): string {
  const spans = hours?.[String(dow)] ?? [];
  return spans.length ? spans.map(([a, b]: string[]) => `${a}–${b}`).join(' · ') : 'Fermé';
}
export function compactHours(hours: any): string {
  const names = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
  const groups: { days: number[]; label: string }[] = [];
  for (const dow of [1, 2, 3, 4, 5, 6, 0]) {
    const label = hoursForDay(hours, dow); const last = groups.at(-1);
    if (last?.label === label) last.days.push(dow); else groups.push({ days: [dow], label });
  }
  return groups.map(g => `${names[g.days[0]]}${g.days.length > 1 ? '–' + names[g.days.at(-1)!] : ''} : ${g.label}`).join(' · ');
}
