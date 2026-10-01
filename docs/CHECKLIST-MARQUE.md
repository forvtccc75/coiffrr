# Marque — état au 29 septembre 2026

Le seul guide d’exploitation est **GUIDE-MISE-EN-LIGNE.md/PDF**. Ce fichier est un relevé des éléments visuels et commerciaux restant à valider.

| Élément | État | À faire |
|---|---|---|
| Logo / favicon / Apple / PWA | Monogramme choisi par le propriétaire, exports intégrés | Conserver `client/public/brand/logo-source.png` ; éventuelle validation juridique de marque |
| Images du salon et galerie | Une vraie photo de devanture Google autorisée, importée en production au prochain déploiement ; illustrations conservées dans la démo | Compléter avec les originaux autorisés des coupes et intérieurs ; provenance dans `PROVENANCE-PHOTOS.json`. Aucune illustration ne prouve un résultat réel |
| Avis | Aucun avis fabriqué à publier | Collecter de vrais avis avec les consentements adaptés ; ne pas figer une note Google variable |
| Google Maps | CID réel vérifié, boutons corrigés | Vérifier les informations dans Google Business Profile |
| Horaires | Planity : lun–sam 09:30–20:00, dimanche fermé | Confirmer ; Google ne publiait aucun horaire au contrôle du 29/09 |
| Prestations / équipe | 4 prestations modèles et 3 profils inactifs dans Supabase | Vrais noms, vrais prix/durées, activation explicite et horaires à valider |
| Courriel / réseaux / WhatsApp | À renseigner et confirmer | Réglages → Marque ; pas de domaine ni de compte externe inventé |
| Notifications | Brevo HTML + texte implémenté et testé en simulation | Clé API, expéditeur DNS vérifié, test réel, ordonnanceur pour les rappels |
| Paiement | Sur place, aucun Stripe pour ce salon | N’activer une carte cadeau qu’après encaissement réel |
| Propriétaire | Compte unique créé ; connexion Vercel testée | Mot de passe dans le PDF privé ; changer via Réglages → Sécurité après redéploiement |
| Mentions / TVA / médiation | Gabarits et identité légale connue | Relecture par le gérant et conseil compétent |
