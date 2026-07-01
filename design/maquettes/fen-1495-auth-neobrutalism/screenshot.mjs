/**
 * FEN-1495 — Auth surface before/after screenshot generator.
 * Renders the AuthModal at desktop 1440×900 + mobile 390×844.
 *
 * Usage: node screenshot.mjs
 * Output: ./screenshots/ (before-desktop.png, after-desktop.png, before-mobile.png, after-mobile.png)
 */

import { chromium } from "/tmp/pw/node_modules/playwright/index.mjs";
import { mkdir, readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "screenshots");

// Embed Inter variable font as base64 so headless Chrome can render text.
const FONT_PATH = "/paperclip/instances/default/projects/ec6c9c76-57ed-4476-bb8c-58a90776c95f/5fc73a29-d7f0-4499-91dc-4d495991323b/_default/apps/web/public/fonts/inter-latin-variable.woff2";
const interB64 = (await readFile(FONT_PATH)).toString("base64");
const FONT_FACE = `@font-face{font-family:"Inter";src:url("data:font/woff2;base64,${interB64}") format("woff2");}`;

await mkdir(OUT, { recursive: true });

/* ── shared CSS tokens (from apps/web/src/ui/styles/tokens.css) ─────────── */
const TOKENS = `
  :root {
    --gray-0: #ffffff;
    --gray-50: #f0f0f2;
    --gray-100: #e7e7ea;
    --gray-200: #cfcfd4;
    --gray-300: #b7b7be;
    --gray-400: #90909a;
    --gray-500: #6c6c76;
    --gray-600: #52525b;
    --gray-700: #3d3d45;
    --gray-800: #292930;
    --gray-900: #18181c;
    --ink: #111114;
    --twitch-purple: #9146ff;
    --accent: #ff4d3d;
    --accent-hover: #ff6354;
    --accent-active: #e23a2b;
    --accent-text: #cf2f1e;
    --accent-soft: #ffe7e3;
    --accent-ring: var(--ink);
    --accent-on-accent: var(--ink);
    --ui-bg: var(--gray-50);
    --ui-surface: var(--gray-0);
    --ui-surface-raised: var(--gray-0);
    --ui-border: var(--ink);
    --ui-border-strong: var(--ink);
    --ui-text: var(--gray-900);
    --ui-text-secondary: var(--gray-600);
    --ui-text-tertiary: var(--gray-500);
    --border-w: 2px;
    --border-w-strong: 3px;
    --radius-xs: 0; --radius-sm: 0; --radius-md: 0; --radius-lg: 0; --radius-xl: 0;
    --radius-pill: 9999px;
    --elev-1: 2px 2px 0 0 var(--ink);
    --elev-2: 4px 4px 0 0 var(--ink);
    --elev-3: 6px 6px 0 0 var(--ink);
    --elev-press: 1px 1px 0 0 var(--ink);
    --dur-fast: 120ms; --dur-base: 180ms;
    --ease-out: cubic-bezier(0.22,0.78,0.27,1);
    --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px;
    --space-5:20px; --space-6:24px; --space-8:32px; --space-10:40px; --space-12:48px;
    --text-sm:14px; --text-sm-lh:20px; --text-base:16px; --text-base-lh:24px;
    --text-lg:18px; --text-lg-lh:26px;
    --weight-regular:400; --weight-medium:500; --weight-semibold:600;
    --weight-bold:700; --weight-black:900;
    --font-sans:"Inter",Arial,sans-serif;
    --target-min: 44px;
    --da-radius-control: 0; --da-radius-card: 0;
    --da-elev-control: var(--elev-1);
    --da-motion-scale: 0;
    --focus-ring: var(--ink);
  }
`;

/* ── base components CSS (Button atom) ──────────────────────────────────── */
const BTN_CSS = `
  .ui-btn {
    --_btn-bg: var(--accent);
    --_btn-fg: var(--accent-on-accent);
    --_btn-bg-hover: var(--accent-hover);
    --_btn-bg-active: var(--accent-active);
    --_btn-border: transparent;
    display:inline-flex; align-items:center; justify-content:center; gap:var(--space-2);
    box-sizing:border-box; border:var(--border-w) solid var(--_btn-border);
    border-radius:var(--da-radius-control); background:var(--_btn-bg); color:var(--_btn-fg);
    font-family:var(--font-sans); font-weight:var(--weight-semibold); line-height:1;
    white-space:nowrap; cursor:pointer; text-decoration:none;
    box-shadow:var(--da-elev-control); padding:0 var(--space-4); min-height:44px;
    font-size:var(--text-base); position:relative;
  }
`;

/* ── before: old auth-modal.css (hardcoded dark colors — broken on light bg) ─ */
const MODAL_CSS_BEFORE = `
  .lp-auth-modal .lp-modal__close {
    position:absolute; top:12px; right:12px; width:44px; height:44px;
    display:flex; align-items:center; justify-content:center;
    background:none; border:none; cursor:pointer; font-size:20px; line-height:1;
    color:rgb(255 255 255 / 0.5);
    border-radius:6px; padding:0;
  }
  .lp-auth-modal .lp-modal__close:hover {
    color:#fff; background:rgb(255 255 255 / 0.06);
  }
  .lp-auth-modal .lp-modal__title {
    font-size:18px; line-height:26px; font-weight:600; color:#fff; margin:0; padding-right:32px;
  }
  .lp-auth-modal .lp-modal__value {
    font-size:16px; line-height:24px; color:#fff; margin:0;
  }
  .lp-auth-modal .lp-modal__reassurance {
    font-size:14px; line-height:20px; color:rgb(255 255 255 / 0.6); margin:0;
  }
  .lp-auth-modal .lp-modal__cta { width:100%; margin-top:4px; }
  .lp-auth__twitch {
    --_btn-bg: var(--twitch-purple);
    --_btn-fg: var(--accent-on-accent);
  }
`;

/* ── after: new auth-modal.css (FEN-1495 Neobrutalism tokens) ───────────── */
const MODAL_CSS_AFTER = `
  .lp-auth-modal .lp-modal__close {
    position:absolute; top:12px; right:12px; width:var(--target-min); height:var(--target-min);
    display:flex; align-items:center; justify-content:center;
    background:none; border:var(--border-w) solid transparent; cursor:pointer;
    font-size:20px; line-height:1; color:var(--ui-text-secondary);
    border-radius:var(--radius-sm); padding:0;
  }
  .lp-auth-modal .lp-modal__close:hover {
    color:var(--ui-text); border-color:var(--ui-border); box-shadow:var(--elev-1);
  }
  .lp-auth-modal .lp-modal__close:active {
    color:var(--ui-text); border-color:var(--ui-border); box-shadow:var(--elev-press);
    transform:translateY(1px);
  }
  .lp-auth-modal .lp-modal__title {
    font-size:var(--text-lg); line-height:var(--text-lg-lh);
    font-weight:var(--weight-bold); color:var(--ui-text); margin:0; padding-right:32px;
  }
  .lp-auth-modal .lp-modal__value {
    font-size:var(--text-base); line-height:var(--text-base-lh); color:var(--ui-text); margin:0;
  }
  .lp-auth-modal .lp-modal__reassurance {
    font-size:var(--text-sm); line-height:var(--text-sm-lh); color:var(--ui-text-secondary); margin:0;
  }
  .lp-auth-modal .lp-modal__cta { width:100%; margin-top:4px; }
  .lp-auth__twitch {
    --_btn-bg: var(--twitch-purple);
    --_btn-fg: var(--gray-0); /* FEN-1505: white on Twitch purple → 4.63:1 AA (matches shipped) */
    --_btn-bg-hover: color-mix(in srgb, var(--twitch-purple) 88%, var(--gray-900));
    --_btn-bg-active: color-mix(in srgb, var(--twitch-purple) 78%, var(--gray-900));
    --_btn-border: var(--ui-border);
  }
`;

/* ── modal card shell (mimics BottomSheet desktop card) ─────────────────── */
const SHEET_CSS = `
  * { box-sizing:border-box; }
  body { margin:0; background:var(--ui-bg); font-family:var(--font-sans); }
  .backdrop {
    position:fixed; inset:0; background:rgb(0 0 0 / 0.45);
    display:flex; align-items:center; justify-content:center;
  }
  .lp-sheet.lp-auth-modal {
    position:relative;
    width:min(420px, calc(100vw - 32px));
    background:var(--ui-surface-raised);
    border-top:1px solid var(--ui-border);
    box-shadow:var(--elev-3);
    padding:var(--space-6);
    display:flex; flex-direction:column; gap:var(--space-4);
  }
  @media (min-width:1024px) {
    .lp-auth-modal.lp-sheet {
      border:var(--border-w) solid var(--ui-border);
    }
  }
  /* mobile: grip handle replaces close btn */
  .lp-panel-handle {
    display:flex; flex-direction:column; align-items:center; padding:var(--space-3) 0 var(--space-2);
  }
  .lp-panel-handle-grip {
    display:block; width:40px; height:4px; border-radius:9999px;
    background:rgba(17,17,20,0.22);
  }
  /* Twitch icon placeholder */
  .twitch-icon { display:inline-block; width:20px; height:20px; vertical-align:middle; }
`;

/* HTML for one modal card */
const modalHtml = (title, css, forMobile = false) => `<!doctype html>
<html lang="fr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
${FONT_FACE}
${TOKENS}
${BTN_CSS}
${css}
${SHEET_CSS}
</style>
</head>
<body>
<div class="backdrop">
  <div class="lp-sheet lp-auth-modal">
    ${forMobile ? `<div class="lp-panel-handle"><div class="lp-panel-handle-grip"></div></div>` : ""}
    ${!forMobile ? `<button class="lp-modal__close ui-focusable" type="button" aria-label="Fermer">×</button>` : ""}
    <h2 class="lp-modal__title">Rejoins la communauté !</h2>
    <p class="lp-modal__value">Place des pixels sur le canvas de Streamer.</p>
    <p class="lp-modal__reassurance">Connexion Twitch uniquement — pas de mot de passe.</p>
    <button class="ui-btn lp-modal__cta lp-auth__twitch" type="button">
      <svg class="twitch-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path d="M4 2L2 6v10h4v2h2l2-2h3l4-4V2H4zm12 9l-2 2H9l-2 2v-2H4V4h12v7z"/>
        <path d="M14 5h-2v4h2V5zM10 5H8v4h2V5z"/>
      </svg>
      Se connecter avec Twitch
    </button>
  </div>
</div>
</body>
</html>`;

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "mobile",  width: 390,  height: 844, mobile: true  },
];
const STATES = [
  { name: "before", css: MODAL_CSS_BEFORE },
  { name: "after",  css: MODAL_CSS_AFTER  },
];

const browser = await chromium.launch({
  executablePath: process.env.LP_CHROME || undefined,
  args: ["--no-sandbox", "--force-color-profile=srgb"],
});

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();
  for (const st of STATES) {
    const html = modalHtml(`${st.name} / ${vp.name}`, st.css, vp.mobile);
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    // Wait for embedded Inter font to render (fixes blank-text flakiness in headless).
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(120);
    // Clip to the modal card — makes before/after differences readable
    const modal = page.locator(".lp-auth-modal");
    const box = await modal.boundingBox();
    const padding = 24;
    const clip = box
      ? {
          x: Math.max(0, box.x - padding),
          y: Math.max(0, box.y - padding),
          width: Math.min(vp.width, box.width + padding * 2),
          height: Math.min(vp.height, box.height + padding * 2),
        }
      : undefined;
    const outPath = join(OUT, `${st.name}-${vp.name}.png`);
    await page.screenshot({ path: outPath, fullPage: false, clip });
    console.log(`wrote ${outPath}`);
  }
  await ctx.close();
}

await browser.close();
console.log("done");
