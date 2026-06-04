/**
 * FEN-124 HUD state-matrix capture — a browser-free verification of the
 * pose-viewer refinements (U1/U4/U5/U6/U7) that live in the React HUD, not on
 * the <canvas>. No browser/jsdom is available in this environment (the same
 * constraint that makes `batch-capture.ts` rasterise the canvas overlay in
 * Node), so this harness instead MIRRORS the exact JSX conditionals of
 * {@link CanvasView} and renders, for every interaction state, the visible
 * controls / mode badge / hints / toast in BOTH locales from the REAL i18n
 * catalogs. It then ASSERTS the refinement guarantees, so a regression in the
 * conditionals or a missing/renamed string fails the run.
 *
 * It is a faithful read of CanvasView.tsx — keep the two in sync. What it
 * proves per refinement:
 *   U1 — armed (mobile first tap) exposes a PRIMARY "Poser ici" → 1st pixel = 2
 *        gestures (tap → Poser ici), while "Dessiner" still opens batch build.
 *   U4 — an exit control is visible whenever building OR in draw mode
 *        ("Annuler" with a pending batch, "Terminer" when empty) + a persistent
 *        "Mode dessin" badge while drawing.
 *   U5 — a low-zoom nudge appears when a cell is below the touch target AND
 *        there is intent to pose.
 *   U6 — the batch hint copy is device-neutral (no "Touche"/"Tap").
 *   U7 — a positive success toast acknowledges a commit.
 *
 * Run: node --experimental-transform-types scripts/hud-capture.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../../../packages/i18n/src/messages/en.ts";
import { fr } from "../../../packages/i18n/src/messages/fr.ts";
import { interpolate } from "../../../packages/i18n/src/format.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "artifacts");

type Params = Record<string, string | number>;
const tr = (locale: typeof en | typeof fr, key: keyof typeof en, params?: Params): string =>
  interpolate(locale[key], params);

/** The render-relevant slice of CanvasView state for one snapshot. */
interface HudState {
  label: string;
  drawing: boolean;
  armed: boolean;
  count: number;
  capacity: number;
  charges: number;
  max: number;
  locked: boolean;
  belowTarget: boolean;
  toast?: { key: keyof typeof en; params?: Params; success?: boolean };
}

interface RenderedHud {
  gauge: string;
  controls: string[];
  modeBadge: string | null;
  hints: string[];
  toast: { text: string; variant: string } | null;
}

/** Mirror of CanvasView's JSX conditionals — resolve everything for one locale. */
function renderHud(s: HudState, locale: typeof en | typeof fr): RenderedHud {
  const t = (key: keyof typeof en, params?: Params) => tr(locale, key, params);

  // gauge line (HUD <p class="lp-gauge">)
  const gauge =
    s.charges <= 0
      ? t("canvas.cooldown", { seconds: 30 })
      : s.count > 0
        ? t("canvas.batchCount", { count: s.count, max: s.capacity })
        : t("canvas.gauge", { current: s.charges, max: s.max });

  // tool bar (div.lp-tools)
  const controls: string[] = [t("canvas.erase")];
  if (s.armed && !s.drawing) {
    controls.push(`*${t("canvas.placeHere")}`); // * = primary
    controls.push(t("canvas.draw"));
  }
  if (s.count > 0) controls.push(`*${t("canvas.validate", { count: s.count })}`);
  if (s.count > 0 || s.drawing) controls.push(s.count > 0 ? t("canvas.cancel") : t("canvas.finish"));

  // mode indicator + hints
  const modeBadge = s.drawing ? t("canvas.drawingMode") : null;
  const hints: string[] = [];
  if (s.belowTarget && (s.drawing || s.armed || s.count > 0)) hints.push(t("canvas.zoomHint"));
  if (s.count === 0 && !s.armed) hints.push(t("canvas.batchHint"));

  const toast = s.toast
    ? { text: t(s.toast.key, s.toast.params), variant: s.toast.success ? "success" : "refusal" }
    : null;

  return { gauge, controls, modeBadge, hints, toast };
}

// ── scenarios (the real pose-viewer flow, desktop + mobile) ──────────────────

// Mirror of validate()'s commit-toast choice (FEN-124 U7 residual): a committed
// batch that contains any erase reads "updated", a place-only batch reads
// "placed" — so an all-erase commit isn't mislabelled as posed.
const commitToastKey = (hasErase: boolean): keyof typeof en =>
  hasErase ? "canvas.feedback.updated" : "canvas.feedback.placed";

const STATES: HudState[] = [
  { label: "initial (idle, charges available)", drawing: false, armed: false, count: 0, capacity: 0, charges: 10, max: 16, locked: false, belowTarget: false },
  { label: "mobile — first tap, cell armed (U1)", drawing: false, armed: true, count: 0, capacity: 10, charges: 10, max: 16, locked: false, belowTarget: false },
  { label: "mobile — armed at low zoom (U1+U5)", drawing: false, armed: true, count: 0, capacity: 10, charges: 10, max: 16, locked: false, belowTarget: true },
  { label: "batch building (3 staged)", drawing: true, armed: false, count: 3, capacity: 10, charges: 10, max: 16, locked: false, belowTarget: false },
  { label: "draw mode, batch empty after commit (U4)", drawing: true, armed: false, count: 0, capacity: 10, charges: 10, max: 16, locked: false, belowTarget: false },
  { label: "commit acknowledged — placed (U7)", drawing: true, armed: false, count: 0, capacity: 10, charges: 7, max: 16, locked: false, belowTarget: false, toast: { key: commitToastKey(false), params: { count: 3 }, success: true } },
  { label: "commit acknowledged — all-erase batch (U7 erase copy)", drawing: true, armed: false, count: 0, capacity: 10, charges: 10, max: 16, locked: false, belowTarget: false, toast: { key: commitToastKey(true), params: { count: 3 }, success: true } },
];

// ── assertions (a refinement regression fails the run) ───────────────────────

const failures: string[] = [];
const check = (cond: boolean, msg: string) => {
  if (!cond) failures.push(msg);
};

for (const locale of [en, fr] as const) {
  const name = locale === en ? "en" : "fr";
  const armed = renderHud(STATES[1]!, locale);
  // U1: express single-pose is present and primary; batch path still offered.
  check(armed.controls.some((c) => c.startsWith("*") && c.includes(tr(locale, "canvas.placeHere"))), `[${name}] U1: armed state must expose a PRIMARY "Poser ici"`);
  check(armed.controls.some((c) => c === tr(locale, "canvas.draw")), `[${name}] U1: "Dessiner" batch path must remain`);

  const drawEmpty = renderHud(STATES[4]!, locale);
  // U4: visible exit ("Terminer") + mode badge when drawing with an empty batch.
  check(drawEmpty.controls.includes(tr(locale, "canvas.finish")), `[${name}] U4: empty draw mode must show an exit ("Terminer")`);
  check(drawEmpty.modeBadge === tr(locale, "canvas.drawingMode"), `[${name}] U4: draw mode must show a mode badge`);

  const lowZoom = renderHud(STATES[2]!, locale);
  // U5: low-zoom nudge when posing intent + below touch target.
  check(lowZoom.hints.includes(tr(locale, "canvas.zoomHint")), `[${name}] U5: low-zoom nudge must appear when armed below target`);

  // U6: device-neutral hint copy.
  const hint = locale[`canvas.batchHint`];
  check(!/touche|tap/i.test(hint), `[${name}] U6: batch hint must be device-neutral, got: "${hint}"`);

  const success = renderHud(STATES[5]!, locale);
  // U7: positive success acknowledgement of a place commit.
  check(success.toast?.variant === "success", `[${name}] U7: commit must raise a success toast`);
  check(success.toast?.text === tr(locale, commitToastKey(false), { count: 3 }), `[${name}] U7: place-only commit must read "placed"`);

  // U7 erase copy: an all-erase commit must read "updated", never "placed".
  const erase = renderHud(STATES[6]!, locale);
  check(erase.toast?.text === tr(locale, "canvas.feedback.updated", { count: 3 }), `[${name}] U7-erase: all-erase commit must read "updated"`);
  check(erase.toast?.text !== success.toast?.text, `[${name}] U7-erase: erase ack must differ from place ack`);
}

// ── emit the matrix ──────────────────────────────────────────────────────────

const lines: string[] = [];
lines.push("FEN-124 — pose-viewer HUD state matrix (mirrors CanvasView.tsx)\n");
for (const s of STATES) {
  lines.push(`── ${s.label}`);
  for (const locale of [en, fr] as const) {
    const r = renderHud(s, locale);
    const name = locale === en ? "EN" : "FR";
    lines.push(`   [${name}] gauge:   ${r.gauge}`);
    lines.push(`   [${name}] buttons: ${r.controls.join("  |  ")}    (* = primary CTA)`);
    if (r.modeBadge) lines.push(`   [${name}] mode:    ⟦${r.modeBadge}⟧`);
    if (r.hints.length) lines.push(`   [${name}] hint:    ${r.hints.join(" / ")}`);
    if (r.toast) lines.push(`   [${name}] toast:   (${r.toast.variant}) ${r.toast.text}`);
  }
  lines.push("");
}
lines.push(failures.length ? `❌ ${failures.length} assertion(s) failed:` : "✅ all refinement assertions passed (U1/U4/U5/U6/U7, FR+EN)");
for (const f of failures) lines.push(`   - ${f}`);

const report = lines.join("\n");
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "hud-states.txt"), report + "\n");
// eslint-disable-next-line no-console
console.log(report);

if (failures.length) process.exit(1);
