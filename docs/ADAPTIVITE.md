# Adaptivité — mobile-first, tablette, grand bureau

Ce document décrit **comment** l'interface s'adapte, et surtout **comment c'est vérifié par des
machines** plutôt que déclaré. Un site « responsive » qui masque sa navigation sous 720 px ou qui
fait défiler toute la page à cause d'un tableau de planning n'est pas adaptatif : il est cassé sur
le canal qui apporte 80 % des réservations (téléphone, depuis Instagram).

## 1. La base est le petit écran, pas le grand

Le CSS est écrit **mobile-first** : les règles hors `@media` décrivent un téléphone de 320 px, et
chaque palier `min-width` *ajoute* de la place. Aucun palier ne retire une fonction.

| Palier | Ce qu'il ajoute |
| --- | --- |
| socle (jusqu'à 479 px) | 1 colonne ; navigation de l'en-tête en **rail horizontal scrollable** sous le logo ; tableaux dans `.tx` ; modale en **feuille saisissable** plaquée en bas ; back-office en barre horizontale |
| 480 px | galerie en tuiles plus larges |
| 560 px | pied de page sur 2 colonnes |
| 720 px | modale → boîte centrée, le « brise » de la feuille disparaît |
| 760 px | en-tête sur une seule ligne, navigation en ligne, `scroll-padding-top` réduit |
| 861 px | back-office : barre latérale de 208 px collante |
| 900 px | pages de réservation : colonne latérale sticky (récap) à côté du formulaire |
| 1120 px | pied de page 4 colonnes |
| 1440 px | conteneur porté à 1240 px, ligne de texte allongée — le texte ne court pas sur 1800 px |

Pourquoi 320 et pas 375 : c'est la largeur utile du plus petit téléphone encore en service (iPhone
SE 1re génération, petits Android). Un layout qui tient à 320 tient partout ; l'inverse casse.

Écrire en `min-width` n'est pas cosmétique : en `max-width`, le socle est la version *desktop* et
le mobile est une **soustraction** — c'est exactement comme ça que la navigation avait disparu du
téléphone (`@media (max-width:720px){.hd nav{display:none}}`, sans rien pour la remplacer).

## 2. Le pouce, l'encoche et la barre d'URL

- **`@media (pointer: coarse)`** : champs à **16 px minimum** (en dessous, iOS zoome sur le focus et
  casse la mise en page), cibles **≥ 44 px** (`.btn`, `.tab`, `.day`, `.slot`, liens de nav,
  `button.link`, `.logo`) — WCAG 2.5.8 niveau AAA. Les liens *dans* une phrase restent à la taille
  du texte : la spec les exonère, et le test les exclut aussi (les forcer à 44 px détruirait la
  typographie pour un gain nul).
- **`env(safe-area-inset-bottom)`** sur la barre basse de confirmation (`/book`), les toasts, la
  modale-feuille et le pied de page. Sans `viewport-fit=cover` (déjà présent) le `env()` ne sert à
  rien ; sans `env()`, `viewport-fit=cover` met le bouton « Confirmer » **sous** le geste de retour.
- **`100dvh` avec repli `100vh`** partout où la hauteur d'écran compte (`body`, back-office,
  plein écran de chargement) : sinon la barre d'URL mobile rogne le bas de la page.
- **`overflow-x: auto` + `overscroll-behavior-x: contain`** sur chaque rail (nav, jours, onglets,
  `.tx`) : faire défiler un rail ne fait plus bouger la page entière.
- **`@media (orientation: landscape) and (max-height: 540px)`** : téléphone couché, le hero se
  compacte (sinon rien n'est atteignable sans défiler).

## 3. Les tableaux du back-office

`table.t` fait 8 colonnes ; posé nu dans la page, il **forcing la largeur du body** et le téléphone
se met à défiler horizontalement tout entier. Chaque tableau est donc enveloppé :

```jsx
<div className="tx" tabIndex={0} role="region" aria-label="Tableau — défilement horizontal">
  <table className="t">…</table>
</div>
```

`.tx` défile localement, `overscroll-behavior-x: contain` protège la page, `tabIndex={0}` + `role`
permettent le défilement **au clavier** (un conteneur scrollable non focusable est inaccessible), et
la première colonne reste collante à gauche pour ne pas perdre la ligne des yeux. La saignée latérale
utilise la variable `--gutter` du conteneur (`--bleed: min(16px, var(--gutter,14px))`) — une saignée
en pixels fixes dépasse le padding du conteneur et redonne exactement le débordement qu'on
cherchait à supprimer (mesuré : +3 px sur `/infos` à 740 et 768 px).

Et deux règles qui ont failli passer, trouvées en capture d'écran puis mesurées :

- `table.t th, table.t td { overflow-wrap: anywhere }` — `anywhere` **réduit la largeur min-content**
  d'une cellule : le navigateur préfère casser un mot plutôt qu'élargir la colonne. À 900 px, les
  en-têtes tenaient sur une syllabe par ligne (« PR ES TA TI ON ») et les numéros de téléphone
  se coupaient en deux (« 06123456 / 78 »). Passé en `break-word`, il ne casse plus que ce qui ne
  tient réellement pas.
- `min-width: 520px` était trop juste pour cinq colonnes *plus* une colonne d'actions de quatre
  boutons : 720 px. Le tableau est alors coupé mais lisible, et `.tx` le fait défiler ; sous 760 px
  de conteneur, la colonne d'actions retrouve le droit de passer sur plusieurs lignes.

Le nombre de lignes **réellement rendues** se lit au `Range.getClientRects()` d'un nœud de texte (un
rectangle par ligne). Compter `hauteur ÷ line-height` sur un `<td>` est faux : la cellule prend la
hauteur de la ligne entière, et annonçait « 4 lignes » pour une cellule parfaitement nette — ce qui
avait fait croire, à tort, que le bureau était cassé lui aussi.

## 4. Le back-office raisonne sur sa colonne, pas sur la fenêtre

`.adm-main` déclare `container-type: inline-size`. Un panneau de 620 px dans un écran de 1440 px
(rez-de-chaussée normal quand la barre latérale est ouverte sur une tablette paysage) ne doit pas
étaler ses KPI sur 6 colonnes :

```css
@container adm (max-width: 620px) { .g2, .g3, .g4, .gal { grid-template-columns: 1fr } }
@container adm (min-width: 621px) and (max-width: 980px) { .g3, .g4 { grid-template-columns: repeat(2, 1fr) } }
```

Et toutes les grilles utilisent `minmax(min(255px, 100%), 1fr)` : une piste ne peut jamais être plus
large que le conteneur, donc jamais de débordement à 320 px. Les pistes `minmax(0, 1fr)`/`min-width: 0`
sur les enfants de grille et de flex règlent un cas concret mesuré : le rail des 14 jours de `/book`
faisait peser 1112 px sur une piste de grille et la page entière débordait de 752 px sur téléphone.

## 5. Les autres modes

| Média | Comportement |
| --- | --- |
| `prefers-reduced-motion: reduce` | animations neutralisées (`!important` assumé, c'est le seul endroit du site), `scroll-behavior: auto`, la feuille modale ne glisse plus |
| `forced-colors: active` | bordures reprises en `CanvasText`/`ButtonText` : les états « sélectionné » restent visibles en contraste forcé Windows |
| `print` | l'en-tête, le pied, les toasts, la barre basse et le hero sortent de l'impression ; cartes en noir sur blanc, `break-inside: avoid` ; les `.tx` ne coupent plus le récap d'un rendez-vous |
| `@supports not (position: sticky)` | la colonne collante des tableaux retombe en statique |

## 6. Ce qui est vérifié, et par quoi

1. **`tests/responsive.test.ts` — 13 tests** (sans navigateur, donc dans `npm test`) : viewport
   (aucun zoom bloqué), aucun masquage de navigation dans le socle ni dans une `max-width`, paliers
   en `min-width` majoritaires, aucune piste `minmax` non bornée, chaque `100vh` suivi de son
   `100dvh`, bloc `pointer: coarse` complet (44 px + 16 px), `safe-area` sur les barres fixes,
   modale en CSS et non en style en ligne (sinon `!important`), `@container`, les 18 tableaux
   enveloppés et atteignables au clavier, HTML livré avec la navigation complète, typo fluide,
   paysage/impression/contraste forcé.
2. **`scripts/audit-site.mjs`** relit le **site construit** : il refuse une navigation masquée par une
   media query, un viewport qui interdit le zoom, un tableau hors `.tx`, une page dont le HTML
   contient un octet de contrôle, une feuille de style référencée absente de `dist/assets`, et
   avertit sur tout `100vh` orphelin, `minmax(>200px)` non borné, `@media print`/`@container`/
   `orientation`/`forced-colors` manquants.
3. **`tests/e2e/responsive.spec.ts` — 8 tailles d'écran × 7 comportements**, dans un vrai navigateur :
   **aucun défilement horizontal de page** (mesuré élément par élément, en ignorant légitimement les
   enfants d'un conteneur défilant), navigation visible avec une boîte non nulle pour chaque lien,
   chaque `table.t` dans son `.tx` sans faire déborder la page, cibles tactiles (44 px commandes /
   24 px liens secondaires), champs ≥ 16 px en tactile, barre de confirmation dans le viewport,
   choix d'un créneau puis saisie, modale en feuille à 390 px et centrée à 1280 px, back-office en
   barre horizontale à 768 px et en colonne à 1180 px.

Tailles couvertes : 320×568, 360×740, 390×844, 740×360 (couché), 768×1024, 1024×768, 1280×900,
1920×1080 — plus les projets Playwright `mobile` (iPhone 13), `phone-se` (320, tactile),
`tablet-portrait` (834×1112), `tablet-landscape` (1180×820), `chrome`.

**Mesure sur cette machine** (démo locale, API + Vite) : `npm run e2e` → **89 tests passés, 0 échoué**
sur les 5 projets et les 3 fichiers de spec ; `npm test` → 84/84 ; `npm run smoke` → 22/22 ;
`bash scripts/smoke.sh` → 18/18 ; audit de site → aucune violation. Coût du couche adaptative :
CSS 18,0 ko brut / **4,4 ko brotli** (contre 12,2/3,1 avant), soit +1,3 ko transféré pour
l'ensemble des media queries, conteneurs, impressions et correctifs.

## 7. Limites assumées

- `isMobile`/`hasTouch` de Playwright émulent un pointeur grossier, pas un encoche réelle : les
  `env(safe-area-inset-*)` sont vérifiés à la source (audit + test unitaire), pas mesurés sur un
  iPhone physique. Un passage sur appareil réel reste utile avant l'ouverture au public.
- La matrice ne teste pas Firefox/Safari : les règles utilisées (`dvh`, `container`, `overscroll-behavior`,
  `text-wrap`) sont supportées par les versions en service, et chacune a un repli (déclaration
  `100vh` avant `100dvh`, `@supports` pour le sticky des tableaux).
- Le back-office n'a pas de mise en page « tablette » dédiée par panneau : il hérite des conteneurs.
  Si un panneau doit exister en deux colonnes fixes, c'est une règle `@container adm` à ajouter, pas
  une media query.
- Ce qui est mesuré est l'**horizontal** : 110 combinaisons page × taille (10 largeurs de 320 à 1920
  px sur les 11 URLs publiques) dans un vrai navigateur, plus les tableaux du back-office à 390, 900
  et 1280 px. Le « tient à l'écran sans défilement vertical » n'est pas une exigence et n'est donc pas
  chiffré ; il est vérifié visuellement sur les pages critiques (13 captures d'écran, de l'agenda à
  l'entrée en file).
- Le clavier logiciel qui remonte, le pouce réel, la barre de notation d'un navigateur : hors portée
  ici. La barre de confirmation collée en bas de page est, elle, mesurée dans le viewport (8 tailles).



## Interface app mobile

La navigation publique desktop est remplacée sur téléphone par quatre onglets persistants. Ce remplacement est intentionnel : les pages secondaires restent accessibles dans `/salon`. Le back-office conserve sa navigation. Les onglets et le CTA s’effacent seulement quand le clavier réduit le visualViewport ; les actions restent dans le formulaire.

`npm run test:mobile` teste le build compilé dans Chromium et WebKit, y compris les clics et la réservation. L’outil distingue cette alternative accessible d’un menu supprimé sans remplacement. Installation et limites : guide unique §19. WebKit simulé n’est pas une validation matérielle iPhone.
