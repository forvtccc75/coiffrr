/** Bundle Node explicite : aucun import interne .ts ne doit survivre au déploiement Vercel. */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('dist/server', { recursive: true });
const result = await build({
  entryPoints: ['server/app.ts'],
  outfile: 'dist/server/app.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  packages: 'external',
  sourcemap: false,
  metafile: true,
  logLevel: 'info',
});
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (/\.(?:ts|tsx|mts|cts)$/.test(dependency.path) || dependency.path.startsWith('.')) {
      throw new Error(`Import interne non compilé : ${dependency.path}`);
    }
  }
}
writeFileSync('dist/server/meta.json', JSON.stringify(result.metafile, null, 2));
console.log('✓ serveur compilé : dist/server/app.cjs ; aucun import TypeScript au runtime');

// Ce petit bundle ne doit JAMAIS importer env/db : les assets restent lisibles si Postgres tombe.
const statics = await build({ entryPoints: ['server/static.ts'], outfile: 'dist/server/static.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node20', packages: 'external', metafile: true, logLevel: 'info' });
if (Object.keys(statics.metafile.inputs).some(x => /server\/(?:db|domain)\/|server\/lib\/env/.test(x))) throw new Error('Le serveur statique dépend du backend');
console.log('✓ fichiers publics : bundle autonome sans base de données');
