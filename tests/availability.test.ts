import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, openDay } from './helpers.ts';
import { dateKey, todayDay, dayAdd, startOfDayMs, minFromHHMM, dow } from '../server/lib/time.ts';

/** La disponibilité est la garantie n°1 du produit : elle est calculée serveur, et elle ne ment jamais. */
test('config : la politique publiée est celle qui sert au moteur', async () => {
  const { json } = await call('/api/public/config');
  assert.ok(json.policy.slotStepMin > 0 && json.policy.slotStepMin <= 30);
  assert.ok(json.policy.leadTimeMin >= 5, 'il faut un délai de préparation minimal');
  assert.ok(json.policy.horizonDays >= 7);
  assert.ok(json.services.length >= 8);
  assert.equal(json.salon.timezone, 'Europe/Paris');
  assert.ok(json.staff.length >= 2);
});

test('créneaux : alignés sur le pas du salon, dans les horaires, jamais dans le passé', async () => {
  const cfg = (await call('/api/public/config')).json;
  const { json } = await call('/api/public/availability?service=coupe-homme&days=14');
  assert.ok(json.days.length >= 10, '14 jours explorés');
  assert.equal(json.policy.leadTimeMin, cfg.policy.leadTimeMin, 'le moteur et la config disent la même chose');
  const step = cfg.policy.slotStepMin;
  let seen = 0;
  for (const d of json.days) {
    for (const s of d.slots ?? []) {
      seen++;
      const mins = minFromHHMM(s.time);
      assert.equal(mins % step, 0, `${s.time} hors grille de ${step} min (${d.day})`);
      assert.ok(s.ts > Date.now() + json.policy.leadTimeMin * 60_000 - 1500, `${s.time} est trop proche`);
      assert.ok(s.ts >= startOfDayMs(d.day) && s.ts < startOfDayMs(d.day) + 86_400_000, `créneau hors journée ${d.day}`);
      const spans: [string, string][] = cfg.salon.hours[String(dow(startOfDayMs(d.day)))] ?? [];
      if (spans.length) {
        assert.ok(spans.some(([a, b]) => mins >= minFromHHMM(a) && mins <= minFromHHMM(b)), `créneau ${s.time} hors horaires du ${d.day}`);
      } else {
        assert.fail(`${d.day} : créneau proposé un jour sans horaires`);
      }
      assert.ok((s.staffIds ?? []).length > 0, 'chaque créneau indique qui est disponible');
    }
    const list = (d.slots ?? []) as any[];
    assert.ok(!list.some((s, i) => i && list[i - 1].ts >= s.ts), 'slots triés et uniques');
  }
  assert.ok(seen > 50, `aucune rareté fabriquée : ${seen} créneaux réels sur 14 jours`);
});

test('ZERO DEMANDE PERDUE : une journée sans créneau propose waitlist ou alternative, jamais un « complet » sec', async () => {
  const { json } = await call('/api/public/availability?service=decoloration&days=21');
  assert.ok(Array.isArray(json.alternatives), 'la réponse porte toujours un tableau alternatives');
  for (const d of json.days.filter((x: any) => !(x.slots ?? []).length)) {
    assert.ok(d.waitlistOpen === true || json.waitlistOpen === true || json.alternatives.length > 0, `${d.day} : demande perdue (ni waitlist ni alternative)`);
    assert.doesNotMatch(String(d.closed ?? ''), /complet/i, 'la fermeture explique le jour, ce n’est pas un « complet » de boutique');
  }
});

test('fermeture : un dimanche ne sort aucun créneau', async () => {
  let d = dayAdd(todayDay(), 1);
  for (let i = 0; i < 10 && dow(startOfDayMs(d)) !== 0; i++) d = dayAdd(d, 1);
  const { json } = await call(`/api/public/availability?service=coupe-homme&days=1&date=${d}`);
  const day = json.days[0];
  assert.equal(dow(startOfDayMs(d)), 0, 'on a bien tombé sur un dimanche');
  assert.equal(day.slots.length, 0, `dimanche ${d} : ${day.slots.length} créneaux proposés`);
  assert.ok(day.closed, 'la journée est marquée fermée avec sa raison');
});

test('rareté honnête : le compteur affiché = le nombre réel de créneaux libres', async () => {
  const { json } = await call('/api/public/availability?service=coupe-homme&days=7');
  for (const d of json.days) {
    assert.equal(d.count, (d.slots ?? []).length, `${d.day} : le compteur ne correspond pas à la liste`);
    assert.ok((d.freeMin ?? 0) >= 0);
  }
  assert.ok(typeof json.summary.message === 'string' && json.summary.message.length > 0);
  assert.equal(typeof json.summary.honest, 'boolean');
});

test('compétences : un barbier qui ne fait pas la prestation est refusé proprement, l’autre la propose', async () => {
  const cfg = (await call('/api/public/config')).json;
  const rayan = cfg.staff.find((s: any) => s.slug === 'rayan');
  const other = cfg.staff.find((s: any) => s.slug !== 'rayan');
  const yes = await call('/api/public/availability?service=decoloration&days=21');
  assert.equal(yes.status, 200);
  assert.ok(yes.json.days.reduce((a: number, d: any) => a + (d.slots ?? []).length, 0) > 0, 'la décoloration est planifiable');
  const no = await call(`/api/public/availability?service=decoloration&days=21&staff=${other.slug}`);
  assert.equal(no.status, 400);
  assert.equal(no.json.error, 'staff_incompatible');
  const filtered = await call(`/api/public/availability?service=decoloration&days=21&staff=${rayan.slug}`);
  assert.equal(filtered.status, 200);
  for (const d of filtered.json.days) for (const s of d.slots ?? []) assert.deepEqual(s.staffIds, [rayan.id], 'créneau attribué au seul barbier demandé');
});

test('prochain créneau : celui annoncé en direct existe réellement', async () => {
  const { json } = await call('/api/public/config');
  const next = json.live?.nextSlot;
  assert.ok(next && Number.isFinite(next.start), 'le salon publie un prochain créneau');
  const day = dateKey(next.start);
  const av = await call(`/api/public/availability?service=coupe-homme&days=1&date=${day}`);
  const found = (av.json.days[0].slots ?? []).some((s: any) => s.ts === next.start);
  const alt = (av.json.alternatives ?? []).some((s: any) => s.ts === next.start);
  assert.ok(found || alt, `créneau annoncé ${next.label} du ${day} absent de la journée`);
});

test('panier : options additionnelles = prix et durée réellement ajustés, créneau réservé en conséquence', async () => {
  const cfg = (await call('/api/public/config')).json;
  const { json } = await call('/api/public/availability?service=coupe-homme&days=14');
  assert.ok(json.service.offeringId > 0);
  const svc = cfg.services.find((x: any) => x.key === 'coupe-homme');
  assert.equal(json.service.priceCents, svc.priceFrom ?? svc.priceCents, 'le prix affiché dans l’url de réservation est celui du catalogue');
  assert.equal(json.service.addons.length, 0, 'sans option demandée, le panier reste la prestation simple');
  assert.ok((svc.addons ?? []).length >= 1, 'le catalogue suggère des options après une coupe');
  const addon = cfg.addons.find((a: any) => a.key === 'addon-barbe');
  const withAddon = await call(`/api/public/availability?service=coupe-homme&days=14&addons=${addon.id}`);
  assert.equal(withAddon.json.service.priceCents, svc.priceCents + addon.priceCents, 'avec option, le prix suit le catalogue');
  assert.equal(withAddon.json.service.durationMin, svc.durationMin + addon.durationMin, 'et la durée aussi — sinon le planning est faux');
  assert.equal(withAddon.json.service.addons[0].id, addon.id, 'l’option est rattachée à la réservation');
  const bundle = await call('/api/public/availability?service=coupe-barbe&days=1');
  assert.equal(bundle.json.service.durationMin, cfg.services.find((x: any) => x.key === 'coupe-barbe').durationMin);
  const o = await openDay();
  assert.ok(o.ts > Date.now());
  assert.match(o.day, /^\d{4}-\d{2}-\d{2}$/);
});
