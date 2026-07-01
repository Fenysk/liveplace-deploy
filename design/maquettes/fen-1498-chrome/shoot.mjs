/**
 * FEN-1498 — Chrome residuals confirmation shot.
 *
 * Shows the BottomSheet backdrop (tokenised --sheet-backdrop) and confirms
 * the canvas-frame token (--canvas-frame = --ink = #111114) applied to the
 * canvas surround area.
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
const bottomSheet = await readFile(join(WEB, "src/ui/bottomSheet.css"), "utf8");
const canvasCss = await readFile(join(WEB, "src/features/canvas/canvas.css"), "utf8");

const interB64 = (await readFile(join(WEB, "public/fonts/inter-latin-variable.woff2"))).toString("base64");
const FONT_FACE = `@font-face{font-family:"Inter";src:url("data:font/woff2;base64,${interB64}") format("woff2");font-weight:100 900;}`;

const RESET = `*{box-sizing:border-box;}html,body{margin:0;font-family:var(--font-sans);}`;

const page = (inner) => `<!doctype html><html lang="fr"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>${FONT_FACE}${tokens}${components}${bottomSheet}${canvasCss}${RESET}</style>
</head><body style="background:var(--ui-bg)">${inner}</body></html>`;

// Show backdrop token + canvas frame surround in a controlled layout
const BACKDROP_DEMO = `
<div style="position:relative;height:100vh;background:var(--ui-bg);display:flex;align-items:center;justify-content:center;">
  <!-- Canvas area: surround uses --canvas-frame token (= --ink = #111114) -->
  <div style="background:var(--canvas-frame);padding:var(--space-4);display:inline-block;border:var(--border-w) solid var(--ink);">
    <div style="width:480px;height:270px;background:var(--gray-100);display:flex;align-items:center;justify-content:center;color:var(--ui-text-secondary);font-size:var(--text-sm);">
      canvas area
    </div>
  </div>
  <!-- Sheet backdrop overlay to show tokenised value -->
  <div style="position:absolute;inset:0;background:var(--sheet-backdrop);display:flex;align-items:flex-end;justify-content:center;">
    <div style="background:var(--ui-surface);border:var(--border-w-strong) solid var(--ink);padding:var(--space-6) var(--space-8);min-width:320px;box-shadow:var(--elev-3);margin-bottom:0;">
      <p style="margin:0 0 var(--space-2);font-weight:var(--weight-bold);color:var(--ui-text)">Sheet ouverte</p>
      <p style="margin:0;font-size:var(--text-sm);color:var(--ui-text-secondary)">Backdrop : <code>--sheet-backdrop</code> = rgba(0,0,0,0.45)</p>
      <p style="margin:var(--space-1) 0 0;font-size:var(--text-sm);color:var(--ui-text-secondary)">Canvas frame : <code>--canvas-frame</code> = <code>--ink</code> = #111114</p>
    </div>
  </div>
</div>`;

const VIEWPORTS = [
  { label: "desktop", w: 1440, h: 900 },
  { label: "mobile", w: 390, h: 844 },
];

const browser = await chromium.launch({
  executablePath: process.env.LP_CHROME || undefined,
  args: ["--no-sandbox", "--force-color-profile=srgb"],
});

for (const vp of VIEWPORTS) {
  const html = page(BACKDROP_DEMO);
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 2 });
  const pg = await ctx.newPage();
  await pg.setContent(html, { waitUntil: "domcontentloaded" });
  await pg.evaluate(async (b64) => {
    const f = new FontFace("Inter", `url(data:font/woff2;base64,${b64})`, { weight: "100 900" });
    await f.load();
    document.fonts.add(f);
    await document.fonts.ready;
  }, interB64);
  await pg.waitForTimeout(200);
  const fname = `${vp.label}.png`;
  await pg.screenshot({ path: join(OUT, fname) });
  await ctx.close();
  console.log(`✓ ${fname}`);
}

await browser.close();
console.log("Done →", OUT);
