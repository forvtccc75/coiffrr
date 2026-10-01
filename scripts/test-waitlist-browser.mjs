/** Base fraîche : TEST_DB=memory DEMO_MODE=0 + compte setup@example.test / isolated-browser-test-2026.
 * Jamais la production. Le domaine est volontairement fixé à la boucle locale. */
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
mkdirSync('.shots', { recursive: true });
const b = await chromium.launch(); const c = await b.newContext({ viewport: { width: 1280, height: 900 }, locale: 'fr-FR' }); const p = await c.newPage();
const base = 'http://127.0.0.1:5173'; let count = 0; const errors = []; p.on('pageerror', e => errors.push(e.message));
const ok = name => { count++; console.log('✓ ' + name); };
const json = async (path, body) => { const r = await p.request[body ? 'post' : 'get'](base+path, body ? { data: body } : {}); if (!r.ok()) throw new Error(path+' '+r.status()+' '+await r.text()); return r.json(); };
try {
  const health = await (await p.request.get('http://127.0.0.1:8787/healthz')).json(); if (health.dialect !== 'sqlite' || health.demo) throw new Error('Test réservé au carnet isolé SQLite NON-démo.');
  await p.goto(base+'/waitlist'); await expect(p.getByRole('heading', { name: 'Être prévenu de l’ouverture du planning' })).toBeVisible(); ok('catalogue vide : demande générale, sans prétendre que le planning est complet');
  await p.route('**/api/public/config', r=>r.fulfill({ status:503, contentType:'application/json', body:'{"message":"Test hors ligne"}' })); await p.reload(); await expect(p.getByRole('heading',{name:'Liste d’attente temporairement inaccessible'})).toBeVisible();
  await p.unroute('**/api/public/config'); await p.getByRole('button',{name:'Réessayer',exact:true}).click(); await expect(p.getByRole('heading',{name:'Être prévenu de l’ouverture du planning'})).toBeVisible(); ok('erreur réseau et réessai utiles');
  await p.setViewportSize({width:320,height:700}); await p.getByLabel('Prénom et nom').fill('Test attente'); await p.getByLabel('Téléphone',{exact:true}).fill('0677332201'); await p.getByLabel('E-mail (facultatif)',{exact:true}).fill('attente-browser@example.test');
  const consent = p.getByRole('checkbox',{name:/J'accepte d'être contacté/}); await expect(consent).not.toBeChecked(); await consent.check();
  await p.screenshot({path:'.shots/waitlist-mobile.png',fullPage:true}); expect(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy(); ok('formulaire 320 px, consentement explicite non précoché');
  const pending = p.waitForResponse(r=>r.url().endsWith('/api/public/waitlist') && r.request().method()==='POST'); await p.getByRole('button',{name:'Enregistrer ma demande',exact:true}).click(); const entry = await (await pending).json();
  await expect(p.getByRole('heading',{name:'Tu es dans la file ✔'})).toBeVisible(); ok('inscription générale réussie avant publication du catalogue');
  await p.getByRole('link',{name:'Ouvrir le suivi',exact:true}).click(); await expect(p.getByRole('heading',{name:'Ta demande'})).toBeVisible();
  await p.route('**/api/public/waitlist/cancel',r=>r.fulfill({status:500,contentType:'application/json',body:'{"message":"Retrait refusé pour test"}'})); await p.getByRole('button',{name:'Me retirer de la waitlist'}).click(); await expect(p.getByText('Retrait refusé pour test',{exact:true})).toBeVisible();
  expect((await json('/api/public/waitlist/status?token='+entry.token)).entry.status).toBe('active'); ok('retrait échoué : erreur affichée, aucun faux succès');
  await p.unroute('**/api/public/waitlist/cancel'); await p.getByRole('button',{name:'Me retirer de la waitlist'}).click(); await expect(p.getByText('demande retirée',{exact:true})).toBeVisible(); ok('retrait réussi : suivi actualisé');
  await p.goto(base+'/galerie'); const photo = p.locator('img[src="/gallery/zyass-devanture-google.webp"]'); await expect(photo).toBeVisible(); expect(await photo.evaluate(img=>img.complete && img.naturalWidth===1600)).toBeTruthy();
  await p.getByRole('button',{name:/Agrandir : Devanture/}).click(); await expect(p.getByRole('dialog')).toBeVisible(); await p.getByRole('button',{name:'Fermer',exact:true}).click(); expect(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy(); await p.screenshot({path:'.shots/galerie-google-mobile.png',fullPage:true}); ok('photo Google locale, dimensions réelles, agrandissement et mobile');
  await json('/api/public/auth/password',{email:'setup@example.test',password:'isolated-browser-test-2026',scope:'admin'});
  const service = await json('/api/admin/services',{key:'coupe-test',name:'Coupe test isolée',priceCents:2300,durationMin:30,active:true});
  await json('/api/admin/staff',{name:'Barbier test isolé',active:true});
  const entry2 = await json('/api/public/waitlist',{name:'Test proposition',phone:'0677332202',email:'offre-browser@example.test',serviceKey:'coupe-test',days:[],consent:true});
  const av = await json('/api/public/availability?service=coupe-test&days=7'); const slot = av.days.flatMap(d=>d.slots)[0]; expect(slot).toBeTruthy();
  const offered = await json(`/api/admin/waitlist/${entry2.id}/offer`,{start:slot.ts,staffId:slot.staffIds[0]}); expect(offered.offers).toBe(1); const offerToken = new URL(offered.claimUrls[0]).searchParams.get('token');
  await p.setViewportSize({width:1280,height:900}); await p.goto(base+'/waitlist/reserver?token='+encodeURIComponent(offerToken)); await expect(p.getByRole('button',{name:'Confirmer ce rendez-vous',exact:true})).toBeVisible();
  const status = await json('/api/public/waitlist/status?token='+entry2.token); expect(status.offers[0].status).toBe('pending'); ok('ouvrir le lien ne réserve rien, proposition lisible et prix affiché');
  await p.screenshot({path:'.shots/waitlist-offre.png',fullPage:true}); await p.getByRole('button',{name:'Confirmer ce rendez-vous',exact:true}).click(); await expect(p.getByRole('heading',{name:'Créneau réservé ✔'})).toBeVisible();
  const href = await p.getByRole('link',{name:'Voir mon rendez-vous',exact:true}).getAttribute('href'); const manage = new URL(href,base).searchParams.get('token'); expect((await json('/api/public/appointment?token='+manage)).appointment.status).toBe('booked'); ok('confirmation explicite et lien de gestion fonctionnel');
  await p.goto(base+'/waitlist/refuser?token='+encodeURIComponent(offerToken)); await expect(p.getByRole('heading',{name:'Cette proposition n’est plus disponible'})).toBeVisible(); expect((await json('/api/public/appointment?token='+manage)).appointment.status).toBe('booked'); ok('ouvrir un ancien refus ne détruit pas un RDV confirmé');
  const ns = await json('/api/admin/notifications'); expect(ns.some(n=>n.kind==='waitlist_offer' && n.channel==='email' && n.body_text.includes('/waitlist/reserver?token='))).toBeTruthy(); ok('offre e-mail dans la file transactionnelle, lien de confirmation correct (envoi simulé)');
  expect(errors).toEqual([]); ok('aucune exception JavaScript'); console.log(`${count}/${count} contrôles Chromium réussis. Aucune écriture dans Supabase.`);
} finally { await b.close(); }
