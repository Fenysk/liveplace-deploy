/**
 * FEN-1496 — Home surface Neobrutalism review shots.
 *
 * Renders the real committed CSS (tokens.css + components.css + home.css)
 * with a faithful reconstruction of the Home discovery page so UI Designer
 * can QA at 1440x900 (desktop) + 390x844 (mobile).
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
const home = await readFile(join(WEB, "src/features/home/home.css"), "utf8");
const gallery = await readFile(join(WEB, "src/features/gallery/gallery.css"), "utf8");

const interB64 = (await readFile(join(WEB, "public/fonts/inter-latin-variable.woff2"))).toString("base64");
const FONT_FACE = `@font-face{font-family:"Inter";src:url("data:font/woff2;base64,${interB64}") format("woff2");font-weight:100 900;}`;

const RESET = `*{box-sizing:border-box;}html,body{margin:0;font-family:var(--font-sans);}`;

const page = (inner) => `<!doctype html><html lang="fr"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>${FONT_FACE}${tokens}${components}${home}${gallery}${RESET}</style></head>
<body style="background:var(--ui-bg)">${inner}</body></html>`;

const card = (name, viewers) => `
  <div class="gallery__card">
    <a href="#" class="gallery__cardLink">
      <div class="gallery__thumb" style="background:var(--gray-200);aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;color:var(--ui-text-secondary);font-size:var(--text-sm)">aperçu canvas</div>
      ${viewers ? `<span class="gallery__liveBadge">${viewers} spectateurs</span>` : ""}
    </a>
    <div class="gallery__body">
      <p class="gallery__cardTitle">${name}</p>
      <p class="gallery__streamerName">@streamer</p>
    </div>
  </div>`;

const DESKTOP_HTML = page(`
<div class="home-discovery">
  <header class="home-topbar">
    <div class="home-topbar__brand"><strong style="font-size:var(--text-lg)">LivePlace</strong></div>
    <div class="home-topbar__actions">
      <button type="button" class="ui-btn ui-btn--primary ui-btn--sm">Se connecter</button>
    </div>
  </header>
  <section class="home-hero">
    <span class="home-hero__kicker">
      <span>3 streams en direct</span>
    </span>
    <h1 class="home-hero__title">Bienvenue sur LivePlace</h1>
    <p class="home-hero__subtitle">Dessinez ensemble en direct.</p>
    <button type="button" class="ui-btn ui-btn--primary ui-btn--lg">Rejoindre le canvas</button>
  </section>
  <main class="home-content">
    <section>
      <div class="home-rail__header">
        <h2 class="home-rail__title">En direct maintenant</h2>
      </div>
      <div class="gallery__grid">
        ${card("Fresque du live", "127")}
        ${card("Marathon 24h", "48")}
        ${card("Soirée rétro", "12")}
        ${card("Canvas test", null)}
      </div>
    </section>
  </main>
</div>
`);

const MOBILE_HTML = page(`
<div class="home-discovery">
  <header class="home-topbar">
    <div class="home-topbar__brand"><strong style="font-size:var(--text-lg)">LivePlace</strong></div>
  </header>
  <section class="home-hero">
    <span class="home-hero__kicker">3 streams en direct</span>
    <h1 class="home-hero__title">Bienvenue sur LivePlace</h1>
    <p class="home-hero__subtitle">Dessinez ensemble en direct.</p>
    <button type="button" class="ui-btn ui-btn--primary ui-btn--lg">Rejoindre le canvas</button>
  </section>
  <main class="home-content">
    <section>
      <div class="home-rail__header">
        <h2 class="home-rail__title">En direct maintenant</h2>
      </div>
      <div class="gallery__grid">
        ${card("Fresque du live", "127")}
        ${card("Marathon 24h", "48")}
      </div>
    </section>
  </main>
</div>
`);

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, html: DESKTOP_HTML },
  { name: "mobile", width: 390, height: 844, html: MOBILE_HTML },
];

const browser = await chromium.launch({
  executablePath: process.env.LP_CHROME || undefined,
  args: ["--no-sandbox", "--force-color-profile=srgb"],
});

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
  const pg = await ctx.newPage();
  await pg.setContent(vp.html, { waitUntil: "domcontentloaded" });
  await pg.evaluate(async (b64) => {
    const f = new FontFace("Inter", `url(data:font/woff2;base64,${b64})`, { weight: "100 900" });
    await f.load();
    document.fonts.add(f);
    await document.fonts.ready;
  }, interB64);
  await pg.waitForTimeout(300);
  await pg.screenshot({ path: join(OUT, `${vp.name}.png`), fullPage: true });
  await ctx.close();
  console.log(`✓ ${vp.name}.png`);
}

await browser.close();
console.log("Done →", OUT);
