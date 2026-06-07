import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const EXE = "/paperclip/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const BASE = process.env.SHOOT_URL || "http://127.0.0.1:4321/liveplace-ui-preview/";
const OUT = "/tmp/r2";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(600); // let ResizeObserver settle the pan/zoom framing

const rootLen = await page.evaluate(() => document.getElementById("root")?.innerHTML.length || 0);
console.log("root innerHTML length:", rootLen);

await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: `${OUT}/r2-full.png`, fullPage: true });
console.log("shot r2-full.png");

const figs = page.locator("figure");
const n = await figs.count();
console.log("figures:", n);
for (let i = 0; i < n; i++) {
  await figs.nth(i).scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await figs.nth(i).screenshot({ path: `${OUT}/fig-${i}.png` });
  console.log("shot fig-" + i + ".png");
}

await browser.close();
console.log("DONE");
