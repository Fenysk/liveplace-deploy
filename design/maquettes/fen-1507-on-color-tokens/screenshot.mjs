/**
 * FEN-1507 — AC5 visual-truth: Twitch CTA white text on purple background.
 * Renders auth modal at desktop 1440x900 + mobile 390x844.
 *
 * Usage: node screenshot.mjs
 * Output: ./screenshots/ (desktop.png, mobile.png)
 */

import { chromium } from "/tmp/pw/node_modules/playwright/index.mjs";
import { mkdir, readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "screenshots");

const FONT_PATH = "/paperclip/instances/default/projects/ec6c9c76-57ed-4476-bb8c-58a90776c95f/5fc73a29-d7f0-4499-91dc-4d495991323b/_default/apps/web/public/fonts/inter-latin-variable.woff2";
const interBuf = await readFile(FONT_PATH);
const interB64 = interBuf.toString("base64");

await mkdir(OUT, { recursive: true });

/* interB64 is passed into page.evaluate as ArrayBuffer to avoid NetworkError flakiness */
const INTER_B64 = interB64;

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
    /* FEN-1507: on-color tokens */
    --on-accent:       var(--ink);
    --on-twitch:       var(--gray-0);
    --on-status-green: var(--gray-0);
    --on-status-amber: var(--gray-0);
    --on-status-red:   var(--gray-0);
    --on-status-blue:  var(--gray-0);
    --ui-bg: var(--gray-50);
    --ui-surface: var(--gray-0);
    --ui-surface-raised: var(--gray-0);
    --ui-border: var(--ink);
    --ui-text: var(--gray-900);
    --ui-text-secondary: var(--gray-600);
    --border-w: 2px;
    --radius-xs: 0; --radius-sm: 0; --radius-md: 0; --radius-lg: 0; --radius-xl: 0;
    --radius-pill: 9999px;
    --elev-1: 2px 2px 0 0 var(--ink);
    --elev-2: 4px 4px 0 0 var(--ink);
    --elev-3: 6px 6px 0 0 var(--ink);
    --elev-press: 1px 1px 0 0 var(--ink);
    --da-radius-control: 0; --da-radius-card: 0;
    --da-elev-control: var(--elev-1);
    --da-motion-scale: 0;
    --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px;
    --space-5:20px; --space-6:24px; --space-8:32px; --space-10:40px; --space-12:48px;
    --text-sm:14px; --text-sm-lh:20px; --text-base:16px; --text-base-lh:24px;
    --text-lg:18px; --text-lg-lh:26px;
    --weight-regular:400; --weight-medium:500; --weight-semibold:600;
    --weight-bold:700; --weight-black:900;
    --font-sans:"Inter",Arial,sans-serif;
    --target-min:44px;
    --focus-ring: var(--ink);
  }
`;

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

/* Uses --on-twitch token (FEN-1507) instead of hardcoded --gray-0 */
const MODAL_CSS = `
  .lp-auth-modal .lp-modal__close {
    position:absolute; top:12px; right:12px; width:var(--target-min); height:var(--target-min);
    display:flex; align-items:center; justify-content:center;
    background:none; border:var(--border-w) solid transparent; cursor:pointer;
    font-size:20px; line-height:1; color:var(--ui-text-secondary);
    border-radius:var(--radius-sm); padding:0;
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
  /* FEN-1507: --_btn-fg via --on-twitch token (resolves to white, 4.64:1 AA) */
  .lp-auth__twitch {
    --_btn-bg: var(--twitch-purple);
    --_btn-fg: var(--on-twitch);
    --_btn-bg-hover: color-mix(in srgb, var(--twitch-purple) 88%, var(--gray-900));
    --_btn-bg-active: color-mix(in srgb, var(--twitch-purple) 78%, var(--gray-900));
    --_btn-border: var(--ui-border);
  }
`;

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
  .lp-panel-handle {
    display:flex; flex-direction:column; align-items:center; padding:var(--space-3) 0 var(--space-2);
  }
  .lp-panel-handle-grip {
    display:block; width:40px; height:4px; border-radius:9999px;
    background:rgba(17,17,20,0.22);
  }
  .twitch-icon { display:inline-block; width:20px; height:20px; vertical-align:middle; }
  /* Label overlay showing the token being used */
  .token-label {
    position:fixed; bottom:12px; left:12px;
    font-family:monospace; font-size:11px; color:#fff;
    background:rgba(0,0,0,0.65); padding:4px 8px; border-radius:4px;
  }
`;

const pageHtml = (forMobile) => `<!doctype html>
<html lang="fr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
${TOKENS}
${BTN_CSS}
${MODAL_CSS}
${SHEET_CSS}
</style>
</head>
<body>
<div class="backdrop">
  <div class="lp-sheet lp-auth-modal">
    ${forMobile
      ? `<div class="lp-panel-handle"><div class="lp-panel-handle-grip"></div></div>`
      : `<button class="lp-modal__close" type="button" aria-label="Fermer">x</button>`}
    <h2 class="lp-modal__title">Rejoins la communaute !</h2>
    <p class="lp-modal__value">Place des pixels sur le canvas de Streamer.</p>
    <p class="lp-modal__reassurance">Connexion Twitch uniquement - pas de mot de passe.</p>
    <button class="ui-btn lp-modal__cta lp-auth__twitch" type="button">
      <svg class="twitch-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path d="M4 2L2 6v10h4v2h2l2-2h3l4-4V2H4zm12 9l-2 2H9l-2 2v-2H4V4h12v7z"/>
        <path d="M14 5h-2v4h2V5zM10 5H8v4h2V5z"/>
      </svg>
      Se connecter avec Twitch
    </button>
  </div>
</div>
<div class="token-label">FEN-1507: --_btn-fg: var(--on-twitch) = white 4.64:1 AA</div>
</body>
</html>`;

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "mobile",  width: 390,  height: 844, mobile: true  },
];

const browser = await chromium.launch({
  executablePath: process.env.LP_CHROME || undefined,
  args: ["--no-sandbox", "--force-color-profile=srgb"],
});

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();
  await page.setContent(pageHtml(vp.mobile), { waitUntil: "domcontentloaded" });
  // ArrayBuffer FontFace approach: deterministic, no network calls (memory: headless-screenshot-fonts)
  await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const ab = buf.buffer;
    for (const weight of [400, 500, 600, 700]) {
      const ff = new FontFace("Inter", ab, { weight: String(weight) });
      await ff.load();
      document.fonts.add(ff);
    }
    await document.fonts.ready;
  }, INTER_B64);
  await page.waitForTimeout(150);
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
  const outPath = join(OUT, `${vp.name}.png`);
  await page.screenshot({ path: outPath, fullPage: false, clip });
  console.log(`wrote ${outPath}`);
  await ctx.close();
}

await browser.close();
console.log("done");
