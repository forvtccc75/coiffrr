/**
 * Garde-fou sécurité : aucun secret réel ne doit entrer dans le dépôt.
 * `npm run audit:secrets` — échoue si une clé ressemblant à un credential est détectée.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP = new Set(['node_modules', 'dist', 'data', '.git', '.next', 'coverage', 'playwright-report', 'test-results']);
const ALLOW = [/(^|\/)\.env\.example$/, /(^|\/)README\.md$/, /docs\//, /secrets\.example/, /\.md$/];
const RULES = [
  ['clé Stripe live', /sk_live_[0-9a-zA-Z]{8,}/],
  ['clé Stripe restreinte', /rk_live_[0-9a-zA-Z]{8,}/],
  ['secret Stripe webhook', /whsec_[0-9a-zA-Z]{8,}/],
  ['clé Brevo', /xkeysib-[A-Za-z0-9-]{30,}/],
  ['clé Resend', /re_[A-Za-z0-9_]{20,}/],
  ['Twilio auth token', /auth_token['"]?\s*[:=]\s*['"][0-9a-f]{24,}['"]/i],
  ['URL Postgres avec mot de passe', /postgres(ql)?:\/\/[^/\s'"]+:[^@/\s'"]{4,}@/],
  ['clé API Google', /AIza[0-9A-Za-z_-]{30,}/],
  ['private key PEM', /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/],
];
const DEV_OK = /(dev|change-me|example|test|placeholder|xxxxxxxx|000000)/i;

const files = [];
walk(process.cwd());
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === '.' || SKIP.has(name)) continue;
    const p = join(dir, name);
    if (name === '.env' || name.endsWith('.env.local')) {
      files.push(p);
      continue;
    }
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (st.size < 1_500_000 && /\.(ts|tsx|js|mjs|cjs|mts|json|css|html|sql|yml|yaml|md|env|sh)$/.test(name)) files.push(p);
  }
}

let bad = 0;
const checked = files.filter((f) => !ALLOW.some((r) => r.test(relative(process.cwd(), f))));
for (const f of checked) {
  let text = '';
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (DEV_OK.test(line)) return;
    for (const [label, re] of RULES) {
      if (re.test(line)) {
        bad++;
        console.log(`\x1b[31m✗\x1b[0m ${relative(process.cwd(), f)}:${i + 1} — ${label}: ${line.trim().slice(0, 90)}`);
        return;
      }
    }
  });
}
if (bad) {
  console.error(`\n${bad} secret(s) probable(s) — supprime-les, bascule-les dans les variables d'environnement, puis révoque-les chez le fournisseur.`);
  process.exit(1);
}
console.log(`\x1b[32m✓\x1b[0m audit secrets : ${checked.length} fichiers, aucun credential réel`);
