/**
 * FEN-1497 — Studio surface (dashboard + create) Neobrutalism review shots.
 *
 * Renders the REAL committed CSS (tokens.css + components.css + studio.css) with
 * faithful DOM reconstructed from DashboardPage / StudioDashboardBody /
 * CreateCanvasPage so the UI Designer GO/NO-GO gate sees the actual visual
 * result at desktop 1440×900 + mobile 390×844.
 *
 * Usage: node shoot.mjs
 */
import { chromium } from "/tmp/pw/node_modules/playwright/index.mjs";
import { mkdir, readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "screenshots");
const REPO = "/paperclip/instances/default/projects/ec6c9c76-57ed-4476-bb8c-58a90776c95f/5fc73a29-d7f0-4499-91dc-4d495991323b/_default";
const WEB = join(REPO, "apps/web");

await mkdir(OUT, { recursive: true });

// Real CSS — inlined verbatim from the committed files.
const tokens = await readFile(join(WEB, "src/ui/styles/tokens.css"), "utf8");
const components = await readFile(join(WEB, "src/ui/styles/components.css"), "utf8");
const studio = await readFile(join(WEB, "src/features/streamer/studio.css"), "utf8");

// Embed Inter variable font as base64 so headless Chrome renders text.
const interB64 = (await readFile(join(WEB, "public/fonts/inter-latin-variable.woff2"))).toString("base64");
const FONT_FACE = `@font-face{font-family:"Inter";src:url("data:font/woff2;base64,${interB64}") format("woff2");font-weight:100 900;}`;

const RESET = `
  *{box-sizing:border-box;}
  html,body{margin:0;background:var(--ui-bg);}
  .ui-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);}
`;

const page = (inner) => `<!doctype html><html lang="fr"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>${FONT_FACE}${tokens}${components}${studio}${RESET}</style></head>
<body>${inner}</body></html>`;

/* ── shared fragments ─────────────────────────────────────────────────── */
const btn = (v, s, label) => `<button type="button" class="ui-btn ui-btn--${v} ui-btn--${s}">${label}</button>`;
const linkBtn = (v, s, label) => `<a href="#" class="ui-btn ui-btn--${v} ui-btn--${s}">${label}</a>`;

const switchOn = `<button type="button" role="switch" aria-checked="true" class="lp-switch lp-switch--on"><span class="lp-switch__track"><span class="lp-switch__thumb"></span></span></button>`;

const obsBlock = `
  <label class="lp-studio__field-label">URL de la source OBS</label>
  <div class="lp-studio__url-row">
    <input type="text" readonly value="https://liveplace.tv/obs/fresque-du-live" class="lp-studio__url-input"/>
    ${btn("primary", "md", "Copier")}
  </div>`;

const sizeGrid = `
  <div class="lp-studio__size-grid">
    <label class="lp-studio__size-option"><input type="radio" name="sz"/><span class="lp-studio__size-key">Petit</span></label>
    <label class="lp-studio__size-option"><input type="radio" name="sz" checked/><span class="lp-studio__size-key">Moyen</span></label>
    <label class="lp-studio__size-option"><input type="radio" name="sz"/><span class="lp-studio__size-key">Grand</span></label>
  </div>`;

const canvasList = `
  <div class="lp-studio__canvas-list">
    <div class="lp-studio__canvas-row lp-studio__canvas-row--active">
      <div class="lp-studio__canvas-info">
        <span class="lp-studio__canvas-name">Fresque du live</span>
        <span class="lp-studio__canvas-badge">Actif</span>
      </div>
    </div>
    <div class="lp-studio__canvas-row">
      <div class="lp-studio__canvas-info">
        <a href="#" class="lp-studio__canvas-name" style="text-decoration:none;color:inherit">Soirée rétro</a>
        <span class="lp-studio__muted--sm">Archivé le 12/06/2026</span>
      </div>
      ${btn("ghost", "sm", "Activer")}
    </div>
    <div class="lp-studio__canvas-row">
      <div class="lp-studio__canvas-info">
        <a href="#" class="lp-studio__canvas-name" style="text-decoration:none;color:inherit">Marathon 24h</a>
        <span class="lp-studio__muted--sm">Archivé le 03/05/2026</span>
      </div>
      ${btn("ghost", "sm", "Activer")}
    </div>
  </div>`;

const modsSection = `
  <section class="lp-studio__mods-section">
    <h2 class="lp-studio__section-title">Modérateurs</h2>
    <div class="lp-studio__mods-actions">${btn("secondary", "sm", "Resynchroniser")}</div>
    <ul class="lp-studio__mods-list" role="list">
      <li class="lp-studio__mod-row">
        <span class="lp-studio__mod-name">pixel_wizard</span>
        <span class="lp-studio__mod-badge lp-studio__mod-badge--yes"><span class="lp-studio__mod-dot" aria-hidden="true"></span>Inscrit</span>
      </li>
      <li class="lp-studio__mod-row">
        <span class="lp-studio__mod-name">carla_mod</span>
        <span class="lp-studio__mod-badge lp-studio__mod-badge--no"><span class="lp-studio__mod-dot" aria-hidden="true"></span>Non inscrit</span>
      </li>
    </ul>
  </section>`;

const crisisSection = `
  <section class="lp-studio__crisis-section">
    <h2 class="lp-studio__section-title">Gestion de crise</h2>
    <section class="lp-crisis" data-phase="open" aria-label="Placement ouvert">
      <p class="lp-crisis__status" role="status">Placement ouvert — le canvas accepte les pixels</p>
      ${btn("primary", "md", "Geler le canvas")}
      <p class="lp-crisis__hint" role="note">En cas de dérapage, gèle tout d'un geste. Tu pourras rouvrir ensuite.</p>
    </section>
  </section>`;

/* ── Surface 1: Dashboard (active canvas ready) ───────────────────────── */
const dashboardReady = `
<section class="lp-studio" aria-labelledby="h">
  <header class="lp-studio__header">
    <h1 id="h" class="lp-studio__title">Studio</h1>
    ${linkBtn("primary", "md", "+ Nouveau canvas")}
  </header>
  <form class="lp-studio__config-form">
    <section class="lp-studio__section">
      <div class="lp-studio__config-field">
        <label class="lp-studio__config-label" for="n">Nom du canvas</label>
        <input id="n" type="text" class="lp-studio__config-input" value="Fresque du live"/>
      </div>
      <div class="lp-studio__config-field">
        <span class="lp-studio__config-label">Visibilité</span>
        <div class="lp-studio__vis-row" role="group">
          <span class="lp-studio__vis-state">Privé</span>
          ${switchOn}
          <span class="lp-studio__vis-state--active">Public</span>
        </div>
      </div>
      ${obsBlock}
      <div class="lp-studio__actions">${btn("secondary", "md", "Ouvrir le canvas")}</div>
    </section>
    <section class="lp-studio__section">
      <h2 class="lp-studio__section-title">Paramètres</h2>
      <div class="lp-studio__config-field">
        <fieldset class="lp-studio__fieldset">
          <legend class="lp-studio__config-label">Taille</legend>
          ${sizeGrid}
        </fieldset>
      </div>
      <div class="lp-studio__config-field">
        <p class="lp-studio__config-label">Mes canvas</p>
        ${canvasList}
      </div>
    </section>
    <div class="lp-studio__save-row">${btn("primary", "md", "Sauvegarder")}</div>
  </form>
  ${modsSection}
  ${crisisSection}
</section>`;

/* ── Surface 2: Dashboard empty ───────────────────────────────────────── */
const dashboardEmpty = `
<section class="lp-studio" aria-labelledby="h2">
  <header class="lp-studio__header">
    <h1 id="h2" class="lp-studio__title">Studio</h1>
    ${linkBtn("primary", "md", "+ Nouveau canvas")}
  </header>
  <div class="ui-empty">
    <strong>Aucun canvas pour l'instant</strong>
    <span class="lp-studio__muted">Crée ton premier canvas et lance ta fresque collaborative en direct.</span>
    ${linkBtn("primary", "md", "Créer mon premier canvas")}
  </div>
</section>`;

/* ── Surface 3: Create form (default) ─────────────────────────────────── */
const createForm = (errored) => `
<section class="lp-studio lp-studio--narrow" aria-label="Créer un canvas">
  <h1 class="lp-studio__title">Créer un canvas</h1>
  <form class="lp-studio__form">
    <div class="ui-field" data-state="${errored ? "error" : "default"}">
      <label class="ui-field__label" for="cn">Nom du canvas</label>
      <div class="ui-field__control">
        <input id="cn" class="ui-field__input" ${errored ? 'aria-invalid="true"' : ""}
          value="${errored ? "Un nom beaucoup beaucoup beaucoup trop long pour ce canvas" : ""}"
          placeholder="Ma fresque du soir"/>
      </div>
      ${errored
        ? `<span class="ui-field__error" role="alert">Le nom est trop long (200 caractères max).</span>`
        : `<span class="ui-field__hint">Laisse vide pour un nom par défaut.</span>`}
    </div>
    <details class="lp-studio__details" open>
      <summary class="lp-studio__summary">Options</summary>
      <fieldset class="lp-studio__fieldset">
        <legend class="lp-studio__legend">Taille</legend>
        <label class="lp-studio__choice"><input type="radio" name="csz"/><span><strong>Petit</strong><span class="lp-studio__consequence"> — cosy, très lisible</span></span></label>
        <label class="lp-studio__choice"><input type="radio" name="csz" checked/><span><strong>Moyen</strong><span class="lp-studio__consequence"> — l'équilibre par défaut</span></span></label>
        <label class="lp-studio__choice"><input type="radio" name="csz"/><span><strong>Grand</strong><span class="lp-studio__consequence"> — plus de monde, moins lisible</span></span></label>
      </fieldset>
      <div class="lp-studio__field-row">
        <label class="lp-studio__field-label" for="pal">Palette</label>
        <select id="pal" class="lp-studio__select"><option>Palette par défaut</option></select>
      </div>
      <label class="lp-studio__choice"><input type="checkbox"/><span><strong>Public</strong><span class="lp-studio__consequence"> — visible dans la galerie</span></span></label>
    </details>
    <div class="lp-studio__form-actions">
      ${btn("primary", "md", "Créer")}
      <a href="#" class="lp-studio__link">Retour</a>
    </div>
  </form>
</section>`;

const SURFACES = [
  { name: "dashboard-ready", html: dashboardReady, full: true },
  { name: "dashboard-empty", html: dashboardEmpty, full: false },
  { name: "create-default", html: createForm(false), full: false },
  { name: "create-error", html: createForm(true), full: false },
];
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

const browser = await chromium.launch({
  executablePath: "/paperclip/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome",
  args: ["--no-sandbox", "--force-color-profile=srgb"],
});

// Fixed viewport height at context creation (NO mid-stream resize — resizing
// after setContent drops the embedded glyph atlas on tall pages in headless).
// fullPage:false captures exactly the viewport, which is sized to the content.
const HEIGHTS = { "dashboard-ready": { desktop: 1980, mobile: 2380 } };
for (const vp of VIEWPORTS) {
  for (const s of SURFACES) {
    const h = HEIGHTS[s.name]?.[vp.name] ?? vp.height;
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: h }, deviceScaleFactor: 2 });
    const pg = await ctx.newPage();
    await pg.setContent(page(s.html), { waitUntil: "domcontentloaded" });
    // Programmatic FontFace load — the CSS @font-face alone flakes to blank text
    // in headless (nondeterministic across contexts). Loading + adding the face
    // via the JS API and awaiting it makes glyph paint reliable.
    await pg.evaluate(async (b64) => {
      const f = new FontFace("Inter", `url(data:font/woff2;base64,${b64})`, { weight: "100 900" });
      await f.load();
      document.fonts.add(f);
      await document.fonts.ready;
    }, interB64);
    await pg.waitForTimeout(200);
    const out = join(OUT, `${s.name}-${vp.name}.png`);
    await pg.screenshot({ path: out, fullPage: false });
    console.log("wrote", out);
    await ctx.close();
  }
}
await browser.close();
console.log("done");
