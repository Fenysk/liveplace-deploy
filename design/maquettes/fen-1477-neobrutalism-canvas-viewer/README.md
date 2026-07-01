# FEN-1477 — Maquette Neobrutalism · canvas-viewer (écran pilote)

Premier livrable de la refonte UI Neobrutalism ([FEN-1469]). Écran pilote =
**canvas-viewer** (le plus dur). Restylage **visuel uniquement**, UX gelée
([FEN-83]). « Le canvas reste roi, le chrome devient Neobrutalism. »

## Fichier
- `index.html` — maquette **autonome** (fonts Inter + Press Start 2P embarquées
  en base64). Aucune dépendance réseau : un simple serveur statique suffit.
- `fonts/` — sources woff2 (déjà inlinées dans `index.html`, gardées pour la
  source).

## Servir en local (pour validation Alexis sur `test-liveplace.nas`)
Servir ce dossier en statique, p.ex. :
```
python3 -m http.server 8777   # puis http://localhost:8777/index.html
```
DevOps : exposer ce dossier derrière le domaine **`test-liveplace.nas`**
(pas Coolify / pas prod). C'est l'unique chemin de validation.

## Captures de référence
- Desktop 1440×900 + Mobile 390×844 — postées sur l'issue FEN-1477.

## Le système (ce que la maquette prouve)
Tout est piloté par des **tokens CSS** (le bloc `:root` dans `index.html`),
réutilisant les **noms réels** de `apps/web/src/ui/styles/tokens.css`. Le S0
(FEN-1450) avait neutralisé les valeurs décoratives en gardant les noms pour
réversibilité — cette maquette est exactement cette **réversion** en Neobrutalism.

| Axe | Décision Neobrutalism (token) |
|---|---|
| Radius | `--radius-* : 0` (déjà 0 depuis S0) — coins nets |
| Bordures | `--border-w: 2px`, `--border-w-strong: 3px`, couleur `--ink (#111114)` |
| Élévation | `--elev-1/2/3` = ombres **dures décalées, zéro flou** (`Npx Npx 0 0 ink`) |
| Motion | press/lift physique : `translate` + step d'ombre, `--ease-spring` ; variante `prefers-reduced-motion` |
| Type | corps `Inter` ; **display pixel `Press Start 2P`** (wordmark, jauge, compte à rebours) = identité LivePlace conservée |
| Accent | corail LivePlace `--accent #ff4d3d`, **discipliné** (CTA, jauge, célébration) — jamais collé à la fresque ; **texte noir** dessus (WCAG AA) |
| Cadre canvas | `--canvas-field/checker/grid/frame` **neutres, zéro teinte** → fidélité parfaite swatch ↔ pixel placé |

## Handoff dev (quand Alexis dit GO)
1. Recopier le bloc `:root` de la maquette dans `apps/web/src/ui/styles/tokens.css`
   (mêmes noms → le chrome `.lp-*` lit déjà `var(--…)`, AC6).
2. Réintroduire `--font-display` (Press Start 2P) et la face `Inter` dans
   `fonts.css` (assets déjà au repo : `apps/web/public/fonts/`).
3. Composants concernés (états déjà spécifiés visuellement ici) : `Button`
   (accent / ghost), `StatusPill`, `Gauge`/`HeroGauge`, `ColorSelector`
   (sélection = lift + cadre encre + badge coin, **indépendant de la couleur**),
   topbar, dock de pose, célébration.
4. **Aucun dev prod avant le GO d'Alexis.**

## Lenses appliquées
Aesthetic-Usability · Von Restorff (swatch sélectionné) · WCAG
contraste/indépendance-couleur (label texte + badge, jamais la couleur seule) ·
Selective Attention (chrome neutre, le canvas attire l'œil).

[FEN-1469]: /FEN/issues/FEN-1469
[FEN-83]: /FEN/issues/FEN-83
