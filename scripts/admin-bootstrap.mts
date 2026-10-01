/**
 * Crée (ou promeut) le compte admin du salon, sans passer par l'interface.
 *
 *   npm run admin:new -- --email patron@salon.fr --password "un mot de passe long" [--name "Zineddine"]
 *   npm run admin:new -- --email patron@salon.fr --password "…" --change   # change un mot de passe existant
 *
 * La base visée est celle de l'environnement (DATABASE_URL, sinon le SQLite local de DATA_FILE).
 * Le mot de passe n'est jamais affiché ni journalisé.
 */
import { ensureOwner, MIN_OWNER_PASSWORD } from '../server/lib/access.ts';

const argv = process.argv.slice(2);
const flag = (k: string): string | undefined => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (k: string) => argv.includes(`--${k}`);

const email = flag('email') ?? process.env.ADMIN_EMAIL ?? '';
const password = flag('password') ?? process.env.ADMIN_PASSWORD ?? '';

if (!email || !password) {
  console.error('Usage : npm run admin:new -- --email <adresse> --password <mot de passe de %d+ caractères> [--name <prénom>] [--change]', MIN_OWNER_PASSWORD);
  process.exit(2);
}


const out = await ensureOwner({ email, password, name: flag('name'), allowPasswordChange: has('change') });
console.log(JSON.stringify(out));
await (await import('../server/db/index.ts')).closeDb();
process.exit(out.status === 'refused' ? 1 : 0);
