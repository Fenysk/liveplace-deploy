# LivePlace — Handoff Dev Frontend · Direction **Arcade** (retenue)

Direction retenue par Alexis au gate [FEN-196](/FEN/issues/FEN-196) : **Arcade (« Arcade Fun »)**.
Ce pack décline Arcade en système complet + écrans signature, prêt à coder.

- **Source maquettes** : `maquettes/` (React 18 + Vite 6 + Tailwind v4, tokens CSS). UI-only, fonts auto-hébergées.
- **Tokens** : `src/styles/tokens.css` (source de vérité) · export JSON `handoff/tokens.arcade.json`.
- **Direction active** : `data-direction="fun"` sur `<html>`.
- **SVG** : `handoff/svg/` (favicon, wordmark, twitch, star, lock).
- **Rendus réels** : `/tmp/arcade/*.png` (joints au ticket).

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

## 3. Composants (noms alignés sur le code)

`Button` (variants `primary`/`secondary`/`ghost`, sizes `sm`/`md`/`lg`, props `loading`/`disabled`/`icon`) ·
`Field` (states default/focus/erreur/désactivé, props `error`/`hint`/`prefix`) ·
`Toast` (kinds `success`/`info`/`error`) ·
`StatusPill` (states `open`/`cooldown`/`frozen`/`ended`/`error`) ·
`Gauge` (modes `ready`/`cooldown`) ·
`ColorSelector` (radiogroup, double-encodage anneau+check) ·
`Wordmark` · `FrescoCanvas` · `TwitchGlyph`.

Règle système : **une seule** implémentation par composant. Pas de variante « presque pareille ». Tout passe par tokens, jamais de valeur en dur.

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

## 8. Critères d'acceptation (handoff)

1. `data-direction="fun"` pilote 100% du look via tokens (aucune valeur en dur dans les composants).
2. Les 5 écrans signature rendent en mobile **et** desktop, fidèles aux captures jointes.
3. Tous les contrastes du §5 mesurés AA dans l'implémentation finale.
4. Focus visible au clavier sur chaque élément interactif ; cibles ≥44px sur tactile.
5. `prefers-reduced-motion` neutralise les animations sans perte d'information.
6. Vue OBS : fond réellement transparent + contour `--elev-obs` lisible sur fond clair, foncé et IRL.
7. Tokens consommés depuis `tokens.css` / `tokens.arcade.json` ; SVG depuis `handoff/svg/`.
