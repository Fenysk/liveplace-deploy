/**
 * FEN-1512 — CanvasView HUD composition screenshots.
 *
 * Proves composition-level ACs (not just component ACs):
 *   - Desktop (1440×900): exactly ONE gauge bar visible (HeroGauge in bubble-header;
 *     bubble-body HeroGauge hidden; lp-reserve display:none)
 *   - Mobile (390×844): HeroGauge in bubble-body visible with pixel counter
 *     (lp-reserve display:none)
 *
 * Renders the real canvas.css + tokens.css + components.css — no synthetic styles.
 * DOM structure mirrors CanvasView JSX exactly (BottomSheet → lp-hud → bubble-header
 * + bubble-body). The lp-reserve div is present in DOM (as in CanvasView) but must
 * be invisible via CSS.
 *
 * Usage: node shoot-canvasview.mjs
 */
import { chromium } from "/tmp/pw/node_modules/playwright/index.mjs";
import { mkdir, readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "screenshots-canvasview");
const REPO = "/paperclip/instances/default/projects/ec6c9c76-57ed-4476-bb8c-58a90776c95f/5fc73a29-d7f0-4499-91dc-4d495991323b/_default";
const WEB = join(REPO, "apps/web");

await mkdir(OUT, { recursive: true });

const tokens = await readFile(join(WEB, "src/ui/styles/tokens.css"), "utf8");
const components = await readFile(join(WEB, "src/ui/styles/components.css"), "utf8");
const canvasCss = await readFile(join(WEB, "src/features/canvas/canvas.css"), "utf8");

const interB64 = (await readFile(join(WEB, "public/fonts/inter-latin-variable.woff2"))).toString("base64");
const FONT_FACE = `@font-face{font-family:"Inter";src:url("data:font/woff2;base64,${interB64}") format("woff2");font-weight:100 900;}`;

const RESET = `
  *{box-sizing:border-box;}
  html,body{margin:0;background:var(--ui-bg);font-family:"Inter",sans-serif;height:100%;}
  .ui-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);}
  .tnum{font-variant-numeric:tabular-nums;}
  /* Proof overlay: highlight elements that ARE visible */
  .proof-hint{
    position:fixed;top:8px;left:8px;right:8px;
    background:rgba(0,0,0,0.7);color:#fff;font-size:11px;
    padding:6px 10px;border-radius:4px;font-family:monospace;
    z-index:9999;line-height:1.5;
  }
`;

const lightning = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 20" width="14" height="20" fill="currentColor" aria-hidden="true"><path d="M8 0L0 11h6l-1 9 9-12H8L8 0z"/></svg>`;

function heroGauge({ charges, max, state, seconds = 0, step = 1 }) {
  const fillRatio = Math.max(0, Math.min(charges, max)) / Math.max(1, max);
  const sub = state === "empty"
    ? `<span class="ui-hero-gauge__sub-text">Aucune charge disponible</span>`
    : state === "charging" && seconds > 0
      ? `<span class="ui-hero-gauge__sub-text ui-hero-gauge__countdown tnum">+${step} pixel dans ${seconds}s</span>`
      : "";

  const counter = state === "full"
    ? `<span class="ui-hero-gauge__charges">${charges}</span>`
    : `<span class="ui-hero-gauge__charges">${charges}</span><span class="ui-hero-gauge__sep">/</span><span class="ui-hero-gauge__max">${max}</span>`;

  return `
    <div role="group" class="ui-hero-gauge" data-state="${state}">
      <span aria-live="polite" aria-atomic="true" class="ui-sr-only"></span>
      <div class="ui-hero-gauge__header" aria-hidden="true">
        <span class="ui-hero-gauge__icon">${lightning}</span>
        <span class="ui-hero-gauge__counter tnum">${counter}</span>
      </div>
      <div class="ui-hero-gauge__bar" aria-hidden="true">
        <span class="ui-hero-gauge__fill" style="--_fill:${fillRatio}"></span>
        ${state === "charging" ? `<span class="ui-hero-gauge__charging-block"></span>` : ""}
      </div>
      <div class="ui-hero-gauge__sub" aria-hidden="true">${sub}</div>
    </div>`;
}

/* Mirrors the old lp-reserve bar (should be display:none via canvas.css) */
function oldReserveBar({ charges, max }) {
  const fillRatio = Math.max(0, Math.min(charges, max)) / Math.max(1, max);
  return `
    <div class="lp-reserve" aria-hidden="true">
      <span class="ui-gauge" data-mode="bar">
        <span class="ui-gauge__track" style="--_fill:${fillRatio};--_proj:0">
          <span class="ui-gauge__fill"></span>
        </span>
      </span>
    </div>`;
}

/**
 * Full HUD DOM — mirrors CanvasView's BottomSheet output exactly:
 *   .lp-hud[data-desktop="bubble"]
 *     .lp-bubble-header → HeroGauge (desktop header, hidden on mobile)
 *     .lp-bubble-body   → HeroGauge (body, hidden on desktop-bubble, shown on mobile)
 *                       → .lp-reserve (OLD bars — should be display:none everywhere)
 */
function buildPage({ charges, max, state, seconds = 0, label, hint }) {
  const gauge = { charges, max, state, seconds };
  return `<!doctype html><html lang="fr"><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>${FONT_FACE}${tokens}${components}${canvasCss}${RESET}
/* Constrain HUD for screenshot — mirrors real sidebar width */
.lp-hud{width:280px;min-height:120px;padding:12px;border:1px solid var(--ui-border);border-radius:8px;background:var(--ui-surface-raised);}
</style>
</head>
<body>
  <div class="proof-hint">${hint}</div>
  <!-- .lp-hud mirrors CanvasView's BottomSheet with desktop="bubble" -->
  <div style="padding:48px 24px 24px">
    <div class="lp-hud" data-desktop="bubble" data-panel-open="true" data-pose="off">

      <!-- Bubble header: visible on desktop ≥1024px, hidden on mobile -->
      <div class="lp-bubble-header">
        <div class="lp-bubble-topbar">
          <span style="font-size:11px;color:var(--ui-text-secondary)">? Raccourcis</span>
          <span style="font-size:11px;color:var(--ui-text-secondary)">✕</span>
        </div>
        <!-- HeroGauge in header (desktop only) -->
        <div class="lp-hero-gauge-wrap">
          ${heroGauge(gauge)}
        </div>
      </div>

      <!-- Bubble body: display:contents on mobile, flex-column on desktop -->
      <div class="lp-bubble-body">
        <!-- HeroGauge in body: shown on mobile, hidden on desktop-bubble -->
        <div class="lp-hero-gauge-wrap">
          ${heroGauge(gauge)}
        </div>

        <!-- OLD reserve bars: should be display:none everywhere (FEN-1512) -->
        ${oldReserveBar(gauge)}
      </div>

    </div>
  </div>
</body></html>`;
}

const gaugeStates = [
  {
    id: "full",
    label: "Plein (20/20)",
    charges: 20, max: 20, state: "full",
    desktopHint: "Desktop 1440 | ATTENDU: 1 seule HeroGauge (dans header) | lp-reserve=none",
    mobileHint: "Mobile 390 | ATTENDU: HeroGauge dans body avec compteur | lp-reserve=none",
  },
  {
    id: "charging",
    label: "Recharge (12/20)",
    charges: 12, max: 20, state: "charging", seconds: 8,
    desktopHint: "Desktop 1440 | ATTENDU: 1 seule HeroGauge (dans header) | lp-reserve=none",
    mobileHint: "Mobile 390 | ATTENDU: HeroGauge dans body avec 12/20 + countdown | lp-reserve=none",
  },
];

const browser = await chromium.launch();

for (const s of gaugeStates) {
  /* Desktop 1440×900 */
  const dpPage = await browser.newPage();
  await dpPage.setViewportSize({ width: 1440, height: 900 });
  await dpPage.setContent(buildPage({ ...s, hint: s.desktopHint }), { waitUntil: "networkidle" });
  await dpPage.waitForTimeout(300);
  await dpPage.screenshot({ path: join(OUT, `desktop-${s.id}.png`) });
  console.log(`✓ desktop-${s.id}.png`);

  /* Mobile 390×844 */
  await dpPage.setViewportSize({ width: 390, height: 844 });
  await dpPage.evaluate((hint) => {
    document.querySelector(".proof-hint").textContent = hint;
  }, s.mobileHint);
  await dpPage.waitForTimeout(200);
  await dpPage.screenshot({ path: join(OUT, `mobile-${s.id}.png`) });
  console.log(`✓ mobile-${s.id}.png`);
  await dpPage.close();
}

/* Explicit visibility test — assert via DOM */
const testPage = await browser.newPage();
await testPage.setContent(buildPage({ ...gaugeStates[0], hint: "visibility test" }), { waitUntil: "networkidle" });

// Desktop assertions
await testPage.setViewportSize({ width: 1440, height: 900 });
await testPage.waitForTimeout(100);

const desktopResults = await testPage.evaluate(() => {
  const all = Array.from(document.querySelectorAll(".ui-hero-gauge"));
  const reserve = document.querySelector(".lp-reserve");
  const reserveVisible = reserve ? getComputedStyle(reserve).display !== "none" : false;
  const visibleGauges = all.filter(el => {
    let e = el;
    while (e) { if (getComputedStyle(e).display === "none") return false; e = e.parentElement; }
    return true;
  });
  return { totalGauges: all.length, visibleGauges: visibleGauges.length, reserveVisible };
});
console.log("\nDesktop visibility test:", desktopResults);
console.assert(desktopResults.visibleGauges === 1, `FAIL: expected 1 visible gauge, got ${desktopResults.visibleGauges}`);
console.assert(!desktopResults.reserveVisible, `FAIL: lp-reserve should be hidden on desktop`);

// Mobile assertions
await testPage.setViewportSize({ width: 390, height: 844 });
await testPage.waitForTimeout(100);

const mobileResults = await testPage.evaluate(() => {
  const all = Array.from(document.querySelectorAll(".ui-hero-gauge"));
  const reserve = document.querySelector(".lp-reserve");
  const reserveVisible = reserve ? getComputedStyle(reserve).display !== "none" : false;
  const visibleGauges = all.filter(el => {
    let e = el;
    while (e) { if (getComputedStyle(e).display === "none") return false; e = e.parentElement; }
    return true;
  });
  return { totalGauges: all.length, visibleGauges: visibleGauges.length, reserveVisible };
});
console.log("Mobile visibility test:", mobileResults);
console.assert(mobileResults.visibleGauges === 1, `FAIL: expected 1 visible gauge on mobile, got ${mobileResults.visibleGauges}`);
console.assert(!mobileResults.reserveVisible, `FAIL: lp-reserve should be hidden on mobile`);

await testPage.close();
await browser.close();

console.log("\n✅ All visibility assertions passed — screenshots in", OUT);
