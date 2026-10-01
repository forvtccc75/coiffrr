/**
 * `npm run seed`           → crée la base de démo si elle est vide
 * `npm run seed -- --fresh` → purge tout puis re-seme (démo propre avant une démo client)
 * `npm run seed -- --days 120` → plus d'historique (meilleures stats/prévisions)
 */
export {};
const args = process.argv.slice(2);
const fresh = args.includes('--fresh');
const di = args.indexOf('--days');
const historyDays = di >= 0 ? Number(args[di + 1]) || 90 : 90;

const { ready, closeDb, isSeeded, db } = await import('../db/index.ts');
const { seedDemo } = await import('./index.ts');
const { ALL_TABLES } = await import('../db/schema.ts');

await ready();
if (fresh) {
  for (const t of [...ALL_TABLES].reverse()) await db().exec(`DELETE FROM ${t}`);
  console.log(`  tables purgées (${ALL_TABLES.length})`);
}
const already = await isSeeded();
if (already && !fresh) {
  console.log('  base déjà peuplée — utilise `npm run seed -- --fresh` pour repartir de zéro.');
} else {
  const r = await seedDemo({ historyDays });
  const n = async (t: string) => await db().num(`SELECT COUNT(*) FROM ${t}`);
  console.log(
    `  clients ${r.customers} · RDV ${r.appointments} · prestations ${r.services} (${r.offerings} offres) · waitlist ${await n('waitlist')} · cartes cadeaux ${await n('gift_cards')} · avis ${await n('reviews')}`,
  );
}
await closeDb();
