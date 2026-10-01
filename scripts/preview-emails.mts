import { readFileSync, writeFileSync } from 'node:fs';
import { buildEmail, escapeHtml } from '../server/lib/email-template.ts';
const logo = 'data:image/png;base64,' + readFileSync('client/public/brand/icon-192.png').toString('base64');
const templates = [
 ['booking_confirmed','Confirmation','Bonjour,\n\nTon rendez-vous est confirmé. Règlement sur place. Tu peux gérer ton rendez-vous avec le bouton ci-dessous.'],
 ['reminder_d1','Rappel','Un petit rappel : on se retrouve demain au salon. Besoin de déplacer ton rendez-vous ? Utilise ton lien de gestion.'],
 ['rescheduled','Report','Ton rendez-vous a été déplacé. Retrouve le nouvel horaire ci-dessous.'],
 ['cancelled','Annulation','Ton rendez-vous est annulé. Nous serons heureux de te revoir pour une prochaine coupe.'],
 ['waitlist_joined','Liste d’attente','Ta demande est enregistrée. Ce n’est pas encore un rendez-vous. Suis ta demande ou retire-toi depuis le lien dédié.'],
 ['waitlist_offer','Place disponible','Une place correspondant à ta demande vient de se libérer. Consulte l’offre avant son expiration.'],
 ['gift_card_received','Carte cadeau','Un moment pour toi chez Z.YASS.\nMontant : 50 €. Code : ZY-EXEM-PLE1. Le solde non utilisé reste sur la carte.'],
 ['login_code','Code de connexion','Ton code de connexion : 123456 (valable 10 minutes).'],
];
const panels = templates.map(([kind, label, body], i) => {
 const vars = kind === 'gift_card_received' ? { code: 'ZY-EXEM-PLE1', montant: '50 €', link_book: 'https://exemple.invalid/book' } : { service: 'Prestation exemple', date: '12 octobre 2026', heure: '10:30', duree: '30 min', staff: 'Ton barbier', link_manage: 'https://exemple.invalid/rdv', link_claim: 'https://exemple.invalid/waitlist' };
 const html = buildEmail({ appUrl: 'https://exemple.invalid', kind, subject: `Z.YASS — ${label}`, body, vars }).replace('https://exemple.invalid/brand/logo.png', logo);
 return `<iframe title="${label}" id="email-${i}" ${i ? 'hidden' : ''} srcdoc="${escapeHtml(html)}" sandbox=""></iframe>`;
}).join('');
writeFileSync('docs/APERCU-EMAILS.html', `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Z.YASS — Modèles d’e-mails</title><style>*{box-sizing:border-box}body{margin:0;background:#0b0b0d;color:#eee8dd;font:15px Arial}header{max-width:960px;margin:auto;padding:32px 20px 18px}small{color:#e8c98a;letter-spacing:3px}h1{font:36px Georgia;margin:12px 0}p{color:#b5b0a7;line-height:1.6}nav{display:flex;flex-wrap:wrap;gap:8px}button{border:1px solid #625132;padding:10px 14px;border-radius:24px;background:transparent;color:#e8c98a;cursor:pointer}button[aria-pressed=true]{background:#e8c98a;color:#171513}iframe{display:block;border:0;width:100%;height:1050px;background:#eeeae3}iframe[hidden]{display:none}main{max-width:960px;margin:auto}footer{padding:20px;text-align:center;color:#aaa}</style><header><small>Z.YASS / MESSAGES DU SALON</small><h1>Une identité, jusqu’à la boîte mail.</h1><p>Aperçus fictifs, sans envoi. Le site remplace les textes, montants, horaires et liens par ceux de la demande réelle. Logo intégré ici pour une consultation hors ligne.</p><nav>${templates.map(([,label],i)=>`<button aria-pressed="${i===0}" onclick="document.querySelectorAll('iframe').forEach((f,j)=>f.hidden=j!==${i});document.querySelectorAll('button').forEach((b,j)=>b.setAttribute('aria-pressed',j===${i}))">${label}</button>`).join('')}</nav></header><main>${panels}</main><footer>HTML responsive + texte brut · Brevo · Les liens d’exemple sont volontairement non fonctionnels.</footer></html>`);
console.log('docs/APERCU-EMAILS.html généré (aucun secret).');
