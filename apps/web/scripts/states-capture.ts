/**
 * FEN-268 (Lot 0) visual verification — renders the Arcade "planche d'états" to
 * a self-contained HTML preview WITHOUT a browser (none available here; same
 * pattern as state-capture.ts). It inlines the REAL design-system CSS
 * (tokens.css + components.css) and the REAL self-hosted fonts (base64), under
 * `data-direction="fun"`, so the file is a faithful, portable render of the
 * shared component library at desktop (1100) and mobile (390) widths.
 *
 * The markup uses the exact class names the React components emit (ui-btn,
 * ui-pill, ui-gauge, …) — the class→prop mapping itself is unit-tested in
 * variants.test.ts. So this artifact proves the VISUAL/token layer; the tests
 * prove the component contract.
 *
 * Run: node --experimental-transform-types scripts/states-capture.ts
 * Out: apps/web/artifacts/states-board-preview.html
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..");
const STYLES = join(WEB, "src", "ui", "styles");
const FONTS = join(WEB, "public", "fonts");
const OUT = join(WEB, "artifacts");

const tokens = readFileSync(join(STYLES, "tokens.css"), "utf8");
const components = readFileSync(join(STYLES, "components.css"), "utf8");

/** Inline the woff2 files as data: URIs so the artifact is one portable file. */
function fontsInline(): string {
  let css = readFileSync(join(STYLES, "fonts.css"), "utf8");
  const map: Record<string, string> = {
    "/fonts/inter-latin-variable.woff2": "inter-latin-variable.woff2",
    "/fonts/inter-latin-ext-variable.woff2": "inter-latin-ext-variable.woff2",
    "/fonts/press-start-2p-latin-400.woff2": "press-start-2p-latin-400.woff2",
  };
  for (const [url, file] of Object.entries(map)) {
    const b64 = readFileSync(join(FONTS, file)).toString("base64");
    css = css.replaceAll(
      `url("${url}")`,
      `url("data:font/woff2;base64,${b64}")`,
    );
  }
  return css;
}

const PALETTE = [
  ["#ffffff", "Blanc"],
  ["#18181c", "Noir"],
  ["#d6381f", "Rouge"],
  ["#f4a020", "Ambre"],
  ["#198547", "Vert"],
  ["#2563c9", "Bleu"],
  ["#9146ff", "Violet"],
  ["#90909a", "Gris"],
];
const PILLS: Array<[string, string, string]> = [
  ["open", "●", "Ouvert"],
  ["cooldown", "◷", "Recharge"],
  ["frozen", "❄", "Gelé"],
  ["ended", "■", "Terminé"],
  ["error", "⚠", "Erreur"],
];

const btn = (variant: string, size: string, label: string, extra = "") =>
  `<button class="ui-btn ui-btn--${variant} ui-btn--${size}" ${extra}>${label}</button>`;

const pill = ([s, icon, label]: [string, string, string]) =>
  `<span class="ui-pill ui-pill--${s}"><span class="ui-pill__icon" aria-hidden="true">${icon}</span>${label}</span>`;

const swatch = ([hex, label]: string[], selected: boolean) =>
  `<button class="ui-swatch"${selected ? ' data-selected="true"' : ""} style="background:${hex}" aria-label="${label}" title="${label}">${
    selected ? '<span class="ui-swatch__check" aria-hidden="true">✓</span>' : ""
  }</button>`;

const field = (label: string, inner: string, tail: string, state = "default") =>
  `<div class="ui-field" data-state="${state}"><label class="ui-field__label">${label}</label><div class="ui-field__control">${inner}</div>${tail}</div>`;

const toast = (kind: string, icon: string, title: string, msg: string) =>
  `<div class="ui-toast ui-toast--${kind}"><span class="ui-toast__icon" aria-hidden="true">${icon}</span><div class="ui-toast__body"><span class="ui-toast__title">${title}</span><span class="ui-toast__msg">${msg}</span></div></div>`;

const wordmark = (size: string) =>
  `<span class="ui-wordmark ui-wordmark--${size}"><span class="ui-wordmark__mark"></span><span>Live<span class="ui-wordmark__accent">Place</span></span></span>`;

const gaugeReady = () =>
  `<span class="ui-gauge"><span class="ui-gauge__segments">${[true, true, true, false, false, false]
    .map((f) => `<span class="ui-gauge__seg"${f ? ' data-filled="true"' : ""}></span>`)
    .join("")}</span><span class="ui-gauge__label">3/6 pixels</span></span>`;

const gaugeCooldown = () =>
  `<span class="ui-gauge"><span class="ui-gauge__ring" style="--_pct:60"></span><span class="ui-gauge__count tnum">5s</span><span class="ui-gauge__label">Prochain pixel</span></span>`;

const section = (title: string, body: string) =>
  `<section class="board-section"><h2 class="board-h2">${title}</h2><div class="ui-card"><div class="ui-row board-wrap">${body}</div></div></section>`;

function board(): string {
  return `
  <main class="ui-surface board">
    <header class="board-header">${wordmark("lg")}<p class="board-sub">Planche d'états · direction Arcade (FEN-268, Lot 0)</p></header>
    ${section(
      "Button — variants × sizes × états",
      `<div class="ui-stack">
        <div class="ui-row">${btn("primary", "sm", "Primaire sm")}${btn("primary", "md", "Primaire md")}${btn("primary", "lg", "Primaire lg")}</div>
        <div class="ui-row">${btn("secondary", "md", "Secondaire")}${btn("ghost", "md", "Fantôme")}${btn("primary", "md", "Désactivé", "disabled")}</div>
      </div>`,
    )}
    ${section(
      "Field — default · error · disabled",
      `<div class="ui-stack" style="min-width:280px">
        ${field("Pseudo", '<input class="ui-field__input" placeholder="ex. pixelpro" />', '<span class="ui-field__hint">Visible publiquement</span>')}
        ${field("Nom de fresque", '<input class="ui-field__input" value="Trop court" />', '<span class="ui-field__error" role="alert">3 caractères minimum.</span>', "error")}
        ${field("Identifiant", '<input class="ui-field__input" value="verrouillé" disabled />', "", "disabled")}
      </div>`,
    )}
    ${section("StatusPill — 5 états (icône + label)", PILLS.map(pill).join(""))}
    ${section("Gauge — ready · cooldown", `${gaugeReady()}${gaugeCooldown()}`)}
    ${section(
      "Toast — success · info · error",
      `<div class="ui-stack">${toast("success", "✓", "Pixel posé !", "Réserve −1.")}${toast("info", "i", "Fresque gelée", "Reprise dans 2 min.")}${toast("error", "!", "Pose refusée", "Cellule déjà prise.")}</div>`,
    )}
    ${section(
      "ColorSelector — palette (fidélité couleur)",
      `<div class="ui-swatches">${PALETTE.map((c, i) => swatch(c, i === 2)).join("")}</div>`,
    )}
    ${section(
      "Surfaces — vide · chargement",
      `<div class="ui-stack" style="min-width:240px"><div class="ui-skeleton" style="height:48px"></div><div class="ui-skeleton" style="height:48px;width:70%"></div></div>
       <div class="ui-empty"><strong>Aucune fresque</strong>Lancez votre première fresque pour démarrer.${btn("primary", "md", "Créer une fresque")}</div>`,
    )}
  </main>`;
}

const html = `<!doctype html>
<html lang="fr" data-direction="fun">
<head>
<meta charset="UTF-8" />
<title>LivePlace — Planche d'états Arcade (FEN-268)</title>
<style>
${fontsInline()}
${tokens}
${components}
.viewports { display:flex; gap:32px; flex-wrap:wrap; align-items:flex-start; padding:24px; background:#d9d9dd; }
.vp-desktop { width:1100px; }
.vp-mobile { width:390px; outline:8px solid #18181c; border-radius:24px; overflow:hidden; }
.vp-cap { font:600 13px/1.4 var(--font-sans); color:#3d3d45; margin:0 0 8px; }
.board { display:flex; flex-direction:column; gap:32px; padding:32px; }
.vp-mobile .board { padding:16px; gap:20px; }
.board-header { display:flex; flex-direction:column; gap:8px; }
.board-sub { color:var(--ui-text-secondary); margin:0; }
.board-section { display:flex; flex-direction:column; gap:12px; }
.board-h2 { font:700 18px/1.2 var(--font-sans); margin:0; }
.board-wrap { flex-wrap:wrap; gap:16px; align-items:flex-start; }
</style>
</head>
<body>
<div class="viewports">
  <div class="vp-desktop"><p class="vp-cap">Desktop · 1100</p>${board()}</div>
  <div class="vp-mobile"><p class="vp-cap" style="padding:8px 8px 0">Mobile · 390</p>${board()}</div>
</div>
</body>
</html>`;

mkdirSync(OUT, { recursive: true });
const dest = join(OUT, "states-board-preview.html");
writeFileSync(dest, html);
console.log(`wrote ${dest} (${(html.length / 1024).toFixed(0)} kB)`);
