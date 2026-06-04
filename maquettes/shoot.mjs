import { chromium } from "playwright-core";

const EXE = "/paperclip/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const URL = "http://127.0.0.1:4317/";
const OUT = "/tmp/shots";
import { mkdirSync } from "node:fs";
mkdirSync(OUT, { recursive: true });

const directions = [
  { id: "sobre", label: "Studio · Sobre" },
  { id: "fun", label: "Arcade · Fun" },
  { id: "intuitif", label: "Aurora · Ultra-intuitif" },
];
const viewports = [
  { id: "desktop", label: "Desktop 1440", w: 1440, h: 900 },
  { id: "mobile", label: "Mobile 390", w: 390, h: 844 },
];
const states = [
  { id: "ready", label: "Prêt" },
  { id: "cooldown", label: "Cooldown" },
];

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1460, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "networkidle" });

async function clickSeg(label) {
  await page.locator(`button:has-text("${label}")`).first().click();
  await page.waitForTimeout(250);
}

const shots = [];
for (const d of directions) {
  await clickSeg(d.label);
  for (const v of viewports) {
    await clickSeg(v.label);
    for (const s of states) {
      // mobile has no "cooldown vs ready" extra value beyond what we show; capture both anyway
      await clickSeg(s.label);
      await page.waitForTimeout(350);
      const el = page.locator('[data-testid="maquette"]');
      const file = `${OUT}/${d.id}__${v.id}__${s.id}.png`;
      await el.screenshot({ path: file });
      shots.push(file);
      console.log("shot", file);
    }
  }
}

// One full-context shot per direction (chrome + intention + desktop ready) for the deck.
for (const d of directions) {
  await clickSeg(d.label);
  await clickSeg("Desktop 1440");
  await clickSeg("Prêt");
  await page.waitForTimeout(300);
  const file = `${OUT}/_context__${d.id}.png`;
  await page.screenshot({ path: file });
  console.log("context", file);
}

await browser.close();
console.log("DONE", shots.length, "surface shots");
