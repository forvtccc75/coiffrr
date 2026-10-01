/**
 * Démo locale : API + Vite ensemble, sans dépendance externe.
 * `npm run dev`  →  API sur 127.0.0.1:8787 (base SQLite./data), Vite sur 5173 qui proxifie /api.
 * L'horloge des automatisations tourne dans le process API (désactivée en production : Vercel Cron).
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve as rresolve } from 'node:path';

/* Deux pièges rencontrés ici, laissés par écrit parce qu'ils cassent `npm run dev` sur n'importe
   quelle machine propre :
   - `node --import tsx/watch` : tsx 4.x n'exporte plus le sous-module ./watch → ERR_PACKAGE_PATH_NOT_EXPORTED ;
   - `node --tsconfig …` : ce flag appartient au CLI tsx, pas à node → « bad option: --tsconfig ».
   On lance donc le CLI tsx (résolu dans node_modules, sans dépendre du PATH ni de npx) en mode watch. */
const require_ = createRequire(import.meta.url);
const pkgFile = (pkg, sub) => {
  try {
    const cand = rresolve(dirname(require_.resolve(pkg + '/package.json')), sub);
    return existsSync(cand) ? cand : null;
  } catch {
    return null;
  }
};
const TSX = (() => {
  try {
    return require_.resolve('tsx/cli');
  } catch {
    return pkgFile('tsx', 'dist/cli.mjs');
  }
})();
const VITE = pkgFile('vite', 'bin/vite.js');

const port = Number(process.env.PORT || 8787);
const webPort = Number(process.env.WEB_PORT || 5173);
const children = [];

function run(name, cmd, args, color, extraEnv = {}) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '1', ...extraEnv } });
  const tag = `\x1b[${color}m[${name}]\x1b[0m`;
  const pipe = (stream) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) process.stdout.write(`${tag} ${l}\n`);
    });
  };
  pipe(p.stdout);
  pipe(p.stderr);
  p.on('exit', (code) => {
    if (!closing) {
      console.error(`${tag} arrêté (code ${code}) — on arrête tout.`);
      shutdown(code ?? 1);
    }
  });
  children.push(p);
  return p;
}

let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const p of children) {
    try {
      p.kill('SIGTERM');
    } catch {
      /* déjà mort */
    }
  }
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`\n  Z.YASS — dev\n  API    http://127.0.0.1:${port}\n  Site   http://localhost:${webPort}\n  Back-office  http://localhost:${webPort}/admin  (owner@zyass.fr / demo-owner)\n`);

run('api', TSX ? process.execPath : 'npx', TSX ? [TSX, 'watch', 'server/index.ts'] : ['--no-install', 'tsx', 'watch', 'server/index.ts'], 35);
run('web', VITE ? process.execPath : 'npx', VITE ? [VITE, '--port', String(webPort), '--strictPort', '--host', '0.0.0.0'] : ['--no-install', 'vite', '--port', String(webPort), '--strictPort', '--host', '0.0.0.0'], 36);
