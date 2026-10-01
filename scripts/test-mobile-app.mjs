/** Vrai build + API mémoire. WebKit simule Safari, pas un iPhone physique. */
import { chromium, webkit, expect, devices } from '@playwright/test';
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
process.env.TEST_DB='memory'; process.env.DEMO_MODE='0'; process.env.NODE_ENV='test';
process.env.PAYMENTS_PROVIDER='off'; process.env.BOOTSTRAP_OWNER_EMAIL='mobile@example.test'; process.env.BOOTSTRAP_OWNER_PASSWORD='isolated-mobile-test-2026';
mkdirSync('.shots',{recursive:true});
const adapter=resolve('api/.mobile-test.mjs');
await build({entryPoints:['api/index.ts'],outfile:adapter,platform:'node',format:'esm',target:'node20',bundle:false,logLevel:'silent'});
const {default:handler}=await import(adapter); const server=createServer(handler); await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port; let count=0;
const ok=x=>{count++;console.log('✓ '+x);};
try {
  // Création de fixtures exclusivement dans le driver TEST_DB=memory.
  const auth=await fetch(base+'/api/public/auth/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'mobile@example.test',password:'isolated-mobile-test-2026'})}); expect(auth.status).toBe(200);
  const cookie=auth.headers.get('set-cookie').split(';')[0];
  for(const [path,body] of [['services',{key:'coupe-mobile-test',name:'Coupe test isolée',priceCents:2300,durationMin:30,active:true}],['staff',{name:'Barbier test isolé',active:true}]]) {
    const r=await fetch(base+'/api/admin/'+path,{method:'POST',headers:{'Content-Type':'application/json',cookie},body:JSON.stringify(body)});expect(r.ok).toBeTruthy();
  }
  for(const [engine, launcher] of [['chromium',chromium],['webkit',webkit]]) {
    const browser=await launcher.launch();
    try {
      const ctx=await browser.newContext({...devices['iPhone 13'],locale:'fr-FR',serviceWorkers:'block'});
      const p=await ctx.newPage(); const errors=[];p.on('pageerror',e=>errors.push(e.message));
      await p.goto(base,{waitUntil:'networkidle'});
      const tabs=p.getByRole('navigation',{name:'Navigation de l’application'});
      await expect(tabs).toBeVisible();await expect(tabs.getByRole('link')).toHaveCount(4);
      for(const link of await tabs.getByRole('link').all()) {const b=await link.boundingBox();expect(b.height).toBeGreaterThanOrEqual(44);expect(b.width).toBeGreaterThanOrEqual(44);}
      await expect(p.locator('.client-shell > .hd')).not.toBeVisible(); ok(engine+' : 4 onglets tactiles et en-tête compact');
      for(const [name,path] of [['Réserver','/book'],['Mes RDV','/espace'],['Le salon','/salon'],['Accueil','/']]) {
        await tabs.getByRole('link',{name,exact:true}).click();await expect(p).toHaveURL(base+path);await expect(tabs.getByRole('link',{name,exact:true})).toHaveAttribute('aria-current','page');
      } ok(engine+' : navigation des 4 onglets, état actif et routes réelles');
      await tabs.getByRole('link',{name:'Le salon',exact:true}).click();
      for(const href of ['/tarifs','/galerie','/infos','/cartes-cadeaux','/faq']) {
        await p.locator(`main a[href="${href}"]`).first().click();await expect(p).toHaveURL(base+href);await expect(tabs.getByRole('link',{name:'Le salon',exact:true})).toHaveAttribute('aria-current','page');await p.getByRole('link',{name:'Retour',exact:true}).click();
      }ok(engine+' : toutes les rubriques du salon et retour contextuel');
      await p.getByRole('button',{name:/Z.YASS sur ton écran/}).click();const dialog=p.getByRole('dialog');await expect(dialog).toBeVisible();
      expect(await p.locator('#root').evaluate(e=>e.inert)).toBeTruthy();await p.keyboard.press('Tab');expect(await p.evaluate(()=>!!document.activeElement.closest('[role=dialog]'))).toBeTruthy();
      await p.getByRole('button',{name:'Compris',exact:true}).click();await expect(dialog).toHaveCount(0);expect(await p.locator('#root').evaluate(e=>e.inert)).toBeFalsy();ok(engine+' : panneau d’installation accessible, focus contenu/restauré');
      await p.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await expect.poll(()=>p.evaluate(()=>scrollY)).toBe(0);await p.screenshot({path:`.shots/iphone-salon-${engine}.png`});
      await tabs.getByRole('link',{name:'Réserver',exact:true}).click();await p.locator('button.svc').first().click();
      await p.getByRole('button',{name:/AVEC QUI/}).click();await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:/Barbier test isolé/}).click();await expect(dialog).toHaveCount(0);
      await expect(p.locator('.staff-picker')).toContainText('Barbier test isolé');ok(engine+' : choix du barbier dans une feuille basse fonctionnelle');
      await p.locator('button.day').filter({hasText:/créx/}).first().click();await p.locator('button.slot').first().click();
      const dock=p.locator('.booking-dock');await expect(dock).toBeVisible();
      const d=await dock.boundingBox(),t=await tabs.boundingBox();expect(d.y+d.height).toBeLessThanOrEqual(t.y+1);ok(engine+' : action Continuer au-dessus des onglets, sans superposition');
      await dock.getByRole('button',{name:/Continuer/}).click();await expect(p.getByLabel('Prénom',{exact:true})).toBeVisible();await expect(dock.getByRole('button',{name:/Confirmer/})).toBeDisabled();
      await p.getByLabel('Prénom',{exact:true}).fill('Test mobile');await p.getByLabel('Téléphone',{exact:true}).fill(engine==='webkit'?'0677120012':'0677120011');
      expect(await p.getByLabel('Téléphone',{exact:true}).evaluate(e=>getComputedStyle(e).fontSize)).toBe('16px');
      await p.getByRole('checkbox',{name:/J'accepte que le salon me contacte/}).check();
      // Le clavier matériel n'est pas émulé : simuler uniquement son changement de visualViewport.
      await p.getByLabel('Téléphone',{exact:true}).focus();
      await p.evaluate(()=>{Object.defineProperty(window.visualViewport,'height',{configurable:true,value:window.innerHeight-300});window.visualViewport.dispatchEvent(new Event('resize'));});
      await expect(tabs).not.toBeVisible();await expect(dock).not.toBeVisible();await expect(p.locator('.booking-submit-inline')).toBeVisible();
      await p.evaluate(()=>{delete window.visualViewport.height;document.activeElement.blur();window.visualViewport.dispatchEvent(new Event('resize'));});
      await expect(tabs).toBeVisible();await expect(dock).toBeVisible();ok(engine+' : adaptation au viewport du clavier, formulaire non masqué');
      await dock.getByRole('button',{name:/Confirmer/}).click();await expect(p.getByRole('heading',{name:"C'est booké ✔"})).toBeVisible();await expect(dock).toHaveCount(0);ok(engine+' : réservation mobile complète, consentement et confirmation serveur sans paiement');
      for(const size of [{width:320,height:568},{width:390,height:844},{width:740,height:360},{width:844,height:390}]) {
        await p.setViewportSize(size);await p.goto(base+'/salon');await expect(tabs).toBeVisible();expect(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
      }ok(engine+' : 320 px, iPhone et paysage sans débordement');
      await p.goto(base+'/admin');await expect(tabs).toHaveCount(0);await expect(p.getByLabel('Mot de passe',{exact:true})).toBeVisible();ok(engine+' : administration distincte, aucun onglet client');
      expect(errors).toEqual([]);ok(engine+' : aucune exception JavaScript');
      await ctx.close();
      const desk=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});const dp=await desk.newPage();await dp.goto(base+'/');await expect(dp.locator('.hd')).toBeVisible();await expect(dp.locator('.app-tabs')).not.toBeVisible();await expect(dp.locator('.ft')).toBeVisible();ok(engine+' : desktop conservé');await desk.close();
    } finally {await browser.close();}
  }
  const manifest=await (await fetch(base+'/manifest.webmanifest')).json();expect(manifest.display).toBe('standalone');expect(manifest.shortcuts).toHaveLength(3);expect(manifest.scope).toBe('/');ok('manifest PWA, raccourcis et lancement autonome');
  const browser=await chromium.launch();try {
    const c=await browser.newContext();const p=await c.newPage();await p.goto(base);await p.evaluate(()=>navigator.serviceWorker.ready);await p.reload();await expect.poll(()=>p.evaluate(()=>!!navigator.serviceWorker.controller)).toBeTruthy();
    await c.setOffline(true);await p.goto(base+'/book');await expect(p.getByRole('heading',{name:'On se retrouve dans un instant.'})).toBeVisible();await expect(p.getByRole('link',{name:'Appeler le salon'})).toBeVisible();expect(await p.evaluate(()=>caches.keys())).toEqual([]);ok('hors connexion : écran honnête, téléphone, aucun cache de données ou de JavaScript');await c.close();
  }finally{await browser.close();}
  console.log(`${count}/${count} contrôles mobiles réussis, WebKit + Chromium, aucun accès Supabase.`);
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(adapter,{force:true});}
