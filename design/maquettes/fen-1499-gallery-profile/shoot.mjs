/**
 * Screenshot harness for FEN-1499 maquette.
 * Serves the maquette via HTTP (avoids file:// font NetworkError),
 * captures gallery + profile at desktop 1440x900 + mobile 390x844.
 * Run: node design/maquettes/fen-1499-gallery-profile/shoot.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const OUT = join(HERE, "screenshots");
mkdirSync(OUT, { recursive: true });

const PLAYWRIGHT_PATH = "/paperclip/.npm/_npx/5e2e484947874241/node_modules/playwright/index.js";
const require = createRequire(import.meta.url);
const pw = require(PLAYWRIGHT_PATH);
const { chromium } = pw;

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function serveFile(req, res) {
  const url = new URL(req.url, "http://localhost");
  let filePath;
  if (url.pathname === "/" || url.pathname === "/index.html") {
    filePath = join(HERE, "index.html");
  } else {
    filePath = join(REPO_ROOT, url.pathname);
  }
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) { res.writeHead(404); res.end(); return; }
    const ext = extname(filePath);
    const mime = MIME[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(readFileSync(filePath));
  } catch {
    res.writeHead(404);
    res.end("Not found: " + filePath);
  }
}

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844, isMobile: true, hasTouch: true },
];

const SHOTS = [
  { section: ".section:nth-child(2)", label: "gallery-grid" },
  { section: ".section:nth-child(3)", label: "gallery-empty" },
  { section: ".section:nth-child(4)", label: "gallery-comparison" },
  { section: ".section:nth-child(5)", label: "profile" },
  { section: ".section:nth-child(6)", label: "profile-comparison" },
];

async function shoot(page, vp) {
  const fullPath = join(OUT, `${vp.name}-full.png`);
  await page.screenshot({ path: fullPath, fullPage: true });
  console.log(`  Full page → ${fullPath}`);

  for (const shot of SHOTS) {
    try {
      const el = await page.$(shot.section);
      if (!el) { console.warn(`  ${shot.section} not found`); continue; }
      const path = join(OUT, `${vp.name}-${shot.label}.png`);
      await el.screenshot({ path });
      console.log(`  ${shot.label} → ${path}`);
    } catch (e) {
      console.warn(`  ${shot.section} error: ${e.message}`);
    }
  }
}

async function main() {
  const server = createServer(serveFile);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const BASE = `http://127.0.0.1:${port}`;
  console.log("Serving on", BASE);

  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_BROWSERS_PATH + "/chromium-1228/chrome-linux64/chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  for (const vp of VIEWPORTS) {
    console.log(`\n=== ${vp.name} (${vp.width}x${vp.height}) ===`);
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      isMobile: vp.isMobile || false,
      hasTouch: vp.hasTouch || false,
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });

    // Programmatic font load (reliable headless fix per memory)
    const loaded = await page.evaluate(async () => {
      try {
        const inter = new FontFace("Inter", "url(/apps/web/public/fonts/inter-latin-variable.woff2)", { weight: "100 900" });
        const ps2p = new FontFace("Press Start 2P", "url(/apps/web/public/fonts/press-start-2p-latin-400.woff2)", { weight: "400" });
        await Promise.all([inter.load(), ps2p.load()]);
        document.fonts.add(inter);
        document.fonts.add(ps2p);
        await document.fonts.ready;
        return true;
      } catch (e) {
        return "error: " + e.message;
      }
    });
    if (loaded !== true) {
      console.warn("  Font load:", loaded, "— text may be blank");
    } else {
      const w = await page.evaluate(() => {
        const el = document.querySelector(".rail-title");
        return el ? el.getBoundingClientRect().width : 0;
      });
      console.log(`  Font check: .rail-title width=${w}px`);
    }

    await shoot(page, vp);
    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log("\nDone. Screenshots in:", OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
