import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.ts';
import { normalizePhone, displayPhone, normalizeEmail, cents, cleanText, parseAttribution, initials, clamp } from '../server/lib/inputs.ts';
import { presentStepFor, slotOfferable } from '../server/domain/availability.ts';
import { safeEqual } from '../server/lib/security.ts';

test('téléphone : tous les formats français convergent vers le même numéro canonique', () => {
  const canon = '33644048385';
  for (const v of ['+33 6 44 04 83 85', '0644048385', '06 44 04 83 85', '0033 644 048 385', '+33(0)6 44 04 83 85', '+33 6.44.04.83.85']) {
    assert.equal(normalizePhone(v), canon, `format non normalisé : ${v}`);
  }
  assert.equal(normalizePhone('+1 415 555 0128'), '14155550128', 'un numéro étranger reste utilisable');
  assert.equal(normalizePhone('0644'), '0644', 'trop court : la couche API rejette, on invente pas de numéro');
  assert.equal(normalizePhone(''), '');
  assert.equal(displayPhone(canon), '06 44 04 83 85');
});

test('e-mail : casse et espaces neutralisés avant comparaison', () => {
  assert.equal(normalizeEmail('  Karim@Example.COM '), 'karim@example.com');
  assert.equal(normalizeEmail(null), '');
});

test('prix : les centimes deviennent un affichage français', () => {
  const fr = (v: string) => v.replace(/[\u202f\u00a0]/g, ' ');
  assert.equal(fr(cents(2500)), '25 €');
  assert.equal(fr(cents(2550)), '25,50 €');
  assert.equal(cents(null), '—');
  assert.equal(clamp(50, 10, 20), 20);
});

test('saisie libre : le HTML est retiré (défense en profondeur contre le XSS stocké)', () => {
  assert.equal(cleanText('<img src=x onerror=alert(1)>Karim', 40), 'Karim');
  assert.equal(cleanText('<a href="javascript:alert(1)">cli</a>quer', 40), 'cli quer', 'ni balise ni protocole actif');
  assert.equal(cleanText('  Karim   Benali ', 40), 'Karim Benali');
  assert.equal(cleanText('x'.repeat(500), 20).length, 20);
  assert.doesNotMatch(cleanText('<script>alert(1)</script>note', 100), /</, 'aucune balise ne survit — le texte, lui, reste lisible');
  assert.match(cleanText('<script>alert(1)</script>note', 100), /alert\(1\)note/);
  assert.equal(initials('karim', 'benali'), 'KB');
});

test('attribution : deep links réseaux sociaux (le lien Instagram doit survivre au copier-coller)', () => {
  const a = parseAttribution(new URLSearchParams('source=instagram&campaign=noel&utm_source=tiktok&service=coupe-barbe&heure=18:00'));
  assert.equal(a.source, 'instagram');
  assert.equal(a.campaign, 'noel');
  assert.equal(a.serviceKey, 'coupe-barbe');
  assert.equal(a.slot, '18:00');
  const b = parseAttribution(new URLSearchParams('utm_source=tiktok'));
  assert.equal(b.source, 'tiktok');
  assert.equal(b.medium, null);
});

test('pas de présentation : 15–30 min selon la durée', () => {
  assert.equal(presentStepFor(30), 15);
  assert.equal(presentStepFor(45), 23);
  assert.equal(presentStepFor(75), 30);
  assert.equal(presentStepFor(0), 30);
  assert.equal(presentStepFor(Number.NaN), 30);
});

test('gate unifié : tout ce qui est affiché est réservable (liste OU trou assez long)', () => {
  const day = { slots: [{ start: 1000 }], gaps: [{ start: 2000, end: 3000, usable: true, min: 30 }] };
  assert.equal(slotOfferable(day, 1000, 1300), true);
  assert.equal(slotOfferable(day, 2000, 2900), true);
  assert.equal(slotOfferable(day, 2000, 3100), false);
  assert.equal(slotOfferable(day, 900, 1200), false);
});

test('comparaison de secrets à temps constant', () => {
  assert.equal(safeEqual('abc123', 'abc123'), true);
  assert.equal(safeEqual('abc123', 'abc124'), false);
  assert.equal(safeEqual('a', 'aaaa'), false);
});
