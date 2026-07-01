/**
 * FEN-1500 — Error/empty/offline states Neobrutalism review shots.
 *
 * Renders StateScreen (notFound, error) + OfflineBanner at
 * 1440x900 (desktop) + 390x844 (mobile).
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

const tokens = await readFile(join(WEB, "src/ui/styles/tokens.css"), "utf8");
const components = await readFile(join(WEB, "src/ui/styles/components.css"), "utf8");

const interB64 = (await readFile(join(WEB, "public/fonts/inter-latin-variable.woff2"))).toString("base64");
const FONT_FACE = `@font-face{font-family:"Inter";src:url("data:font/woff2;base64,${interB64}") format("woff2");font-weight:100 900;}`;

const RESET = `*{box-sizing:border-box;}html,body{margin:0;font-family:var(--font-sans);}`;

const page = (inner) => `<!doctype html><html lang="fr"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>${FONT_FACE}${tokens}${components}${RESET}</style></head>
<body style="background:var(--ui-bg)">${inner}</body></html>`;

// Pixel art SVG (simplified — mimics StateArt "notFound" motif)
const pixelArt = `<svg width="80" height="80" viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="20" y="10" width="10" height="10" fill="var(--ink)"/>
  <rect x="50" y="10" width="10" height="10" fill="var(--ink)"/>
  <rect x="10" y="20" width="10" height="10" fill="var(--ink)"/>
  <rect x="60" y="20" width="10" height="10" fill="var(--ink)"/>
  <rect x="10" y="30" width="60" height="10" fill="var(--ink)"/>
  <rect x="10" y="40" width="10" height="10" fill="var(--ink)"/>
  <rect x="30" y="40" width="20" height="10" fill="var(--ink)"/>
  <rect x="60" y="40" width="10" height="10" fill="var(--ink)"/>
  <rect x="20" y="50" width="10" height="10" fill="var(--ink)"/>
  <rect x="50" y="50" width="10" height="10" fill="var(--ink)"/>
  <rect x="30" y="60" width="20" height="10" fill="var(--ink)"/>
</svg>`;

// StateScreen: not-found state
const stateNotFound = `
<section class="ui-state-screen" aria-labelledby="state-nf-title">
  <div class="ui-state-screen__card">
    <p class="ui-state-screen__kicker">Erreur 404</p>
    <div class="ui-state-screen__art" aria-hidden="true">${pixelArt}</div>
    <h1 id="state-nf-title" class="ui-state-screen__title">Page introuvable</h1>
    <p class="ui-state-screen__sub">Ce canvas n'existe pas ou a été supprimé.</p>
    <div class="ui-state-screen__actions">
      <a href="#" class="ui-btn ui-btn--primary ui-btn--md">Retour à l'accueil</a>
      <button type="button" class="ui-btn ui-btn--secondary ui-btn--md">Voir mes canvas</button>
    </div>
  </div>
</section>`;

// StateScreen: error state (red kicker)
const stateError = `
<section class="ui-state-screen ui-state-screen--error" aria-labelledby="state-err-title">
  <div class="ui-state-screen__card">
    <p class="ui-state-screen__kicker">Erreur</p>
    <div class="ui-state-screen__art" aria-hidden="true">${pixelArt}</div>
    <h1 id="state-err-title" class="ui-state-screen__title">Quelque chose s'est mal passé</h1>
    <p class="ui-state-screen__sub">Impossible de charger le canvas. Vérifiez votre connexion.</p>
    <div class="ui-state-screen__actions">
      <button type="button" class="ui-btn ui-btn--primary ui-btn--md">Réessayer</button>
      <a href="#" class="ui-btn ui-btn--secondary ui-btn--md">Retour</a>
    </div>
  </div>
</section>`;

// OfflineBanner: reconnecting state
const offlineReconnecting = `
<div class="ui-offline-banner-wrap">
  <div class="ui-offline-banner">
    <span class="ui-offline-banner__dot"></span>
    <span class="ui-offline-banner__msg">Reconnexion en cours…</span>
  </div>
</div>`;

// OfflineBanner: failed state
const offlineFailed = `
<div class="ui-offline-banner-wrap">
  <div class="ui-offline-banner ui-offline-banner--failed">
    <span class="ui-offline-banner__dot"></span>
    <span class="ui-offline-banner__msg ui-offline-banner__msg--failed">Connexion perdue</span>
    <button type="button" class="ui-offline-banner__reload">Recharger</button>
  </div>
</div>`;

const STATES = [
  { name: "state-not-found", html: stateNotFound },
  { name: "state-error", html: stateError },
  { name: "offline-reconnecting", html: offlineReconnecting },
  { name: "offline-failed", html: offlineFailed },
];

const VIEWPORTS = [
  { label: "desktop", w: 1440, h: 900 },
  { label: "mobile", w: 390, h: 844 },
];

const browser = await chromium.launch({
  executablePath: process.env.LP_CHROME || undefined,
  args: ["--no-sandbox", "--force-color-profile=srgb"],
});

for (const vp of VIEWPORTS) {
  for (const state of STATES) {
    const html = page(state.html);
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 2 });
    const pg = await ctx.newPage();
    await pg.setContent(html, { waitUntil: "domcontentloaded" });
    await pg.evaluate(async (b64) => {
      const f = new FontFace("Inter", `url(data:font/woff2;base64,${b64})`, { weight: "100 900" });
      await f.load();
      document.fonts.add(f);
      await document.fonts.ready;
    }, interB64);
    await pg.waitForTimeout(300);
    const fname = `${vp.label}-${state.name}.png`;
    await pg.screenshot({ path: join(OUT, fname), fullPage: true });
    await ctx.close();
    console.log(`✓ ${fname}`);
  }
}

await browser.close();
console.log("Done →", OUT);
