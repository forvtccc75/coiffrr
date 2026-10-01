# Z.YASS — Guide unique de mise en ligne et d’utilisation

**Vercel + Supabase · Paiement au salon · Administration · Brevo · Waitlist · Galerie Google · SEO**

Mise à jour : 30 septembre 2026. PDF généré : @@WHEN@@.

> **Document privé.** Le PDF contient les secrets applicatifs et le mot de passe initial admin. Les fichiers `.env.production.local` et `.env.admin.local` sont également privés. Ne pas les publier dans GitHub, une URL publique ou les captures d’écran. Le présent Markdown ne contient pas ces secrets. Le PDF remplace les anciens guides.

## 1. Ce qui a changé — et ce qui n’a PAS été fait

- Le paiement en ligne est désactivé par **`PAYMENTS_PROVIDER=off`** : aucun acompte, aucune clé Stripe nécessaire. Un rendez-vous est confirmé sans être enregistré comme payé. L’équipe encaisse au salon.
- L’accès administrateur se crée par **`BOOTSTRAP_OWNER_EMAIL` et `BOOTSTRAP_OWNER_PASSWORD`**, sur une base sans propriétaire. Ce n’est pas Supabase Auth.
- **Le SQL de structure n’a pas changé** pour cette passe : les cinq fichiers SQL ont été régénérés et comparés hors horodatage, sans différence. Si le bloc complet a déjà été appliqué, inutile de le recoller pour ces fonctions.
- **Base réelle initialisée le 29/09/2026, à votre demande :** 1 salon, 1 propriétaire, 4 modèles de prestations désactivés, 3 profils de barbiers inactifs. Aucun client, rendez-vous ou avis inventé. Ces données sont dans Supabase, pas dans une démo.
- **Vercel contrôlé :** `/healthz` 200, `/api/public/config` 200, authentification propriétaire 200 et réglages admin 200 sur `https://coiffrr-67hy.vercel.app`. L’erreur 500 venait de l’absence de salon dans les tables, malgré une connexion PostgreSQL fonctionnelle.
- **Code modifié directement dans le projet, aucun ZIP.** Le nouvel écran de réservation, la liste d’attente, la photo Google, l’édition des brouillons, le logo et Brevo attendent votre commit GitHub et redéploiement Vercel. Le workspace ne déploie pas automatiquement votre site.
- Le logo choisi est décliné en logo de site, favicon SVG/PNG/ICO, icône Apple et PWA. Les e-mails sont en HTML responsive + texte brut. Aperçus non envoyés : `docs/APERCU-EMAILS.html`.
- Aucun compte Brevo/Meta/Twilio, domaine DNS, ordonnanceur externe ni compte Google n’a été activé à votre place. La réception réelle des e-mails n’est pas encore vérifiée.

**Important :** faire tourner le mot de passe de la base partagé dans la conversation, puis utiliser le nouveau dans `DATABASE_URL`. Ne pas utiliser `npm run seed` ou `db:reset` sur la production : ils servent à la démonstration et aux tests.

## 2. Déployer — dans cet ordre

1. Mettre le code dans votre dépôt GitHub privé, sans fichiers `.env`, PDF privé ni base locale. Vérifier `.gitignore`.
2. Vercel → importer le dépôt. **Node.js 22.x**, Framework Preset « Other ». Le fichier `vercel.json` règle la construction : `npm ci`, puis `npm run build`, fonction Node en région Paris. Le build compile aussi le serveur avec `npm run build:server` vers `dist/server/app.cjs` : l’entrée Vercel ne doit jamais importer directement `server/app.ts`. Ne pas remplacer ce montage par un simple hébergement de fichiers HTML.
3. Le fichier `vercel.json` ne déclare **aucun cron Vercel** : la section `crons` a été supprimée. Cela évite le blocage de fréquence Hobby. Configurer un ordonnanceur externe (§6) pour les rappels programmés. Vérifier séparément les conditions du plan pour un site commercial.
4. Vercel → Settings → Environment Variables → Production → importer `.env.production.local`, après les remplacements décrits au §3. Ne pas connecter un environnement Preview de test au carnet de production : lui donner une base et des secrets séparés.
5. Déployer. `PRERENDER_DB=live` lit la vraie configuration Supabase pour le HTML indexable. `PRERENDER_STRICT=1` bloque le build si ce pré-rendu échoue, plutôt que publier silencieusement du contenu de démonstration. Le build doit donc pouvoir joindre la base.
6. Ouvrir `https://VOTRE-DOMAINE/admin`, se connecter avec l’accès privé déjà créé au §4. `BOOTSTRAP_OWNER_*` ne sert que pour une nouvelle base vide.
7. Retirer les **trois** variables `BOOTSTRAP_OWNER_EMAIL`, `BOOTSTRAP_OWNER_PASSWORD`, `BOOTSTRAP_OWNER_NAME` de Vercel, puis redéployer. Le compte et le mot de passe restent dans la base, le mot de passe est haché.
8. Paramétrer le salon (§4), brancher les notifications (§6), puis **redéployer après la saisie des prix, de l’équipe et des horaires** pour actualiser le HTML pré-rendu destiné aux moteurs.
9. Faire un vrai rendez-vous d’essai, vérifier les messages, l’accès client, le planning et l’annulation avant de partager le lien.

## 3. Variables Vercel — bloc complet prêt à adapter

Le bloc contient les réglages applicatifs utiles à **votre exploitation sans Stripe**. Les options Stripe restent dans le code pour d’autres usages mais ne sont pas à remplir ici. `PORT`, `DATA_FILE`, `TEST_DB`, `WEB_PORT` et les réglages de tests ne doivent pas être ajoutés à Vercel.

**Remplacements indispensables :**

| Variable | Valeur à fournir |
|---|---|
| `APP_URL` | Le vrai domaine HTTPS, sans slash final. Une adresse `https://votre-projet.vercel.app` convient pour le premier essai ; remplacer par le domaine final et redéployer avant ouverture. |
| `DATABASE_URL` | URL PostgreSQL Supabase **pooler Session, port 5432**, projet fourni, avec le NOUVEAU mot de passe encodé dans l’URL. |
| `BOOTSTRAP_OWNER_EMAIL` | Seulement sur une nouvelle base sans owner : identifiant admin distinct d’un client. Retirer cette variable sur le salon déjà initialisé. |
| `BOOTSTRAP_OWNER_PASSWORD` | Seulement pour une nouvelle installation. Unique, 12 à 200 caractères. Le mot de passe du compte existant est au §4, pas dans les variables à importer. |
| `BOOTSTRAP_OWNER_NAME` | Votre prénom affiché. |
| `SESSION_SECRET`, `TOKEN_SECRET`, `CRON_SECRET` | Trois secrets différents, déjà générés dans le PDF privé. Ne pas copier les secrets d’une autre installation. |

Le secret de cron protège l’URL d’automatisation. Le secret de jetons signe les liens de gestion clients ; le changer invalide les liens déjà envoyés. Aucun secret n’a de préfixe `VITE_` ou `NEXT_PUBLIC_` : ils restent côté serveur.

**Modèle de connexion de votre projet :**

```text
postgresql://postgres.hdtqmvajwbplwqpakfmq:MOT_DE_PASSE_ENCODE@aws-0-eu-west-2.pooler.supabase.com:5432/postgres?sslmode=require
```

Copier l’URL depuis Supabase → Connect → Session pooler. Encoder les caractères réservés du mot de passe (`@` → `%40`, `#` → `%23`, etc.). Le pooler transaction 6543 n’a pas été validé dans cette configuration : conserver 5432. **Le mode transaction ne casse pas intrinsèquement les transactions PostgreSQL** ; l’ancienne affirmation générale du guide était incorrecte. Le pilote a sa politique TLS documentée dans `server/db/pg-options.ts` ; vérifier la chaîne du certificat si vous choisissez un mode de vérification stricte.

### Bloc privé à importer

@@ENV@@

**Ne pas oublier :** `EMAIL_PROVIDER=stdout` et `SMS_PROVIDER=stdout` permettent un premier démarrage **sans aucun envoi réel**. Le carnet peut enregistrer des rendez-vous, mais ni les rappels ni les codes de connexion ne seront livrés. Il faut configurer les fournisseurs avant d’ouvrir au public.

Les clés Supabase `anon`, `service_role` et `SUPABASE_URL` ne sont pas nécessaires à cette application : l’API serveur utilise PostgreSQL directement via `DATABASE_URL`. Ne jamais exposer cette URL au navigateur.

## 4. Comment entrer et travailler en administrateur

### Votre accès déjà créé — confidentiel

Adresse : **https://coiffrr-67hy.vercel.app/admin**.

@@ADMIN@@

`ADMIN_EMAIL` est ici un **identifiant applicatif interne**, pas une boîte mail à configurer. Les lignes `ADMIN_*` de ce bloc servent à lire les identifiants : **ne pas les importer dans Vercel**. Le compte se trouve dans la table applicative `users`, pas dans Supabase Auth.

Cet accès propriétaire agit sur **le vrai salon**. Il ne sert pas à fabriquer des RDV fictifs en production. Pour essayer un parcours de bout en bout, utiliser une base de test séparée ; ne pas publier les profils génériques. Après redéploiement, **Réglages → Sécurité** permet de changer le mot de passe initial et de révoquer les autres sessions. Conserver le nouveau mot de passe dans un gestionnaire : ce PDF ne se met pas à jour automatiquement.

Ne pas utiliser `owner@zyass.fr / demo-owner` sur le vrai site : ces identifiants sont réservés à la démonstration locale.

### Pour une future installation sur une base vide

L’application initialise l’identité du salon et les horaires de référence sans dépendre des variables owner : la config publique peut ainsi répondre sans 500. Le premier propriétaire se crée uniquement si `BOOTSTRAP_OWNER_EMAIL` et `BOOTSTRAP_OWNER_PASSWORD` sont renseignés. Les modèles privés sont une action distincte, volontaire, via **Réglages → Préparer les modèles privés** ; elle ne remplace pas un catalogue existant. Aucun modèle n’est publié automatiquement.

Si un propriétaire existe déjà, les variables de bootstrap ne le remplacent pas et ne créent pas un deuxième administrateur. Pour un mot de passe oublié, une personne disposant de l’accès serveur peut utiliser `npm run admin:new -- --change` avec `DATABASE_URL`, `ADMIN_EMAIL` et `ADMIN_PASSWORD` fournis en environnement sécurisé. Cette commande change uniquement un compte owner existant et révoque ses sessions. Changer simplement la variable de bootstrap ne réinitialise pas un compte.

### Préparer le salon avant ouverture

1. **Réglages → Marque** : vérifier téléphone, e-mail réel, texte du salon, lien Google, réseaux sociaux et numéro WhatsApp. Un numéro public de téléphone ne prouve pas qu’il accepte WhatsApp : le confirmer.
2. **Réglages → Équipe** : les trois profils inactifs sont des emplacements de préparation, pas une affirmation sur l’équipe réelle. Renommer uniquement ceux qui correspondent à de vrais barbiers, préciser leurs compétences puis cocher l’activation. Laisser les autres inactifs. Aucun choix de prestation coché signifie « toutes les prestations publiées ». Les comptes de connexion collaborateurs ne sont pas automatiquement créés par l’ajout d’un barbier ; l’accès owner est le chemin opérationnel documenté ici.
3. **Réglages → Prestations** : les quatre modèles privés sont Coupe homme, Taille de barbe, Coupe + barbe, Coupe enfant. Le prix zéro signifie « à renseigner », pas une prestation gratuite. Les durées 30/20/45/25 min sont des suggestions à valider. Saisir les vrais prix, durées et descriptions, puis cocher « Publier ». L’application crée les offres réservables correspondantes. Ne pas ouvrir la réservation avant cette vérification.
4. **Réglages → Horaires** : semaine du salon et de chaque barbier, pauses, jours fermés et exceptions. Tester une date ouverte et une date fermée. Les horaires individuels priment sur la semaine salon ; utiliser un blocage de fermeture pour une fermeture exceptionnelle de tout le salon.
5. **Planning → Bloquer une plage** : congé, absence ou indisponibilité. Supprimer le blocage pour rouvrir la plage.
6. **Automatisations** : vérifier confirmations, rappels et file d’envoi. Rebooking, anniversaires, fidélité et marketing doivent être configurés selon les règles réellement décidées par le salon et les consentements clients ; tout n’est pas activé sans validation.
7. Redéployer après cette configuration pour mettre à jour les pages pré-rendues.

### Une journée normale

- **Aujourd’hui / Planning** : voir les RDV, ajouter une réservation téléphonique, déplacer, annuler, suivre une arrivée ou une absence.
- Le client paie sur place. **« terminé » enregistre le reste à payer comme encaissé, en tenant compte de la carte cadeau déjà utilisée** : utiliser cette action après le paiement réel, pas seulement après la coupe.
- **Clients** : retrouver une fiche, son historique et les notes internes.
- **Waitlist** : suivre les demandes qui attendent une place.
- **Automatisations** : surveiller les envois en attente ou refusés ; vérifier la cause avant de relancer.
- **Marketing → Cartes cadeaux** : « Émettre après encaissement au salon ». Un dialogue demande le montant et une confirmation d’encaissement. Aucun débit bancaire n’est effectué par le logiciel : il enregistre ce que vous confirmez avoir reçu.

## 5. Comment cela fonctionne pour un client

1. Il arrive depuis le site, Instagram, TikTok ou Google, par exemple `/book?service=coupe-barbe&source=instagram` **si cette clé de prestation existe dans votre catalogue**.
2. Il choisit une prestation, un barbier ou « peu importe », un jour et une heure réellement disponibles.
3. Il renseigne son prénom, son téléphone et éventuellement son e-mail, puis valide les conditions. Les consentements marketing sont séparés.
4. Le serveur contrôle de nouveau la disponibilité et enregistre le RDV sous transaction : deux personnes ne peuvent pas occuper le même barbier sur le même créneau dans cette plateforme.
5. **Aucune carte bancaire, aucun Stripe, aucun acompte.** Il obtient une confirmation et un lien de gestion. Les messages sont livrés uniquement si les fournisseurs et le cron sont raccordés.
6. Depuis son lien, il confirme, reporte ou annule selon la politique affichée. S’il ne trouve pas de place, le site propose la liste d’attente et des alternatives.
7. `/espace` : après sa première réservation, il demande un code par SMS ou e-mail pour retrouver son espace. **Les codes envoyés au téléphone utilisent le SMS**, même si les rappels utilisent WhatsApp. Prévoir Twilio pour ce parcours, ou l’e-mail Brevo avec une adresse renseignée lors de la réservation.
8. Il vient au salon et règle sa prestation à l’équipe.

**Pas de synchronisation Planity/Google Calendar déjà active.** Avant ouverture, reprendre les RDV existants dans le planning ou fermer l’ancien canal de réservation. La protection contre les doublons ne couvre pas un autre agenda indépendant.

## 6. Notifications — ce qu’il faut vraiment brancher

### E-mail avec Brevo — fournisseur demandé

1. Dans Brevo, activer l’envoi transactionnel, ajouter le domaine/expéditeur et réaliser la vérification DNS demandée (notamment DKIM, ainsi que les recommandations SPF/DMARC de Brevo).
2. Créer une **clé API v3** : ce n’est **pas** un mot de passe SMTP.
3. Dans Vercel → Environment Variables → Production, renseigner :

```dotenv
EMAIL_PROVIDER=brevo
BREVO_API_KEY=VOTRE_CLE_API_V3
EMAIL_FROM=Z.YASS Barber Shop <reservation@VOTRE-DOMAINE.fr>
EMAIL_FROM_NAME=Z.YASS Barber Shop
EMAIL_REPLY_TO=contact@VOTRE-DOMAINE.fr
```

`EMAIL_REPLY_TO` est facultatif ; laisser vide pour utiliser le fonctionnement normal du fournisseur. `EMAIL_FROM_NAME` est utilisé quand `EMAIL_FROM` ne contient qu’une adresse. L’adresse d’envoi doit être autorisée chez Brevo. Aucune clé `VITE_*`, aucun serveur SMTP, aucun `templateId` n’est requis.

4. **Redéployer** après modification des variables. Le code appelle `POST https://api.brevo.com/v3/smtp/email` et transmet expéditeur, destinataire, sujet, HTML et texte brut. La clé reste côté serveur.
5. Tester vers votre propre boîte : confirmation, code `/espace`, rappel, annulation, report, puis carte cadeau réellement encaissée. Vérifier aussi les spams et les journaux transactionnels Brevo. Une réponse API 201 signifie **accepté par Brevo**, pas nécessairement reçu ou lu. Les modèles ont été testés avec un fournisseur simulé, pas avec une clé réelle.
6. Brancher l’ordonnanceur ci-dessous pour les rappels différés et la file de cartes cadeaux. Les confirmations et codes ont un déclenchement immédiat ; cela ne remplace pas le cron.

**Présentation :** monogramme doré, en-tête noir, contenu ivoire, récapitulatif et bouton adapté, code de connexion lisible. Les caractères HTML des données sont échappés. Le logo d’un véritable e-mail est chargé depuis `APP_URL/brand/logo.png` : l’URL doit être publique en HTTPS et le destinataire peut bloquer les images. Aperçu hors ligne, avec logo intégré : `docs/APERCU-EMAILS.html`.

**Sans clé :** conserver `EMAIL_PROVIDER=stdout` pour démarrer sans livraison, puis passer à `brevo` avant ouverture. `stdout` simule un envoi et peut afficher `sent` dans la base, mais **n’envoie aucun e-mail**. Une clé Brevo absente ou un refus 401/403 ne sont pas maquillés en succès : consulter la file et les erreurs dans l’admin. Après raccordement, relancer uniquement les messages encore pertinents, jamais des codes expirés. Resend reste une alternative facultative (`EMAIL_PROVIDER=resend` + `RESEND_API_KEY`), pas le réglage conseillé pour ce salon.

Référence technique : https://developers.brevo.com/reference/send-transac-email

### SMS avec Twilio

Configurer un compte Twilio autorisé à envoyer vers les destinataires concernés et un expéditeur valide :

```dotenv
SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=AC_VOTRE_SID
TWILIO_AUTH_TOKEN=VOTRE_JETON
TWILIO_FROM=+VOTRE_NUMERO_TWILIO
NOTIFY_TEXT_CHANNEL=sms
```

`TWILIO_FROM` n’est pas arbitrairement le numéro personnel du salon. Ne pas mettre `whatsapp:` dans l’expéditeur destiné aux SMS. Tester le code `/espace`, la confirmation et le rappel avec un vrai téléphone. Les restrictions du compte d’essai doivent être levées avant ouverture.

### WhatsApp Business Meta — facultatif

Le bouton de contact du site et les rappels WhatsApp automatiques sont deux choses différentes :

- Le bouton utilise le numéro saisi dans **Réglages → Marque** et ouvre WhatsApp chez le client. Aucune API Meta nécessaire pour ce simple lien.
- Les rappels automatiques nécessitent un compte WhatsApp Business Platform, un numéro rattaché à l’application, un jeton autorisé, le consentement adapté et un modèle validé par Meta.

```dotenv
WHATSAPP_PROVIDER=meta
WHATSAPP_ACCESS_TOKEN=VOTRE_JETON
WHATSAPP_PHONE_NUMBER_ID=IDENTIFIANT_DU_NUMERO_META
WHATSAPP_API_VERSION=v21.0
WHATSAPP_TEMPLATE_NAME=NOM_EXACT_DU_MODELE_APPROUVE
WHATSAPP_TEMPLATE_LANG=fr
NOTIFY_TEXT_CHANNEL=whatsapp
```

**Correction importante de l’ancienne explication :** réserver sur le site n’ouvre PAS une fenêtre WhatsApp de 24 h. Cette fenêtre dépend d’un message WhatsApp du client. Les rappels envoyés hors fenêtre exigent un modèle approuvé. Ne pas considérer le texte libre comme configuration de production des rappels.

Le connecteur actuel transmet **une variable texte dans le corps du modèle**. Le modèle Meta doit correspondre à ce format ; son approbation n’est pas garantie. Il n’y a pas de suivi local fiable de la fenêtre conversationnelle : configurer le modèle pour les automatisations. Garder SMS/e-mail pour les codes clients. Tester le payload accepté, la réception sur téléphone et l’identifiant `wamid`. Une réponse API acceptée n’est pas une preuve de lecture du client.

### Cron : indispensable pour les rappels et les reprises d’envoi

**Correctif définitif du fichier : aucune section `crons` dans `vercel.json`.** Le site peut être déployé sans demander de cron Vercel. Cela ne programme PAS les rappels : l’ordonnanceur externe ci-dessous doit être activé.

Si Vercel affiche encore une erreur mentionnant `*/5 * * * *`, le déploiement utilise une autre révision ou un autre fichier que celui livré ici. Remplacer le fichier dans le dépôt GitHub relié au projet, créer un nouveau commit sur la branche de production, puis vérifier le commit du nouveau déploiement. Relancer simplement un ancien déploiement peut réutiliser son ancienne configuration. Vérifier aussi Settings → Build and Deployment → Root Directory : Vercel doit lire le fichier dans le bon dossier du projet.

Pour conserver une exécution fréquente sans le cron fréquent de Vercel, configurer un ordonnanceur externe compatible avec les appels HTTP authentifiés (par exemple cron-job.org), selon les limites de son offre :

- Méthode : `GET`.
- URL : `https://VOTRE-DOMAINE/api/internal/cron`.
- En-tête : `Authorization` ; valeur : `Bearer VOTRE_CRON_SECRET` (exactement le même secret que dans Vercel).
- Fréquence : toutes les cinq minutes si le service le permet.
- Activer les alertes d’échec et vérifier le premier appel : HTTP 200 et résultat sans erreur de salon.

Ne pas placer le secret dans une URL publique ni partager une capture de l’en-tête. La section `crons` est déjà retirée ; ne pas la réintroduire avec une fréquence incompatible Hobby. Garder un seul ordonnanceur actif. **Aucun service externe n’a été créé ou activé depuis le workspace.**

Pour un test manuel avec un terminal sécurisé :

```bash
curl --fail -H "Authorization: Bearer $CRON_SECRET" "$APP_URL/api/internal/cron"
```

Ne pas lancer plusieurs ordonnanceurs simultanément sans nécessité. Le relais GitHub dans `.github/workflows/cron.yml` est une alternative désactivée par défaut, pas une garantie de ponctualité à la minute. Un prestataire d’envoi sans cron n’assure pas les rappels programmés.

## 7. SEO Google et visibilité dans les assistants IA

### Implémenté dans cette passe

- Métadonnées par page, URL canonique absolue, Open Graph et Twitter pour les aperçus.
- Mise à jour des métadonnées pendant la navigation côté navigateur.
- HTML public pré-rendu ; en production, `PRERENDER_DB=live` utilise vos données réelles.
- Données structurées `HairSalon`, prestations, personnes, articles et fil d’Ariane selon la page.
- Suppression de la note structurée tirée d’un ancien compteur de marque : pas d’étoiles artificielles.
- `sitemap.xml` dynamique, correction de `/infos`, redirection de l’ancien chemin et vraies réponses HTTP 404 pour les URL inconnues.
- Correction des pages barbiers sur leur chemin canonique `/barbier/<slug>`.
- `robots.txt` public, directives pour les robots de recherche IA, exclusions des liens privés.
- `noindex`, absence de cache partagé et protection du referrer pour les routes personnelles/API. Robots.txt n’est pas un contrôle d’accès : l’authentification reste nécessaire.
- `/llms.txt` et `/llms-full.txt` dynamiques avec identité, coordonnées, horaires et prix configurés, sans données clients. **Format expérimental complémentaire, pas une garantie d’indexation ou de citation.**

### À faire sur vos comptes après mise en ligne

1. Brancher le domaine définitif, vérifier HTTPS et l’unicité des URL. `APP_URL` doit correspondre à ce domaine.
2. Google Search Console → ajouter une propriété Domaine, poser le TXT DNS de vérification, soumettre `https://VOTRE-DOMAINE/sitemap.xml`, inspecter l’accueil, les tarifs et une prestation.
3. Bing Webmaster Tools → ajouter le site et soumettre le même sitemap.
4. Google Business Profile → revendiquer ou vérifier la fiche réelle, conserver les mêmes nom/adresse/téléphone, renseigner horaires, photos réelles, lien du site et lien `/book`.
5. Vérifier les données structurées avec les outils Google/Schema.org, mesurer PageSpeed mobile sur le domaine public, suivre les erreurs d’indexation et les Core Web Vitals dans la durée.
6. Remplacer les images d’illustration par des photos autorisées du salon ; vérifier descriptions, tarifs, horaires, transports et mentions légales. Ne pas publier de chiffres de satisfaction ou de disponibilité inventés.
7. Solliciter les avis honnêtes de tous les clients, sans récompense conditionnée à une note ni filtrage des clients autorisés à laisser un avis public.
8. Après une modification importante du catalogue ou de l’équipe, redéployer pour actualiser le HTML statique. Les endpoints sitemap et llms se mettent à jour depuis la base, sous leur délai de cache.

**Aucune promesse de résultat à 100 %.** Google indique qu’aucune optimisation spéciale ni fichier IA n’est nécessaire pour ses fonctions IA, et que respecter les critères ne garantit pas l’exploration, l’indexation ou l’affichage. Les positions locales et citations dépendent aussi de la concurrence, de la notoriété, de la fiche établissement et des décisions des moteurs.

Référence officielle : https://developers.google.com/search/docs/appearance/ai-features

## 8. SQL complet — à conserver, pas à rejouer inutilement

**Projet déjà initialisé :** aucun SQL supplémentaire à appliquer pour le paiement sur place, le bootstrap admin ou le SEO. Déployer le code et les variables. Les données métier se créent par le bootstrap et vos réglages admin, pas par le script de schéma.

**Nouvelle base :** Supabase → SQL Editor → exécuter le bloc ci-dessous avec un compte propriétaire. Il crée les tables, index et restrictions d’accès. Il ne contient aucun client ni mot de passe de démonstration.

@@SQL:db/supabase/00-tout-en-un.sql@@

### Vérifications en lecture seule

@@SQL:db/supabase/03-controles.sql@@

### Requêtes d’exploitation en lecture seule

@@SQL:db/supabase/04-exploitation.sql@@

RLS et restrictions de rôles empêchent l’accès direct par les clés publiques Supabase. Le serveur utilise son compte PostgreSQL privé. Ne pas distribuer la chaîne de connexion. Ne pas forcer RLS sur le propriétaire sans adapter cette architecture.

## 9. Contrôle final avant ouverture

- [ ] Mot de passe Supabase renouvelé ; URL 5432 mise dans Vercel.
- [ ] Connexion `/admin` avec votre compte réel ; variables de bootstrap retirées.
- [ ] Pas de comptes de démo, de clients fictifs ou de faux rendez-vous dans le carnet.
- [ ] Vrais barbiers, prestations, prix et horaires configurés, nouvelle version déployée.
- [ ] Un RDV créé sans carte bancaire ; `paid_cents` reste à zéro avant encaissement.
- [ ] Confirmation reçue réellement, code client reçu, annulation testée.
- [ ] Créneau annulé libéré et offre waitlist testée avec un numéro qui a accepté ce contact.
- [ ] Cron visible dans les journaux ; aucun message en échec ignoré.
- [ ] Agenda Planity/externe repris ou désactivé pour éviter les doubles réservations externes.
- [ ] Domaine et sitemap vérifiés dans Search Console/Bing ; fiche Google mise à jour.
- [ ] Photos réelles, adresse e-mail légale, régime TVA et médiateur de la consommation vérifiés avec le salon.
- [ ] Sauvegarde et restauration testées hors production.

### Sauvegarde

Les fonctions de sauvegarde et de PITR dépendent du plan Supabase et des options souscrites : ne pas supposer que le plan gratuit comprend des sauvegardes récupérables ou que le PITR est inclus par défaut. Vérifier le tableau de bord de votre projet.

```bash
pg_dump "$DATABASE_URL" -Fc --no-owner -f "zyass-$(date +%F).dump"
# Restauration d’essai vers une AUTRE base vide, jamais par mégarde sur la production :
pg_restore -d "$DATABASE_URL_TEST" --single-transaction --no-owner "zyass-2026-09-28.dump"
```

Conserver le dump chiffré, avec un accès limité : il contient des données personnelles. Employer un client PostgreSQL compatible avec la version du serveur.

## 10. Tests et limites

**Nouvelle passe, 29/09/2026 (Brevo / initialisation / logo) :** `npm run check` réussi : **142/142 tests**, **22/22 smoke**, **12/12 contrôles Node natif sans sources TypeScript**, build strict et audit statique sans violation. **14/14 contrôles navigateur Chromium** sur base SQLite en mémoire : erreur API, réessai, catalogue vide, écran 320 px, Maps/horaires, création et édition des brouillons, activation explicite, disponibilités, réservation complète sans paiement en ligne et fichiers logo. Aucun test de réservation n’a écrit dans Supabase. Connexion propriétaire, réglages, Aujourd’hui, Planning et disponibilité publique vérifiés séparément sur Vercel (HTTP 200).

**Passe antérieure, 28/09/2026 :** `npm run check` réussi : **136/136 tests**, **22/22 garanties**, **33 pages pré-rendues** sur le catalogue de démonstration, **0 violation bloquante** de l’audit statique, **101,0 ko** JS+CSS compressés (hors images, pas une mesure réseau). **18/18 tests navigateur ciblés** réussis sur Chromium bureau et téléphone 320 px, avec `PAYMENTS_PROVIDER=off` : réservation, admin, métadonnées, profil barbier, confidentialité et cartes cadeaux au comptoir. La suite WebKit/iPhone complète n’a pas été rejouée dans cette passe (bibliothèques système manquantes).

Un build strict séparé a aussi été joué sur une base vide en mémoire, `DEMO_MODE=0`, avec bootstrap propriétaire et `PRERENDER_DB=live` : 13 pages produites avant l’ajout de la page réservation au pré-rendu, audit statique réussi, sans données fictives. Ce test local ne prouve pas encore un déploiement Vercel réel.

Les suites dédiées `production-access.test.ts` et `onsite-seo.test.ts` couvrent l’initialisation vide, les démarrages simultanés, la connexion propriétaire, la non-réinitialisation implicite du mot de passe, le règlement sur place, les cartes cadeaux au comptoir, les codes transactionnels, les métadonnées, sitemap/robots, pages privées et fichiers IA.

La campagne Supabase antérieure validait 72 contrôles, aucun échec et un contrôle de rappel non applicable à l’heure du passage. La base de vérification a été supprimée. Les modifications de cette passe sont vérifiées localement ; cela ne remplace pas un essai réel sur votre déploiement.

Non vérifiés depuis ce workspace : déploiement Vercel final, réception réelle chez Brevo/Meta/Twilio, indexation Google/Bing, positions locales, citations IA, mesures réseau publiques de PageSpeed et disponibilité du domaine. Aucun résultat de référencement n’est garanti.

Commandes reproductibles :

```bash
npm ci
npm run check
npm run audit:secrets
npm run e2e
npm run db:sql
npm run guide
```

`npm run verify` efface et reconstruit la base de test visée : ne jamais l’exécuter avec l’URL de production.


## 11. Correctif Vercel du 29/09 — ERR_MODULE_NOT_FOUND server/app.ts

**Symptôme exact :** `Cannot find module '/var/task/server/app.ts' imported from /var/task/api/index.js`.
Il s’agit d’un problème d’assemblage du serveur : l’entrée déployée cherchait une source TypeScript au lieu d’un module JavaScript livré dans la fonction. Cette erreur survient avant la connexion à Supabase et ne se corrige pas en rejouant le SQL.

### Correctif livré ensemble

- `api/index.ts` importe désormais `dist/server/app.cjs` à la demande.
- `scripts/build-server.mjs` compile le graphe serveur avec esbuild (y compris les imports internes dynamiques) et refuse tout import interne TypeScript restant.
- `package.json` ET `package-lock.json` déclarent esbuild comme dépendance de build et exécutent cette étape dans `build` et `build:strict`.
- `vercel.json` inclut `dist/**` et dirige toutes les routes, y compris `/api/public/*` et `/api/admin/*`, vers `/api/index`. Aucun cron Vercel réintroduit.
- Les cookies utilisent `setHeader('Set-Cookie', ...)`, disponible sur la réponse Node standard, et non `res.append()` d’Express.
- `.vercelignore` exclut les secrets locaux, le PDF privé, les bases locales et les fichiers de travail de l’envoi vers Vercel.
- `scripts/test-vercel-runtime.mjs` et `tsconfig.json` couvrent l’entrée API et la régression de packaging.

Importer les fichiers du correctif dans le dépôt connecté à Vercel **avec leurs dossiers**, puis créer un nouveau commit. Ne pas copier seulement `api/index.ts`. Conserver `npm run build` comme Build Command et `npm ci` comme Install Command. Vérifier Node.js 22.x et le commit du déploiement ; pour cette reconstruction, ne pas réutiliser le cache de build si Vercel propose cette option.

### Validation locale de cette passe

- `npm run typecheck` réussi.
- `npm run build:strict` : bundle serveur produit, aucun import interne `.ts` restant, 33 pages du jeu de démonstration pré-rendues.
- `npm run test:vercel` : **16/16 contrôles réussis**, dans un dossier ne contenant ni `server/` ni sources TypeScript, sous Node natif sans tsx. Healthz, HTML, CSS, config publique, login JSON, cookie, session owner, protection admin, SEO, cron refusé/autorisé, 404, manifeste, photo WebP, import de galerie et protection de l’offre waitlist sont contrôlés. Base mémoire isolée, aucune écriture sur Supabase.
- **136/136 tests**, **22/22 garanties smoke**, audit du site sans violation bloquante.

Ce test reproduit l’absence des sources dans l’artefact ; il ne constitue pas un déploiement Vercel réel. Après mise en ligne, vérifier `/healthz`, l’accueil et la connexion `/admin`. Si une nouvelle erreur apparaît, consulter sa nouvelle exception Runtime Logs : ne pas conclure que la base ou les variables sont forcément correctes à partir du seul correctif de packaging.


## 12. Google Maps, horaires et identité visuelle

**Fiche vérifiée :** https://www.google.com/maps?cid=14672622159112713981&hl=fr — BARBER SHOP Z.yass, 20 boulevard Roy, Les Pavillons-sous-Bois. Les boutons Maps utilisent ce CID ; le champ **Réglages → Marque → Google Maps** est désormais le même que celui lu par l’API. Un champ vide revient à la fiche réelle, pas à `#`.

**Google ne publie pas d’horaires sur cette fiche** au contrôle du 29/09/2026 (« Ajouter des horaires »). Il serait faux de parler d’import d’horaires Google. La référence disponible est Planity : **lundi–samedi 09:30–20:00, dimanche fermé**. Source : https://www.planity.com/zyass-barber-shop-93320-les-pavillons-sous-bois. Ces horaires restent à confirmer par le propriétaire. Les modifier dans **Réglages → Horaires**, puis mettre également à jour Google Business Profile : il n’existe pas de synchronisation automatique avec Google.

Correction d’affichage : le stockage utilise dimanche = 0 ; les pages affichent lundi en premier sans décaler les jours. Toutes les plages d’une journée sont affichées, y compris une coupure déjeuner. Le pied de page utilise aussi les données du salon.

Le logo sélectionné est dans `client/public/brand/logo-source.png`. Exports : `brand/logo.png`, `brand/favicon.svg`, `brand/favicon-32.png`, `/favicon.ico`, `brand/apple-touch-icon.png`, `/icon-192.png`, `/icon-512.png`. Ils sont déjà générés et doivent aller dans GitHub. `npm run icons` les régénère localement avec Python 3 + Pillow ; aucun outil graphique n’est requis pendant le build Vercel.

## 13. Cartes cadeaux : fonctionnement et intérêt pour le salon

### Ce que fait réellement le site

- **Pas de vente ni de débit en ligne** avec `PAYMENTS_PROVIDER=off`. La page publique explique l’achat au salon.
- L’équipe encaisse réellement entre **10 € et 500 €**, puis va dans **Marketing → Cartes cadeaux → Émettre après encaissement au salon**. Le logiciel enregistre cette déclaration d’encaissement, génère le code et active le solde.
- L’e-mail est destiné à **l’acheteur renseigné**, qui peut l’offrir ou le transférer. Le champ nom du bénéficiaire ne constitue pas une adresse d’envoi. Le code apparaît aussi dans l’admin. Brevo + ordonnanceur doivent être opérationnels pour livrer la file.
- Le client applique le code à la réservation. Le débit est transactionnel ; un échec de réservation ne consomme pas la carte. Le solde non utilisé reste disponible et une annulation recrédite la part utilisée. Les nouvelles cartes expirent après **365 jours** ; valider cette règle commerciale avant vente et l’annoncer clairement à l’acheteur.
- Une carte cadeau est **un moyen de paiement, pas une réduction du prix de la coupe**. Le prix de la prestation reste entier ; seul le reste à régler diminue. Le bouton « terminé » prend en compte la part déjà réglée par la carte. Correction vérifiée avec une carte partielle et une annulation.

### Ce que cela peut vous apporter — sans promesse de bénéfice

Exemple : une carte de 50 € est payée au salon. Le bénéficiaire réserve une prestation de 30 € : 30 € sont débités du solde, 20 € restent sur la carte et il ne paie rien pour ce rendez-vous. Une carte de 15 € sur une prestation de 25 € laisse 10 € à régler sur place.

Intérêt possible : trésorerie reçue avant la visite, découverte du salon par la personne qui reçoit le cadeau, retour pour utiliser le solde, dépenses complémentaires choisies librement. **Ce n’est pas 50 € de profit gratuit : vous devez encore fournir la prestation.** La marge dépend du temps, des charges et des produits utilisés. Ne pas additionner la vente de carte et la valeur de la prestation comme deux recettes économiques indépendantes ; les tableaux opérationnels ne remplacent pas une comptabilité. Faire valider le traitement TVA/comptable des bons par votre comptable.

## 14. Référence complète des variables

Le bloc de production du §3 contient les valeurs privées utiles au salon. La liste suivante reprend **toutes les options documentées**, y compris celles de développement et les fournisseurs non retenus : ne pas tout importer dans Vercel. Les commentaires de fin de ligne sont des explications, pas des valeurs à coller dans les champs Vercel.

@@ENVREF@@


## 15. Logs Vercel reçus le 29/09/2026 : diagnostic et état actuel

Fichier examiné : `coiffrr-67hy-log-export-2026-09-29T11-14-50.csv`. Il couvre **10:47:12 à 11:13:20 UTC**, soit **12:47:12 à 13:13:20 heure de Paris**. Les identifiants de déploiement et éventuels jetons dans des logs doivent rester privés : `uploads/` est exclu de Git et du bundle Vercel.

- **141 lignes**, représentant **137 requêtes distinctes** : 61 succès HTTP 200, 76 requêtes HTTP 500. Le CSV contient 80 lignes avec statut 500 car quatre messages d’erreur doublent leurs lignes de requête.
- Premier déploiement (`…gbbepl6wn…`) : 4 requêtes en échec et 4 messages `ERR_MODULE_NOT_FOUND`, import de `/var/task/server/app.ts`. Le correctif de compilation CJS et le test Node natif sont conservés. Ne pas revenir à l’import direct d’un fichier TypeScript en production.
- Déploiement suivant (`…isqaapq0q…`) : 72 erreurs sans message détaillé, sur la configuration, le manifeste, le SEO, la disponibilité et d’autres routes dépendantes du salon. Le CSV seul ne fournit pas une stack pour ces erreurs. Le contrôle séparé de la base avait montré l’absence de salon ; l’initialisation a corrigé ce blocage.
- **Contre-vérification HTTP après initialisation** sur `coiffrr-67hy.vercel.app` : `/healthz`, `/api/public/config`, `/manifest.webmanifest`, `/api/public/seo/home`, `/waitlist` et `/api/public/availability?days=3` répondent tous **200**. Le CSV est donc un historique antérieur à cette correction, pas la preuve que ces routes sont encore en 500.

Ces contrôles ne constituent pas une surveillance continue. Après le prochain déploiement, vérifier à nouveau ces routes, le commit réellement utilisé et les nouveaux logs. Un ancien déploiement immuable peut rester défectueux même si le domaine principal pointe sur un déploiement corrigé.

## 16. Liste d’attente — fonctionnement corrigé

### Avant publication du catalogue

`/waitlist` accepte une **demande générale** même sans prestation ni barbier actif. La page explique que le planning est en préparation : elle n’affirme pas « complet » et ne promet aucun créneau ni délai. Une panne de configuration affiche une erreur et un bouton Réessayer, pas un écran vide ni une fausse pénurie.

### Parcours du client

1. Le client choisit ses jours, sa plage horaire et sa flexibilité, puis donne son consentement de contact **non précoché**. L’e-mail est conseillé pour recevoir les propositions via Brevo. Les préférences de contact ne constituent pas un consentement marketing.
2. La demande est enregistrée ; un lien privé permet de la suivre et de se retirer. Avec un e-mail et le consentement, une confirmation transactionnelle est placée dans la file d’envoi. L’inscription n’est **pas** une réservation.
3. Si une demande existe déjà pour le numéro, aucune nouvelle ligne n’est créée, même lors de demandes simultanées. **Connaître un numéro ne permet pas de récupérer le lien privé existant** : le client utilise son précédent lien ou contacte le salon.
4. Une annulation peut déclencher une offre ; l’ordonnanceur recherche aussi la capacité disponible après ouverture des horaires/catalogue. Il faut un vrai service publié, un barbier actif, un créneau réellement disponible et une automatisation de rejeu active.
5. Une proposition réserve temporairement le créneau. Les jours, horaires et barbiers strictement demandés sont respectés ; une priorité manuelle ne contourne pas un refus de flexibilité. La position affichée reste indicative et dépend de la compatibilité.
6. Le client ouvre l’e-mail ou le suivi, lit le créneau et **clique sur “Confirmer ce rendez-vous”**. Ouvrir un lien seul ne réserve plus rien : un scanner de sécurité e-mail ne doit jamais créer un rendez-vous. Après confirmation, le lien de gestion fonctionne.
7. Un refus concerne seulement l’offre encore en attente. Un ancien lien de refus ne peut pas annuler un rendez-vous déjà confirmé. Un retrait libère les réserves temporaires, annule les messages encore en file et actualise l’écran ; une erreur réseau n’affiche pas un faux succès.
8. À expiration, l’offre passe à une autre demande compatible, sans boucler sur le même client pour ce même créneau. Un message d’offre déjà expirée n’est pas envoyé tardivement.

**Notifications :** Brevo utilise les mêmes variables qu’au §6. Les modèles comprennent maintenant l’inscription en liste d’attente et la proposition avec bouton de confirmation. La réception réelle reste à vérifier avec votre clé. `stdout` ne livre aucun message. Le cron externe reste nécessaire ; les heures calmes peuvent différer un SMS, et aucun SMS n’est livré sans fournisseur SMS configuré.

**Sécurité :** le client qui annule son propre RDV ne reçoit pas les liens privés des personnes en attente. Les confirmations concurrentes et les opérations retrait/refus/expiration sont contrôlées en transaction. Aucun nouveau schéma SQL ni tarif fictif n’est nécessaire pour ces changements.

## 17. Photo réelle importée de la fiche Google

Vous avez confirmé disposer des droits de republication et des autorisations nécessaires. **Une seule photo était récupérable dans l’affichage public limité de Google Maps** : la devanture du salon boulevard Roy. Les autres photos n’étaient pas exposées sans accès supplémentaire ; aucune photo d’intérieur, coupe ou barbe n’a été inventée pour remplir la galerie.

- Asset livré : `client/public/gallery/zyass-devanture-google.webp`, **1600 × 1108 px**, environ 303 Kio.
- Photo réelle convertie du JPEG en WebP, **sans recadrage, sans retouche du contenu et sans génération IA**.
- Fichier servi par votre site, pas de dépendance à un hotlink Google. Source, date, autorisation déclarée et empreinte du fichier : `docs/PROVENANCE-PHOTOS.json`.
- Galerie adaptée avec format paysage, texte alternatif, agrandissement et mention de provenance. Le bandeau “photos de démonstration” n’apparaît plus sur la galerie de production.
- L’import de la ligne `media` se fait **une seule fois au démarrage de production ou au pré-rendu live du nouveau code**. Un marqueur empêche la duplication et respecte une suppression ultérieure depuis l’admin.
- **À ce stade, le fichier et le correctif sont dans le projet ; ils attendent votre redéploiement.** Aucune ligne de galerie pointant vers un fichier absent n’a été ajoutée manuellement au site déjà en ligne depuis ce workspace.

Pour compléter la galerie, fournir les originaux autorisés des réalisations/intérieurs, ou un accès public effectivement consultable. La présence d’une photo sur Google ne remplace pas la vérification des droits.


### Bilan de validation de cette dernière passe

- `npm run check` **réussi** : TypeScript strict, **152/152 tests**, **22/22 smoke API**, build client/serveur, audit statique sans violation bloquante et **16/16 contrôles du runtime compilé Node natif**.
- **12/12 contrôles Chromium waitlist/galerie** : erreur réseau/réessai, formulaire à 320 px, consentement non précoché, inscription générale, retrait en échec puis réussi, photo locale et agrandissement, aperçu sans mutation, confirmation explicite, vrai lien de gestion, ancien refus sans effet sur un RDV confirmé et notification en file. Aucune exception JavaScript.
- **14/14 contrôles Chromium réservation/admin relancés** : catalogue vide, erreur/réessai, mobile, horaires/Maps, modèles inactifs, publication dans la base test seulement, vrais créneaux calculés, réservation complète sans paiement en ligne et logo/favicon.
- Tests réalisés **uniquement avec des bases en mémoire**, sans écrire de client, rendez-vous ou prestation active dans Supabase. Les notifications observées dans les tests ne prouvent pas une livraison réelle par Brevo.
- Six routes du domaine Vercel principal revérifiées HTTP **200** après ces tests. Aucune mise en ligne de cette nouvelle version n’a été effectuée depuis le workspace.

**Suite pratique :** envoyer le projet sur GitHub en respectant les exclusions privées, redéployer Vercel, vérifier la photo et `/waitlist`, puis configurer Brevo et le cron selon les chapitres précédents. Activer les prestations/équipe uniquement après validation de leurs informations réelles. Conserver ce PDF hors du dépôt.


## 18. Correctif des boutons d’accueil et imports JavaScript — 29/09/2026

### Deux incidents distincts, reproduits

1. **Clics de l’accueil :** le calque décoratif `.hero-bg` et son pseudo-élément se trouvaient au-dessus des liens. Le contrôle effectué sur le site en ligne donne `receivesClick: false`, intercepteur `hero-bg`, `pointer-events: auto`. Ce n’était pas une absence de lien. Le décor devient non interactif et reste sous le contenu, avec un ordre de superposition explicite.
2. **Chargement intermittent :** le CSS et la photo ont répondu **503** pendant un chargement réel de l’accueil. Le fichier `book-B_HemUlq.js` signalé par l’utilisateur répondait **200** lors d’un autre contrôle : un succès ponctuel n’exclut donc pas l’incident. Auparavant, toutes ces requêtes démarraient le backend et sa base avant de lire un fichier statique. L’exception précise du backend reste à identifier dans les logs de fonction si elle se reproduit ; elle ne doit plus empêcher de charger l’interface.

### Modifications livrées

- `server/static.ts` est compilé séparément dans `dist/server/static.cjs`. Ce bundle n’importe ni base de données, ni variables du backend, ni initialisation du salon. Le build contrôle cette séparation.
- `api/index.ts` sert les fichiers JS, CSS, images et les pages d’entrée avant de démarrer le backend. Si l’API est indisponible, les pages restent navigables et affichent une erreur métier lisible avec réessai/contact. Une réservation n’est jamais déclarée réussie sans validation serveur.
- HTML revalidé à chaque chargement, pas de copie CDN vieillissante ; les fichiers réellement présents avec nom haché restent en cache long. Un fichier absent renvoie un **vrai 404 texte, non cachable**, jamais une page HTML 200 mise en cache comme JavaScript. Les règles globales de cache des assets ont été retirées de `vercel.json` afin de ne pas appliquer un cache annuel aux erreurs.
- Échec d’import dynamique : un seul rechargement automatique autorisé par période de 60 secondes, sans perdre le chemin, les paramètres ou l’ancre. En cas d’échec persistant ou d’absence de stockage autorisé, l’écran d’erreur reste disponible, sans boucle infinie. Le bouton Réessayer recharge réellement le document ; simplement réarmer React ne suffisait pas car un import rejeté reste mémorisé.
- Une initialisation DB en échec peut être retentée : elle ne laisse plus une promesse rejetée bloquer toute la durée de vie d’une instance.
- Retrait du chiffre commercial non justifié « 8 % » de l’accueil et formulation adaptée au planning non publié. Aucun faux barbier ni prestation n’a été activé.

### Preuves et mise en ligne

- `npm run check` : **153/153 tests**, **22/22 smoke API**, **16/16 contrôles Node natif**, **38/38 contrôles statiques avec backend volontairement en panne**, TypeScript/build/audit statique réussis.
- `npm run test:navigation` : **12/12 contrôles Chromium sur les vrais fichiers compilés**. Clics non forcés depuis l’accueil vers réservation, waitlist, tarifs, FAQ, infos et galerie ; mobile 320 px ; simulation d’un module 503 puis rétabli ; module 404 persistant sans boucle ; vrai réessai après rétablissement ; erreur API lisible. Les anciens tests en serveur de développement ne suffisaient pas à couvrir cet incident.
- **Aucune écriture de test dans Supabase. Aucun déploiement effectué depuis le workspace.** Le contrôle du site en ligne, avant redéploiement du correctif, reproduisait encore le calque bloquant.

**À faire :** pousser le projet complet et redéployer Vercel avec `npm run build`, en conservant `includeFiles: dist/**`. Les deux bundles serveur sont générés automatiquement ; ne pas envoyer seulement un fichier JS ou changer son nom à la main. Aucun SQL supplémentaire, aucune réinitialisation de la base, aucun changement du mot de passe admin. Après déploiement, effectuer une fois un rechargement forcé du navigateur (Ctrl+Maj+R / Cmd+Maj+R), puis cliquer les deux boutons de la bannière d’accueil et ouvrir `/book`. Si l’API reste en 503, consulter les nouveaux logs `[vercel-runtime]` sans publier de secret.


## 19. Interface mobile façon application

### Navigation et parcours

Sur téléphone, quatre onglets fixes remplacent le menu horizontal : **Accueil**, **Réserver**, **Mes RDV**, **Le salon**. La destination active est indiquée visuellement et via `aria-current`. Toucher à nouveau un onglet déjà ouvert remonte en haut de sa page. L’interface desktop conserve son menu et son pied de page. L’administration garde sa propre navigation : les onglets clients n’y apparaissent pas.

- En-tête compact, accès direct au téléphone, retour contextuel sur les pages secondaires.
- Nouvelle page `/salon` : prestations, tarifs, galerie, horaires/accès, cartes cadeaux, FAQ, guides, liens légaux, réseaux sociaux configurés et espace salon. Ces fonctions ne disparaissent pas quand le pied de page desktop est masqué sur mobile.
- Réservation en trois étapes avec repères cliquables pour revenir en arrière. Choix du barbier dans une feuille basse ; créneaux calculés par le même backend, aucun créneau fictif.
- **Continuer** puis **Confirmer** restent au-dessus des onglets, sans les recouvrir. Le bouton de confirmation utilise le vrai formulaire et ses contrôles : prénom, téléphone et consentement. Lorsque le clavier réduit la fenêtre visible, les barres basses s’effacent et le bouton de formulaire reste dans le contenu défilable.
- « Mes RDV » conserve la connexion existante par code et rappelle que le lien reçu permet de gérer un rendez-vous sans connexion. Aucune inscription préalable obligatoire pour réserver.
- Modales rendues dans une couche indépendante, focus contenu dans le panneau, touche Échap et fermeture explicite, retour du focus à l’ouverture et arrière-plan inerte. Respect des préférences de mouvement réduit, champs à 16 px et cibles tactiles d’au moins 44 px.
- Zones de sécurité de l’iPhone prévues dans les barres et le contenu ; disposition conservée en paysage tactile, y compris 844×390. Aucun zoom utilisateur interdit.

### Installation sur iPhone

1. Après le redéploiement, ouvrir le site en HTTPS dans **Safari**.
2. Ouvrir **Partager**, puis **Sur l’écran d’accueil**. L’emplacement de ces options varie selon la version d’iOS.
3. Si proposé, activer **Ouvrir comme app web**, puis choisir **Ajouter**.
4. Ouvrir l’icône Z.YASS : le manifeste demande le mode autonome, avec démarrage à l’accueil. Les icônes Apple/PWA existantes sont conservées.

Un rappel de ces étapes est accessible depuis **Le salon → Z.YASS sur ton écran d’accueil**. Android propose son propre menu Installer/Ajouter à l’écran d’accueil. Il s’agit d’une **web app installable**, pas d’une application publiée sur l’App Store.

### Réseau et sécurité

Le service worker `client/public/sw.js` ne met **aucun JavaScript, HTML personnalisé, jeton ni réponse API en cache**. Il utilise le réseau et fournit uniquement un écran de repli si une navigation échoue faute de connexion, avec appel au salon et réessai. Les disponibilités, connexions et réservations nécessitent toujours le réseau ; aucune réservation hors connexion n’est annoncée. Cette stratégie évite de réintroduire les vieux modules mélangés entre déploiements.

L’inscription du service worker est réservée au build de production ; le serveur Vite de développement ne l’inscrit pas. Le manifeste inclut l’identité de l’app, sa portée et les raccourcis Réserver / Mes rendez-vous / Le salon.

### Validation et limites

- **26/26 contrôles du build compilé dans Chromium et WebKit**, en profils mobiles : les quatre onglets, tous les liens du salon, les panneaux et le focus, choix du barbier, position du bouton, réservation complète sans paiement, administration distincte, desktop, manifeste et écran hors connexion.
- Largeurs et orientations testées : **320×568, 390×844, 740×360 et 844×390**. Aucun débordement horizontal observé ni exception JavaScript.
- Le changement de hauteur du `visualViewport` dû au clavier a été simulé. **WebKit sur ordinateur n’est pas un iPhone physique** : la vérification finale du clavier iOS réel, des encoches et de l’installation doit se faire sur votre appareil après déploiement.
- Régression : 153 tests, 22 smoke API, 16 contrôles du runtime natif, 38 contrôles statiques avec backend en panne ; parcours waitlist/galerie et navigation vérifiés en navigateur. L’outillage Playwright a été mis à jour pour prendre en charge les moteurs de test sur Debian 13.
- Un test de déplacement utilisait une disponibilité de n’importe quel barbier alors que le déplacement conservait le barbier initial : fixture corrigée, sans modifier les règles du moteur. Les garde-fous responsive/audit vérifient maintenant le remplacement du menu par les onglets, au lieu d’interdire indistinctement tout masquage de menu.

**Publication :** pousser les sources et `package-lock.json`, puis redéployer Vercel. Pas de nouveau SQL, pas de changement des variables de production et pas de catalogue activé depuis ces tests. Vérifier sur iPhone Safari, puis depuis l’icône d’écran d’accueil. Le code est prêt dans le projet ; le workspace n’a pas effectué le déploiement.
