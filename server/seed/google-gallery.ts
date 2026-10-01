import { j, sj, type Q } from '../db/index.ts';
/** Import ponctuel demandé et autorisé le 29/09/2026. Assets servis par notre domaine,
 * aucun hotlink Google, aucune image synthétique. Le marqueur respecte les suppressions admin. */
export async function importApprovedGoogleGallery(q: Q, locationId: number) {
  const loc = await q.one<any>('SELECT brand_json FROM locations WHERE id = :i', { i: locationId });
  if (!loc) return;
  const brand = j<any>(loc.brand_json, {});
  if (brand.googleGalleryImport === '2026-09-29-v1') return;
  const path = '/gallery/zyass-devanture-google.webp';
  if (!await q.one('SELECT id FROM media WHERE location_id = :l AND path = :p', { l: locationId, p: path })) {
    await q.insert('media', { location_id: locationId, path, alt: 'Devanture Z.yass Barber Shop, 20 boulevard Roy aux Pavillons-sous-Bois', kind: 'photo', label: 'Le salon — devanture, photo de la fiche Google', service_key: null, price_cents: null, duration_min: null, before_after: 0, aspect: '1600/1108', ts: Date.now(), like_count: 0 });
  }
  await q.update('locations', locationId, { brand_json: sj({ ...brand, googleGalleryImport: '2026-09-29-v1' }), updated_ts: Date.now() });
}
