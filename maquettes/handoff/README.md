# LivePlace — Handoff Dev Frontend · Direction **Arcade** (retenue)

Direction retenue par Alexis au gate [FEN-196](/FEN/issues/FEN-196) : **Arcade (« Arcade Fun »)**.
Ce pack décline Arcade en système complet + écrans signature, prêt à coder.

- **Aperçu permanent (canonique)** : https://fenysk.github.io/liveplace-ui-preview/ (GitHub Pages, always-on — **pas** un tunnel, **pas** la prod). Build Pages = `vite build --base=/liveplace-ui-preview/` → publié par `scripts/publish-preview-pages.mjs` (rail DevOps, FEN-195).
- **Source maquettes** : `maquettes/` (React 18 + Vite 6 + Tailwind v4, tokens CSS), branche `fen-196-ui-maquettes`. UI-only, fonts auto-hébergées.
- **Tokens** : `src/styles/tokens.css` (source de vérité) · export JSON `handoff/tokens.arcade.json`.
- **Direction active** : `data-direction="fun"` sur `<html>`.
- **SVG** : `handoff/svg/` (favicon, wordmark, twitch, star, lock).
- **Rendus réels** : captures 1440×900 + 390×844 jointes au ticket [FEN-204](/FEN/issues/FEN-204).

---

## 1. Identité Arcade

| Rôle | Token | Valeur | Note |
|---|---|---|---|
| Accent (boutons, fills) | `--accent` | `#d6381f` | coral AA — texte blanc 4.7:1 |
| Accent hover / active | `--accent-hover` / `--accent-active` | `#c0331b` / `#a82d18` | |
| Accent **texte** sur clair | `--accent-text` | `#bd3221` | coral lisible (AA 4.5:1+) |
| Coral « show » (déco only) | `--accent-show` | `#ef4d3a` | marques/confetti — **jamais en texte** |
| Accent secondaire (ambre) | `--accent-2` | `#f4a020` | points, célébration (déco) |
| Focus ring | `--accent-ring` | `#d6381f` | indicateur focus ≥3:1 |
| Twitch (brand-lock) | — | `#9146FF` | imposé par Twitch, hors tokens |
| Police display | `--font-display` | Press Start 2P | **wordmark + titre de célébration uniquement** |
| Police corps | `--font-sans` | Inter | tout le reste |
| Rayon contrôle / carte | `--da-radius-control` / `--da-radius-card` | 4px / 6px | coins carrés = feel pixel |
| Motion scale | `--da-motion-scale` | 1.15 | feedback un peu plus joueur |

Le « fun » vit dans le **feedback** (place-pop, confetti, micro-spring), pas dans le bruit visuel : le canvas reste roi, le chrome reste neutre.

---

## 2. Écrans signature livrés (mobile 390 + desktop 1440, rendu réel)

| Écran | Composant | Rôle |
|---|---|---|
| Canvas viewer | `components/CanvasViewer.jsx` | écran roi, pose de pixel (états prêt/cooldown/gelé) |
| Onboarding + Twitch | `screens/Onboarding.jsx` | 1 promesse, 1 CTA (connexion Twitch) |
| Dashboard créateur | `screens/Dashboard.jsx` | stats live + création/config de fresque + lien OBS |
| Moment de célébration | `screens/Celebration.jsx` | délice Kano : confetti + pixel-pop + titre Press Start |
| Vue OBS | `screens/ObsView.jsx` | source transparente, contour `--elev-obs`, survit compression |
| Planche d'états | `screens/StatesBoard.jsx` | référence exhaustive des états (voir §4) |

---

## 3. Inventaire de composants réutilisables (forme imposée par Alexis — FEN-187)

**Règle d'architecture (condition de passation) :** le dev est structuré en **composants réutilisables**, pas en écrans monolithiques. **Un composant = une seule définition** couvrant tous ses états/variants. Aucune valeur en dur : couleurs/typo/espacements/rayons/motion viennent **exclusivement des tokens**. Un écran = une **composition** de ces composants (cf. §3.2), jamais une réimplémentation locale.

### 3.1 Atomes / molécules (réutilisables)

| Composant | Fichier | Props | Variants | États | Tokens consommés (source unique) |
|---|---|---|---|---|---|
| **Button** | `components/ui/Button.jsx` | `variant`, `size`, `loading`, `disabled`, `icon`, `children` | `primary` · `secondary` · `ghost` ; tailles `sm`/`md`/`lg` | default · hover · focus-visible · active · `loading` (spinner) · `disabled` | `--accent`/`-hover`/`-active`, `--accent-onAccent`, `--ui-surface`, `--ui-border-strong`, `--da-radius-control`, `--da-elev-control`, `--focus-ring`, `--dur-fast`/`--ease-out` |
| **Field** | `components/ui/Field.jsx` | `label`, `value`, `placeholder`, `hint`, `error`, `disabled`, `type`, `prefix`, `state` | input texte (extensible number/email via `type`) | default · `focus` · erreur (`error`) · `disabled` | `--ui-surface-raised`, `--ui-border-strong`, `--accent-ring`, `--status-error-fg`, `--da-radius-control`, `--text-base`, `--ui-text*` |
| **Toast** | `components/ui/Toast.jsx` | `kind`, `title`, `children` | — | `success` · `info` · `error` | `--status-*-fg/bg`, `--ui-surface-raised`, `--ui-border`, `--da-radius-card`, `--elev-3` |
| **StatusPill** | `components/StatusPill.jsx` | `state`, `label` | — | `open` · `cooldown` · `frozen` · `ended` · `error` (icône + label, jamais couleur seule) | `--status-*-fg/bg`, `--radius-pill`, `--text-xs` |
| **Gauge** | `components/Gauge.jsx` | `mode`, `ready`, `max`, `seconds`, `nextLabel` | `ready` (réserve segmentée) · `cooldown` (anneau + compte à rebours tnum) | reflète l'état de pose | `--accent`, `--accent-soft`, `--status-cooldown-fg`, `--radius-md`, `--ui-text`, `.tnum` |
| **ColorSelector** | `components/ColorSelector.jsx` | `value`, `onChange`, `compact` | grille standard / `compact` | par swatch : default · selected (anneau + check + label, lisible N&B) · active | `--radius-sm`, `--select-ring`, `--ui-surface`, palette `data/fresco.js` (hex exacts, **aucune teinte/opacité** — fidélité couleur) |
| **Wordmark** | `components/Wordmark.jsx` | `size` (`sm`/`md`/`lg`) | — | — | `--accent`, `--accent-onAccent`, `--font-display` (Press Start 2P en Arcade) |
| **TwitchGlyph** | `components/ui/TwitchGlyph.jsx` | `size`, `className` | — | hérite `currentColor` | — (SVG mono, recolorable) |
| **FrescoCanvas** | `components/FrescoCanvas.jsx` | `cell`, `reticle`, `placedFx` | — | rendu fresque + réticule + place-pop | `--canvas-field`/`-checker`/`-grid`/`-frame`, `.lp-pop`/`.lp-ping` |

### 3.2 Compositions d'écran (assemblent les atomes, non réutilisables tels quels)

| Écran | Fichier | Réutilise |
|---|---|---|
| Canvas viewer | `components/CanvasViewer.jsx` | Wordmark, StatusPill, Gauge, ColorSelector, Button, FrescoCanvas |
| Onboarding + Twitch | `screens/Onboarding.jsx` | Wordmark, Button (+ TwitchGlyph), FrescoCanvas |
| Dashboard créateur | `screens/Dashboard.jsx` | Wordmark, StatusPill, Field, Button |
| Célébration | `screens/Celebration.jsx` | Wordmark, Button, FrescoCanvas (+ confetti tokenisé) |
| Vue OBS | `screens/ObsView.jsx` | FrescoCanvas (+ `--elev-obs`) |
| Planche d'états | `screens/StatesBoard.jsx` | tous les atomes ci-dessus (référence vivante) |

**Règle système :** **une seule** implémentation par composant. Pas de variante « presque pareille » — étendre via props/variants existants. Tout passe par tokens, jamais de valeur en dur.

---

## 4. Planche d'états (exhaustive)

- **Champs** : default · focus (anneau coral) · erreur (bord rouge + `!` + message) · désactivé (opacity .5).
- **Boutons** : primary/secondary/ghost · loading (spinner) · disabled · sm/md/lg.
- **Pills** : open · cooldown · frozen · ended · error (icône + label, jamais couleur seule).
- **Jauge** : ready (réserve segmentée) · cooldown (anneau drainant + compte à rebours tnum).
- **Toasts** : success · info · error.
- **Modale** : destructive (Réinitialiser la fresque).
- **Surfaces** : vide (CTA d'amorçage) · chargement (skeleton pulsé) · erreur (réessayer).

---

## 5. A11y chiffrée (contrastes WCAG mesurés — AA)

| Paire | Ratio | Seuil | Verdict |
|---|---|---|---|
| Texte principal `#18181c` / ui-bg `#e7e7ea` | 14.34 | 4.5 | ✓ |
| Texte secondaire `#52525b` / blanc | 7.73 | 4.5 | ✓ |
| Texte tertiaire `#6c6c76` / blanc | 5.19 | 4.5 | ✓ |
| Blanc / **bouton accent `#d6381f`** | 4.72 | 4.5 | ✓ |
| `accent-text #bd3221` / ui-bg `#e7e7ea` | 4.67 | 4.5 | ✓ |
| Pill open `#198547` / `#dcf3e4` | 4.01 | 3.0 | ✓ |
| Pill cooldown `#b06f00` / `#fbeccb` | 3.51 | 3.0 | ✓ |
| Pill frozen `#2563c9` / `#dde9fb` | 4.62 | 3.0 | ✓ |
| Pill error `#c2371d` / `#fbe3dd` | 4.44 | 3.0 | ✓ |
| Erreur champ `#c2371d` / blanc | 5.44 | 4.5 | ✓ |
| Blanc / Twitch `#9146FF` | 4.64 | 3.0 | ✓ |
| Focus ring `#d6381f` / ui-bg | 3.83 | 3.0 | ✓ |

**Toutes paires AA.** Autres garanties :
- **Focus visible** partout (`:focus-visible` → `--focus-ring`, anneau 2px AA).
- **Indépendance couleur** (daltonisme / N&B) : chaque état porte **icône + label + forme**, jamais la teinte seule (pills, sélection de couleur, erreurs). Vérifié en niveaux de gris.
- **Cibles ≥44px** : `Button` md/lg ≥44/48px, `Field` ≥44px, swatches ≥36px touch.
- **Texte ≥12px** plancher.

---

## 6. Motion + reduced-motion

| Token | Valeur | Usage |
|---|---|---|
| `--dur-instant/fast/base/slow` | 90 / 150 / 220 / 320 ms | bande de feedback 100–300ms |
| `--ease-out` | `cubic-bezier(.22,.78,.27,1)` | entrées |
| `--ease-spring` | `cubic-bezier(.2,1.3,.4,1)` | place-pop (le délice) |
| `--da-motion-scale` | 1.15 (Arcade) | multiplicateur d'intensité |

Animations signature : `lp-place-pop` (pose), `lp-ring-ping`, `lp-confetti-fall` (célébration), `lp-pulse-soft` (cooldown/skeleton).
**`prefers-reduced-motion: reduce`** → `--da-motion-scale: 0` + neutralisation globale des durées : confetti/pop/ping coupés, **l'état reste lisible** (compte à rebours numérique, pas d'info portée par la seule animation).

---

## 7. Do / Don't (règles d'extrapolation)

**DO**
- Tout nouvel écran : chrome neutre, **canvas/contenu roi**, un seul accent coral par zone d'action.
- Coral en **aplat** sous texte blanc (`--accent`) ; coral en **texte** → `--accent-text`.
- Press Start 2P **uniquement** wordmark + gros titre de moment ; corps en Inter.
- Tout état porte icône + label (lisible en N&B).
- Rayons : `--da-radius-control/card` (coins carrés Arcade), jamais une valeur arbitraire.

**DON'T**
- ❌ Press Start 2P en corps de texte (illisible + perf).
- ❌ `#ef4d3a` (coral show) en texte ou petit label → échoue AA ; réservé au décor.
- ❌ Teinter/opacifier les pixels du canvas (fidélité couleur §5.1).
- ❌ État signifié par la couleur seule.
- ❌ Empiler les accents (2+ corals concurrents dans une même zone).
- ❌ Animer une info critique sans équivalent statique.

---

## 8. Critères d'acceptation côté dev (« réutilise composant X, tokens Y »)

Forme imposée par Alexis : chaque critère pointe un **composant réutilisable** + ses **tokens**, pas une description libre.

| # | Critère (vérifiable) |
|---|---|
| AC1 | **Architecture composants** : chaque atome du §3.1 existe en **une seule** définition couvrant tous ses états/variants ; les écrans du §3.2 les **importent** (zéro réimplémentation locale, zéro variante « presque pareille »). |
| AC2 | **CTA / actions** : tout bouton = `Button` (`variant`+`size`), jamais un `<button>` stylé à la main. Primaire sous texte blanc = `--accent` ; focus = `--focus-ring`. |
| AC3 | **Saisies** : tout champ = `Field`, états `error`/`disabled`/focus via props/tokens (`--accent-ring`, `--status-error-fg`) — pas de bordure en dur. |
| AC4 | **État de canvas** = `StatusPill` (5 états) + `Gauge` (`ready`/`cooldown`) ; icône+label obligatoires (lisible N&B), `--status-*` tokens. |
| AC5 | **Couleurs de pose** = `ColorSelector` ; swatch = hex exact de la palette, **aucune teinte/opacité** (fidélité couleur). |
| AC6 | **Tokens = source unique** : aucune couleur/typo/espacement/rayon/durée en dur ; tout vient de `tokens.css` / `tokens.arcade.json`. `data-direction="fun"` pilote 100% du look. Coral-texte = `--accent-text`, jamais `#ef4d3a`. |
| AC7 | **A11y** : contrastes §5 AA dans l'implémentation finale ; focus visible clavier partout ; cibles ≥44px (Button md/lg, Field). |
| AC8 | **Motion** : durées/courbes via tokens `--dur-*`/`--ease-*` ; `prefers-reduced-motion` neutralise sans perte d'info. |
| AC9 | **Vue OBS** : `ObsView` rend un fond réellement transparent + contour `--elev-obs` lisible sur fond clair/foncé/IRL. |
| AC10 | **Rendu réel** : les 6 surfaces rendent en **1440×900** et **390×844**, fidèles aux captures jointes. |
| AC11 | **Assets** : wordmark/favicon/icônes depuis `handoff/svg/` ; police display (Press Start 2P) **uniquement** wordmark + titre de moment. |
