/**
 * Migre la base (schéma + colonnes ajoutées). Idempotent : à lancer au boot du service
 * et dans la CI. `npm run migrate`.
 */
export {};
const { getDriver, closeDb } = await import('./index.ts');
const { migrate } = await import('./index.ts');
const drv = await getDriver();
const { added, failed } = await migrate(drv);
console.log(
  `  schéma OK (${drv.kind})` +
    (added.length ? ` · ${added.length} colonne(s) rattrapée(s) : ${added.slice(0, 6).join(', ')}${added.length > 6 ? '…' : ''}` : '') +
    (failed.length ? ` · ${failed.length} en échec : ${failed.map((f) => `${f.where} (${f.why})`).join(' | ')}` : ''),
);
if (failed.length) process.exitCode = 1;
await closeDb();
