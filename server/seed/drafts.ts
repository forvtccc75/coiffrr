import { transaction, type Q } from '../db/index.ts';
/** Modèles privés demandés par le propriétaire. Aucune offre active, aucun faux client/avis. */
export async function prepareDraftCatalogue(locationId: number) {
  return transaction(async (q: Q) => {
    let services = 0, staff = 0;
    if (!await q.num('SELECT count(*) FROM services WHERE location_id = :l', { l: locationId })) {
      for (const [key, name, category, duration] of [
        ['coupe-homme', 'Coupe homme', 'coupe', 30], ['barbe', 'Taille de barbe', 'barbe', 20],
        ['coupe-barbe', 'Coupe + barbe', 'forfait', 45], ['coupe-enfant', 'Coupe enfant', 'coupe', 25],
      ] as const) {
        await q.insert('services', { location_id: locationId, key, name, category, short_desc: 'Modèle privé : prix et durée à confirmer avant publication.', base_price_cents: 0, base_duration_min: duration, cleanup_min: 5, is_active: 0, updated_ts: Date.now() });
        services++;
      }
    }
    if (!await q.num('SELECT count(*) FROM staff WHERE location_id = :l', { l: locationId })) {
      for (let i = 1; i <= 3; i++) {
        await q.insert('staff', { location_id: locationId, name: `Barbier ${i} — à renommer`, slug: `barbier-${i}`, title: 'Profil à compléter', is_active: 0, created_ts: Date.now() });
        staff++;
      }
    }
    return { services, staff };
  }, locationId);
}
