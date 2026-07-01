/**
 * FEN-1512 — HeroGauge after-fix visual verification.
 *
 * Renders the REAL committed CSS (tokens.css + components.css) with
 * faithful DOM that mirrors HeroGauge.tsx after the FEN-1512 fixes:
 *   - No orange star (⚡ always)
 *   - No "Plein" badge
 *   - Full state: counter shows X (not X/X)
 *   - Reduced font size (text-xl vs text-3xl)
 *   - Mobile shows HeroGauge (not old compact reserve bars)
 *
 * Desktop 1440×900 and mobile 390×844 shots for each state.
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

const RESET = `
  *{box-sizing:border-box;}
  html,body{margin:0;background:var(--ui-bg);font-family:"Inter",sans-serif;}
  .ui-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);}
  .tnum{font-variant-numeric:tabular-nums;}
  .stage{padding:24px;max-width:320px;}
  .label{font-size:12px;font-weight:600;color:var(--ui-text-secondary);margin-bottom:12px;letter-spacing:0.04em;text-transform:uppercase;}
`;

/* ── Lightning SVG ── */
const lightning = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 20" width="14" height="20" fill="currentColor" aria-hidden="true"><path d="M8 0L0 11h6l-1 9 9-12H8L8 0z"/></svg>`;

/* ── HeroGauge DOM — mirrors HeroGauge.tsx after FEN-1512 fixes ── */
function heroGauge({ charges, max, state, seconds = 0, step = 1 }) {
  const fillRatio = Math.max(0, Math.min(charges, max)) / Math.max(1, max);
  const sub = state === "empty"
    ? `<span class="ui-hero-gauge__sub-text">Aucune charge disponible</span>`
    : state === "charging" && seconds > 0
      ? `<span class="ui-hero-gauge__sub-text ui-hero-gauge__countdown tnum">+${step} pixel dans ${seconds}s</span>`
      : "";

  // Full state: show only charges (no /max), no badge, lightning icon always
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

const states = [
  { id: "full",     label: "Plein (20/20)",    charges: 20, max: 20, state: "full" },
  { id: "charging", label: "Recharge (12/20)",  charges: 12, max: 20, state: "charging", seconds: 8 },
  { id: "empty",    label: "Vide (0/20)",       charges: 0,  max: 20, state: "empty" },
];

function buildPage(state) {
  return `<!doctype html><html lang="fr"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>${FONT_FACE}${tokens}${components}${RESET}</style></head>
<body>
  <div class="stage">
    <div class="label">${state.label}</div>
    ${heroGauge(state)}
  </div>
</body></html>`;
}

const browser = await chromium.launch();

for (const s of states) {
  // Desktop
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(buildPage(s), { waitUntil: "networkidle" });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(OUT, `desktop-${s.id}.png`) });
  console.log(`✓ desktop-${s.id}.png`);

  // Mobile
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(OUT, `mobile-${s.id}.png`) });
  console.log(`✓ mobile-${s.id}.png`);
  await page.close();
}

await browser.close();
console.log("\nDone — screenshots in", OUT);
