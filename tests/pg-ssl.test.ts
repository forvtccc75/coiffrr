import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pgConnectionOptions } from '../server/db/pg-options.ts';

/** `ssl` vaut `false` (pas de TLS), `undefined` (laisser faire le serveur) ou un objet : on réduit
    les trois états à une seule valeur comparable, pour que l'assertion dise le comportement. */
const tls = (o: { ssl?: false | { rejectUnauthorized?: boolean } }) => (o.ssl === false ? 'off' : o.ssl ? (o.ssl.rejectUnauthorized ? 'vérifié' : 'chiffré sans validation') : 'non précisé');

/**
 * Ces assertions verrouillent une erreur mesurée sur le vrai pooler Supabase le 28/09/2026 :
 * avec `?sslmode=require` dans l'URL, `pg` applique le mode TLS APRÈS l'option `ssl`, donc le
 * `{ rejectUnauthorized: false }` du driver est ignoré et la connexion échoue sur
 * « self-signed certificate in certificate chain ». Un exploitant qui colle l'URL telle que
 * Supabase la propose (avec `?sslmode=require`, comme recommandé partout) ne pouvait pas démarrer.
 * La correction est structurelle : `sslmode` sort de l'URL et n'existe que dans `ssl`.
 */

test('sslmode=require quitte l’URL et devient l’option ssl (sinon pg gagne)', () => {
  const url = 'postgresql://postgres.abc:def@aws-0-eu-west-2.pooler.supabase.com:5432/postgres?sslmode=require';
  const o = pgConnectionOptions(url);
  assert.equal(tls(o), 'chiffré sans validation', 'TLS sans validation de chaîne pour un pooler');
  assert.ok(!/sslmode/.test(o.connectionString), 'aucun sslmode ne doit rester dans la chaîne passée à pg');
  assert.ok(!/[?&]$/.test(o.connectionString), 'la chaîne ne doit pas finir par ? ou &');
  assert.ok(o.connectionString.includes(':5432/postgres'), 'le reste de l’URL est intact');
  new URL(o.connectionString); // une chaîne recopiée dans l'UI Supabase doit rester parsable
});

test('sslmode placé entre deux paramètres ne laisse pas de chevron orphelin', () => {
  const o = pgConnectionOptions('postgres://u:p@host.db:5432/db?pool=2&sslmode=require&application_name=zyass');
  assert.equal(o.connectionString, 'postgres://u:p@host.db:5432/db?pool=2&application_name=zyass');
  assert.equal(tls(o), 'chiffré sans validation');
});

test('les trois autres modes sont respectés au lieu d’être écrasés', () => {
  assert.equal(pgConnectionOptions('postgres://u:p@127.0.0.1:5432/db?sslmode=disable').ssl, false, 'disable = pas de TLS');
  assert.equal(pgConnectionOptions('postgres://u:p@db.example.com:5432/db?sslmode=disable').ssl, false, 'disable gagne même à distance');
  assert.equal(tls(pgConnectionOptions('postgres://u:p@db.example.com:5432/db?sslmode=verify-full')), 'vérifié', 'verify-full vérifie la chaîne');
  assert.equal(tls(pgConnectionOptions('postgres://u:p@db.example.com:5432/db?sslmode=no-verify')), 'chiffré sans validation');
  assert.equal(/sslmode/.test(pgConnectionOptions('postgres://u:p@db.example.com:5432/db?sslmode=verify-full').connectionString), false);
});

test('un hôte local sans sslmode reste en clair, un hôte distant ne lest jamais', () => {
  assert.equal(tls(pgConnectionOptions('postgres://zyass@127.0.0.1:5432/zyass')), 'non précisé', 'local : rien à chiffrer');
  assert.equal(tls(pgConnectionOptions('postgres://zyass@localhost:5432/zyass')), 'non précisé', 'localhost aussi est local');
  assert.equal(tls(pgConnectionOptions('postgres://u:p@ep-cool-123.eu-central-1.aws.neon.tech/db')), 'chiffré sans validation', 'Neon : TLS implicite');
  assert.equal(tls(pgConnectionOptions('postgres://u:p@db.fournisseur-tiers.fr:5432/db')), 'chiffré sans validation', 'distant sans indice : TLS, sinon ça partait en clair');
});

test('la chaîne au format mots-clés est laissée intacte (libpq la comprend déjà)', () => {
  const kw = 'host=127.0.0.1 port=5432 dbname=zyass user=zyass sslmode=require';
  const o = pgConnectionOptions(kw);
  assert.equal(o.connectionString, kw);
  assert.equal(tls(o), 'non précisé');
});

test('une URL vide est refusée plutôt que muette', () => {
  assert.throws(() => pgConnectionOptions(''), /connectionString vide/);
});
