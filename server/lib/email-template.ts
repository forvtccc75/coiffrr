/** HTML transactionnel autonome : tables + styles inline, texte brut conservé chez le fournisseur. */
export type EmailDesign = { subject: string; body: string; kind?: string; brandName?: string; appUrl: string; vars?: Record<string, any>; address?: string; phone?: string };
export const escapeHtml = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const safeUrl = (value: unknown) => { try { const u = new URL(String(value)); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } };
export function buildEmail(o: EmailDesign): string {
  const v = o.vars ?? {};
  const name = escapeHtml(o.brandName || 'Z.YASS Barber Shop');
  const titles: Record<string, string> = { booking_confirmed: 'Ton rendez-vous est confirmé.', reminder_d1: 'À demain au salon.', reminder_h3: 'On se voit tout à l’heure.', reminder_d3: 'Ton prochain rendez-vous.', rescheduled: 'Ton rendez-vous a été déplacé.', cancelled: 'Annulation confirmée.', waitlist_joined: 'Ta demande est enregistrée.', waitlist_offer: 'Une place se libère pour toi.', login_code: 'Ton code de connexion.', gift_card_received: 'Un cadeau qui fait plaisir.' };
  const kind = o.kind ?? '';
  const title = titles[kind] || o.subject;
  const code = kind === 'login_code' ? o.body.match(/\b\d{6}\b/)?.[0] : kind === 'gift_card_received' ? String(v.code ?? '') : null;
  const link = safeUrl(kind === 'waitlist_offer' ? v.link_claim : kind === 'gift_card_received' || kind === 'cancelled' ? v.link_book : v.link_manage);
  const label = kind === 'waitlist_joined' ? 'Suivre ma demande' : kind === 'waitlist_offer' ? 'Voir le créneau proposé' : kind === 'gift_card_received' || kind === 'cancelled' ? 'Choisir un créneau' : 'Gérer mon rendez-vous';
  const details = kind === 'login_code' ? [] : [['Prestation', v.service], ['Date', v.date], ['Heure', v.heure], ['Durée', v.duree], ['Avec', v.staff], ['Montant de la carte', kind === 'gift_card_received' ? v.montant : '']].filter(([, value]) => value && value !== '—');
  const bodyHtml = o.body.split(/(https?:\/\/[^\s<>]+)/g).map((part, i) => {
    if (i % 2) { const u = safeUrl(part); return u ? `<a href="${escapeHtml(u)}" style="color:#77521b;text-decoration:underline;word-break:break-all">${escapeHtml(part)}</a>` : escapeHtml(part); }
    return escapeHtml(part).replace(/\n/g, '<br>');
  }).join('');
  const logo = safeUrl(o.appUrl.replace(/\/$/, '') + '/brand/logo.png');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(o.subject)}</title></head>
<body style="margin:0;padding:0;background:#eeeae3;color:#242321;font-family:Arial,Helvetica,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(title)} — ${name}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eeeae3"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#fffdf8;border:1px solid #ded7c9;border-radius:16px;overflow:hidden">
<tr><td style="padding:28px 32px;background:#0b0b0d;border-bottom:3px solid #e8c98a">
${logo ? `<img src="${escapeHtml(logo)}" width="52" height="52" alt="Z.YASS" style="display:block;border:0;margin-bottom:14px">` : ''}
<div style="color:#e8c98a;letter-spacing:4px;font-size:17px;font-weight:bold">${name}</div><div style="color:#c4c0b8;font-size:11px;letter-spacing:2px;margin-top:8px">LES PAVILLONS-SOUS-BOIS</div></td></tr>
<tr><td style="padding:32px"><p style="margin:0 0 12px;color:#826235;font-size:11px;letter-spacing:2px;text-transform:uppercase">${kind === 'login_code' ? 'Accès sécurisé' : kind === 'gift_card_received' ? 'Carte cadeau' : 'Le salon s’occupe de toi'}</p>
<h1 style="font-family:Georgia,serif;font-size:30px;line-height:1.2;font-weight:normal;margin:0 0 24px">${escapeHtml(title)}</h1>
${code ? `<div style="background:#f3ead8;border:1px solid #d7bd89;padding:22px;text-align:center;margin-bottom:24px;font-size:${kind === 'login_code' ? '32' : '24'}px;font-weight:bold;letter-spacing:5px;color:#30291b">${escapeHtml(code)}</div>` : ''}
${details.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f1e9;border-radius:10px;margin-bottom:24px">${details.map(([k, value]) => `<tr><td style="padding:10px 14px;font-size:13px;color:#6c665d">${escapeHtml(k)}</td><td align="right" style="padding:10px 14px;font-size:14px;font-weight:bold">${escapeHtml(value)}</td></tr>`).join('')}</table>` : ''}
<div style="font-size:15px;line-height:1.7;overflow-wrap:anywhere">${bodyHtml}</div>
${link && kind !== 'login_code' ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:28px"><tr><td bgcolor="#e8c98a" style="border-radius:8px"><a href="${escapeHtml(link)}" style="display:inline-block;padding:16px 24px;color:#191714;text-decoration:none;font-size:15px;font-weight:bold">${label} →</a></td></tr></table>` : ''}
${kind === 'login_code' ? '<p style="font-size:12px;color:#756e64;margin-top:24px">Ce code est valable 10 minutes. Ne le communique à personne. Si tu ne l’as pas demandé, ignore cet e-mail.</p>' : ''}
</td></tr><tr><td style="padding:22px 32px;border-top:1px solid #e5dfd4;font-size:12px;line-height:1.7;color:#726b61"><b>${name}</b><br>${escapeHtml(o.address || '20 boulevard Roy, 93320 Les Pavillons-sous-Bois')}<br>${escapeHtml(o.phone || '06 44 04 83 85')}<br>Ce message concerne ta demande auprès du salon.</td></tr>
</table><p style="font-size:11px;color:#82796c;margin:18px 0 0">Z.YASS · Le dégradé net, la barbe propre.</p></td></tr></table></body></html>`;
}
