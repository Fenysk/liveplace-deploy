/**
 * Lot D "claim de palier" visual-verification harness ([FEN-116]). No browser is
 * available in this env, so — like batch-capture.ts — it drives the REAL
 * {@link TierClaim} controller and the REAL `@canvas/i18n` catalogs to emit a
 * self-contained HTML preview (apps/web/artifacts/claim-preview.html) reusing the
 * REAL canvas.css classes (.lp-gauge / .lp-claim / .lp-celebrate / .lp-btn).
 *
 * It proves, for BOTH locales (FR + EN parity):
 *   1. gauge-only HUD — no point/score/shop is ever rendered;
 *   2. a tier earned by playing surfaces as a non-blocking claim signal;
 *   3. encashing it celebrates and grows the réserve optimistically (+1 max);
 *   4. stacked tiers offer "claim all";
 *   5. after server confirmation the overlay folds away (max stays continuous).
 *
 * Fine visual design is delegated (out of this lot's scope) — this preview is the
 * strict-minimum-usable surface + the mechanic, reviewable by the UX Designer.
 *
 * Run: node --experimental-transform-types scripts/claim-preview.ts
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Import catalogs/format DIRECTLY from source: the package's index.ts re-exports
// through `.js` specifiers that Node's strip-types mode can't resolve, but these
// leaf modules are import-free. Same REAL catalogs the app ships.
import { en, type Catalog, type MessageKey } from "../../../packages/i18n/src/messages/en.ts";
import { fr } from "../../../packages/i18n/src/messages/fr.ts";
import { interpolate } from "../../../packages/i18n/src/format.ts";
import { TierClaim } from "../src/features/canvas/tierClaim.ts";

type Locale = "fr" | "en";
const CATALOGS: Record<Locale, Catalog> = { fr, en };

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "artifacts");
const CSS = readFileSync(join(HERE, "..", "src", "features", "canvas", "canvas.css"), "utf8");

function tr(cat: Catalog, key: MessageKey, params?: Record<string, string | number>): string {
  return interpolate(cat[key], params);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Render the HUD fragment for one named state, using the real controller + catalog. */
function hud(cat: Catalog, opts: { charges: number; serverMax: number; tier: TierClaim; celebrate?: string }): string {
  const { charges, serverMax, tier, celebrate } = opts;
  const max = tier.effectiveMax(serverMax);
  const pending = tier.pending;
  const gauge = tr(cat, "canvas.gauge", { current: tier.effectiveCharges(charges), max });
  let claim = "";
  if (pending > 0) {
    const label = pending > 1 ? tr(cat, "canvas.claim.stacked", { count: pending }) : tr(cat, "canvas.claim.available");
    const all =
      pending > 1
        ? `<button class="lp-btn lp-claim-all">${esc(tr(cat, "canvas.claim.all", { count: pending }))}</button>`
        : "";
    // FEN-140 #4: when stacked, the primary signals it claims ONE tier (+1) so the
    // one-by-one vs. "tout encaisser" choice is legible. FEN-140 #2: the persistent
    // claim signal is a standing affordance, not a live region (no role="status").
    const action = pending > 1 ? tr(cat, "canvas.claim.actionOne") : tr(cat, "canvas.claim.action");
    claim = `<div class="lp-claim"><span class="lp-claim-label">${esc(label)}</span>` +
      `<button class="lp-btn is-primary lp-claim-btn">${esc(action)}</button>${all}</div>`;
  }
  const cel = celebrate ? `<div class="lp-celebrate" style="position:static;margin-top:10px">${esc(celebrate)}</div>` : "";
  return `<div class="lp-hud" style="position:static;max-width:none">` +
    `<p class="lp-gauge">${esc(gauge)}</p>${claim}${cel}</div>`;
}

/** The scripted state sequence, driven by ONE real controller per column. */
function sequence(locale: Locale): string {
  const cat = CATALOGS[locale];
  const cards: Array<{ title: string; html: string }> = [];

  // 1) Gauge only — playing in the background, nothing to claim. No points/shop.
  const a = new TierClaim({ earned: 0, confirmed: 0 });
  cards.push({ title: "1 · Jauge seule (aucun point/boutique)", html: hud(cat, { charges: 3, serverMax: 5, tier: a }) });

  // 2) A tier crossed by playing → non-blocking signal (not auto-applied).
  const b = new TierClaim({ earned: 1, confirmed: 0 });
  cards.push({ title: "2 · Palier gagné en jouant — signal non-bloquant", html: hud(cat, { charges: 3, serverMax: 5, tier: b }) });

  // 3) Encashed → celebration + réserve grows optimistically (5 → 6).
  const c = new TierClaim({ earned: 1, confirmed: 0 });
  c.claimNext();
  cards.push({
    title: "3 · Encaissé — célébration + réserve +1 (optimiste)",
    html: hud(cat, { charges: 4, serverMax: 5, tier: c, celebrate: tr(cat, "canvas.claim.celebrate", { max: c.effectiveMax(5) }) }),
  });

  // 4) Several tiers stacked → claim one-by-one OR "tout encaisser".
  const d = new TierClaim({ earned: 3, confirmed: 0 });
  cards.push({ title: "4 · Paliers empilés — un par un ou tout encaisser", html: hud(cat, { charges: 4, serverMax: 5, tier: d }) });

  // 5) Server confirms → overlay folds away, max stays continuous (6).
  const e = new TierClaim({ earned: 1, confirmed: 0 });
  e.claimNext();
  e.sync({ earned: 1, confirmed: 1 }); // gauge frame max 5→6 + confirmed 0→1 land together
  cards.push({ title: "5 · Confirmé serveur — overlay résorbé, max continu", html: hud(cat, { charges: 4, serverMax: 6, tier: e }) });

  const body = cards.map((c) => `<section><h3>${esc(c.title)}</h3>${c.html}</section>`).join("\n");
  return `<div class="col"><h2>${locale.toUpperCase()}</h2>${body}</div>`;
}

const html = `<!doctype html><html><head><meta charset="utf-8">
<title>LivePlace — Claim de palier (Lot D / FEN-116)</title>
<style>
${CSS}
body{background:#0d0f12;color:#eaeaea;font-family:system-ui,sans-serif;margin:0;padding:24px}
h1{font-size:18px}.cols{display:flex;gap:32px;flex-wrap:wrap}.col{flex:1;min-width:320px}
section{margin:14px 0;padding:12px;border:1px solid #222;border-radius:10px;background:#14171c}
h2{font-size:14px;letter-spacing:.1em;color:#8fb}h3{font-size:12px;opacity:.7;margin:0 0 8px}
.lp-hud h1{display:none}
</style></head><body>
<h1>Claim de palier — jauge seule visible · parité FR/EN · états du flux (mécanique réelle TierClaim + i18n)</h1>
<div class="cols">${sequence("fr")}${sequence("en")}</div>
</body></html>`;

mkdirSync(OUT, { recursive: true });
const out = join(OUT, "claim-preview.html");
writeFileSync(out, html);
console.log("wrote", out, `(${html.length} bytes)`);
