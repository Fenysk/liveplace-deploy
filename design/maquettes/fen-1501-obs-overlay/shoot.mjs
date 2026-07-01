/**
 * FEN-1501 — OBS overlay Neobrutalism review shots.
 *
 * Shows the "canvas unavailable" badge on three video backgrounds:
 *   - dark stream (near-black)
 *   - mid-tone stream (typical game scene)
 *   - light stream (overlay on bright content)
 *
 * All at 1440x900 (desktop / stream resolution) + 390x844 (mobile preview).
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
const canvas = await readFile(join(WEB, "src/features/canvas/canvas.css"), "utf8");

const interB64 = (await readFile(join(WEB, "public/fonts/inter-latin-variable.woff2"))).toString("base64");
const FONT_FACE = `@font-face{font-family:"Inter";src:url("data:font/woff2;base64,${interB64}") format("woff2");font-weight:100 900;}`;

// OBS root sets its own background — we simulate the stream scene via body bg.
// Override .lp-obs background to transparent so the stream scene shows through.
const RESET = `
  *{box-sizing:border-box;}
  html,body{margin:0;width:100%;height:100%;}
  html.lp-obs-root .lp-obs { background: transparent; }
`;

const page = (bg, inner) => `<!doctype html><html lang="fr" class="lp-obs-root"><head>
<meta charset="UTF-8"/>
<style>${FONT_FACE}${tokens}${canvas}${RESET}</style>
</head>
<body style="background:${bg};">
  ${inner}
</body></html>`;

// The actual unavailable DOM — let CSS handle position:fixed + centering.
const unavailableMsg = (msg) => `
<div class="lp-obs lp-obs--unavailable">
  <p class="lp-obs-unavailable-msg">${msg}</p>
</div>`;

const SCENES = [
  { name: "dark-stream", bg: "#0d0d0f", label: "Canvas non disponible" },
  { name: "midtone-stream", bg: "#2a3a4a", label: "Canvas non disponible" },
  { name: "light-stream", bg: "#c8d4df", label: "Canvas non disponible" },
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
  for (const scene of SCENES) {
    const html = page(scene.bg, unavailableMsg(scene.label));
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
    const fname = `${vp.label}-${scene.name}.png`;
    await pg.screenshot({ path: join(OUT, fname) });
    await ctx.close();
    console.log(`✓ ${fname}`);
  }
}

await browser.close();
console.log("Done →", OUT);
