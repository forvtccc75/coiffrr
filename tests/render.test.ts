/**
 * Tests de rendu : le HTML livré avant JavaScript doit être *vrai*.
 *
 * On passe par le pipeline réel du pré-rendu (scripts/ssr-lib.mts) — le même arbre React, la même
 * API en process — et on vérifie que chaque page publique raconte quelque chose : un titre, un seul
 * <h1>, des prix réels, des liens de réservation actionnables, aucun texte d'erreur d'hydratation,
 * et aucun créneau figé dans le marbre (règle « zéro fausse rareté »).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPath, textOf } from '../scripts/ssr-lib.mts';

const cache = new Map<string, string>();
async function html(path: string): Promise<string> {
  if (!cache.has(path)) cache.set(path, await renderPath(path));
  return cache.get(path)!;
}

const PUBLIC = ['/', '/book', '/tarifs', '/galerie', '/infos', '/faq', '/cartes-cadeaux', '/waitlist', '/espace', '/accessibilite', '/mentions-legales', '/donnees-personnelles', '/guides', '/sitemap-view'];

test('toutes les pages publiques se rendent sans erreur de rendu serveur', async () => {
  for (const path of PUBLIC) {
    const h = await html(path);
    assert.ok(h.length > 400, `${path} : le rendu est vide (${h.length} octets)`);
    assert.ok(!/data-msg=/.test(h), `${path} : le rendu serveur a planté (marqueur d\u2019hydratation ${/data-msg="([^"]{0,60})/.exec(h)?.[1] ?? ''})`);
    assert.ok(!/Not Found|introuvable/.test(textOf(h).slice(0, 400)), `${path} : page servie en 404`);
  }
});

test('exactement un <h1> par page publique, et un titre lisible', async () => {
  for (const path of PUBLIC) {
    const h = await html(path);
    const n = (h.match(/<h1[\s>]/g) ?? []).length;
    assert.equal(n, 1, `${path} : ${n} <h1> (il en faut un seul, visible avant JavaScript)`);
  }
});

test('les pages de prestation portent leur prix et un CTA réservable', async () => {
  const cfg = await (await import('../client/src/lib/api.ts')).loadCfg();
  const services = (cfg as any)?.services ?? [];
  assert.ok(services.length >= 10, 'la config de démo doit être chargée pour que ce test veuille quelque chose');
  for (const sv of services.slice(0, 6)) {
    const path = `/${sv.key}`;
    const t = textOf(await html(path));
    assert.ok(/€/.test(t), `${path} : aucun prix lisible dans le HTML statique`);
    assert.ok(t.toLowerCase().includes(sv.name.toLowerCase().slice(0, 12)), `${path} : le nom de la prestation est absent`);
    const h = await html(path);
    assert.match(h, new RegExp(`href="/book\\?service=${sv.key}`), `${path} : pas de lien de réservation profond vers /book?service=`);
  }
});

test('tarifs : le catalogue complet est lisible sans JavaScript, avec les durées réelles', async () => {
  const t = textOf(await html('/tarifs'));
  const cfg: any = await (await import('../client/src/lib/api.ts')).loadCfg();
  const missing = (cfg?.services ?? []).filter((s: any) => !t.includes(s.name));
  assert.deepEqual(missing.map((s: any) => s.name), [], 'toutes les prestations doivent apparaître sur la page tarifs');
  assert.match(t, /\d+\s*€/, 'des prix');
  assert.match(t, /\d+\s*min/, 'des durées');
});

test('la rareté affichée reste honnête : le HTML figé ne promet aucun créneau', async () => {
  for (const path of ['/', '/tarifs', '/waitlist']) {
    const t = textOf(await html(path));
    assert.ok(!/plus que \d+ place|derni[eè]re place|seulement \d+ créneau|expire dans \d/.test(t), `${path} : compte à rebours ou rarete fabriquée`);
  }
  // « complet » ne doit jamais être un mur : s'il apparaît, la waitlist est proposée à côté.
  const w = textOf(await html('/waitlist'));
  assert.match(w, /waitlist|liste d.attente/i, 'la page waitlist doit expliquer la file, pas juste dire non');
});

test('aucun solde ni rendez-vous personnel dans le HTML public', async () => {
  for (const path of ['/', '/espace', '/tarifs']) {
    const t = textOf(await html(path));
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(t), `${path} : un jeton signé fuite dans le HTML`);
    assert.ok(!/"(manageToken|csrf|session)"/i.test(t), `${path} : un secret applicatif fuite dans le HTML`);
  }
});

test('le shell est stable d\u2019un rendu à l\u2019autre (pas d\u2019erreur d\u2019hydratation côté client)', async () => {
  for (const path of ['/tarifs', '/mentions-legales', '/donnees-personnelles']) {
    const a = await renderPath(path);
    const b = await renderPath(path);
    assert.equal(a, b, `${path} : deux rendus identiques diffèrent — le client hydratera en divergence`);
  }
});

test('le back-office rend son shell sans erreur, et son écran de connexion est sûr', async () => {
  const h = await html('/admin');
  assert.ok(h.length > 400, 'le shell admin doit être rendu');
  assert.ok(!/data-msg=/.test(h), 'le back-office ne doit pas lever au rendu serveur');
  // La page dépend de la session : on rend directement son écran de connexion, dans un routeur.
  const { createElement } = await import('react');
  const { StaticRouter } = await import('react-router-dom/server');
  const { Login } = await import('../client/src/admin/admin.tsx');
  const { renderFull } = await import('../scripts/ssr-lib.mts');
  const raw = await renderFull(createElement(StaticRouter as any, { location: '/admin' }, createElement(Login as any, { onDone: () => {}, demo: true })));
  const form = textOf(raw);
  assert.match(form, /mot de passe|code/i, 'l’écran de connexion doit être explicite');
  assert.match(raw, /type="password"/, 'un champ mot de passe de type password');
  assert.match(raw, /autocomplete="current-password"/i, 'le gestionnaire de mots de passe doit pouvoir remplir le champ');
  // étiquette réellement associée (htmlFor -> id), pas juste posée à côté : c'est ce que le
  // lecteur d'écran annonce pendant la saisie.
  const forM = /for="([^"]+)"/.exec(raw);
  assert.ok(forM, 'les champs de connexion doivent avoir une étiquette associée');
  assert.ok(raw.includes(`id="${forM![1]}"`), 'le htmlFor doit pointer vers un id présent');
});
