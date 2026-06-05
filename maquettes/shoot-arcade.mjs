// Render the Arcade declination surfaces to real PNGs (visual truth for FEN-204).
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const EXE = "/paperclip/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const URL = "http://127.0.0.1:4317/";
const OUT = "/tmp/arcade";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1480, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "networkidle" });

const click = async (label) => {
  await page.locator(`button:has-text("${label}")`).first().click();
  await page.waitForTimeout(220);
};
const shot = async (name) => {
  await page.waitForTimeout(320);
  const el = page.locator('[data-testid="maquette"]');
  const file = `${OUT}/${name}.png`;
  await el.screenshot({ path: file });
  console.log("shot", file);
};

// Arcade is default. Capture each signature surface, desktop + mobile.
const plan = [
  { surface: "Canvas viewer", name: "viewer", states: ["Prêt", "Cooldown"] },
  { surface: "Onboarding",    name: "onboarding" },
  { surface: "Dashboard",     name: "dashboard" },
  { surface: "Célébration",   name: "celebration" },
  { surface: "Vue OBS",       name: "obs" },
];

for (const vp of ["Desktop 1440", "Mobile 390"]) {
  const vtag = vp.includes("Mobile") ? "mobile" : "desktop";
  for (const p of plan) {
    await click(p.surface);
    await click(vp);
    if (p.states) {
      for (const s of p.states) {
        await click(s);
        await shot(`${p.name}__${vtag}__${s === "Prêt" ? "ready" : "cooldown"}`);
      }
    } else {
      await shot(`${p.name}__${vtag}`);
    }
  }
}

// States board (no viewport switch) — full page so nothing is clipped.
await click("États");
await page.waitForTimeout(450);
await page.screenshot({ path: `${OUT}/states__board.png`, fullPage: true });
console.log("shot", `${OUT}/states__board.png (fullPage)`);

await browser.close();
console.log("DONE");
