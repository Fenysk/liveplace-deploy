import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buttonClass,
  celebrationColors,
  celebrationPieces,
  cooldownPercent,
  cooldownSeconds,
  cooldownVisualPhase,
  cx,
  fieldState,
  gaugeSegments,
  pillClass,
  pillIcon,
  reserveFillPercent,
  toastClass,
  toastIcon,
  wordmarkClass,
} from "./variants.ts";

test("cx joins only truthy fragments", () => {
  assert.equal(cx("a", false, null, undefined, "b"), "a b");
  assert.equal(cx(), "");
});

test("buttonClass composes variant + size + extra", () => {
  assert.equal(buttonClass(), "ui-btn ui-btn--primary ui-btn--md");
  assert.equal(
    buttonClass("ghost", "lg", "w-full"),
    "ui-btn ui-btn--ghost ui-btn--lg w-full",
  );
});

test("fieldState: error wins over disabled, else disabled, else default", () => {
  assert.equal(fieldState({ error: "bad", disabled: true }), "error");
  assert.equal(fieldState({ disabled: true }), "disabled");
  assert.equal(fieldState({}), "default");
  assert.equal(fieldState({ error: "" }), "default");
});

test("pill class + icon cover all 5 states with a non-empty glyph", () => {
  for (const s of ["open", "cooldown", "frozen", "ended", "error"] as const) {
    assert.equal(pillClass(s), `ui-pill ui-pill--${s}`);
    assert.ok(pillIcon(s).length > 0, `icon for ${s}`);
  }
});

test("toast class + icon cover all 3 kinds", () => {
  for (const k of ["success", "info", "error"] as const) {
    assert.equal(toastClass(k), `ui-toast ui-toast--${k}`);
    assert.ok(toastIcon(k).length > 0);
  }
});

test("cooldownPercent clamps 0..100 and rounds", () => {
  assert.equal(cooldownPercent(0, 1000), 0);
  assert.equal(cooldownPercent(500, 1000), 50);
  assert.equal(cooldownPercent(1000, 1000), 100);
  assert.equal(cooldownPercent(9999, 1000), 100);
  assert.equal(cooldownPercent(-5, 1000), 0);
  assert.equal(cooldownPercent(10, 0), 100); // guard div-by-zero
});

test("cooldownSeconds rounds up and floors at 0", () => {
  assert.equal(cooldownSeconds(0), 0);
  assert.equal(cooldownSeconds(1), 1);
  assert.equal(cooldownSeconds(1001), 2);
  assert.equal(cooldownSeconds(-50), 0);
});

test("gaugeSegments fills the right count and clamps", () => {
  assert.deepEqual(gaugeSegments(2, 4), [true, true, false, false]);
  assert.deepEqual(gaugeSegments(0, 3), [false, false, false]);
  assert.deepEqual(gaugeSegments(9, 3), [true, true, true]); // over-ready clamps
  assert.deepEqual(gaugeSegments(-1, 2), [false, false]);
  assert.deepEqual(gaugeSegments(1, 0), []);
});

test("cooldownVisualPhase maps engagement phases to the 3-rung ramp", () => {
  // waiting/armed pass through; the refilled "go" collapses to `ready`.
  assert.equal(cooldownVisualPhase("waiting"), "waiting");
  assert.equal(cooldownVisualPhase("armed"), "armed");
  assert.equal(cooldownVisualPhase("refilledArmed"), "ready");
  // plain available adds no ramp emphasis (rang-1 already carries "go").
  assert.equal(cooldownVisualPhase("ready"), null);
});

test("celebrationPieces spreads x deterministically with a woven delay", () => {
  assert.deepEqual(celebrationPieces(0), []);
  assert.deepEqual(celebrationPieces(1), [{ left: 50, delayMs: 0 }]);
  const three = celebrationPieces(3);
  assert.deepEqual(
    three.map((p) => p.left),
    [0, 50, 100],
  );
  // deterministic (no RNG): two calls match exactly.
  assert.deepEqual(celebrationPieces(8), celebrationPieces(8));
  // delay weaves on a 7-step cadence, so neighbours never share a delay.
  assert.equal(celebrationPieces(8)[7]?.delayMs, 0);
  assert.equal(celebrationPieces(8)[1]?.delayMs, 90);
});

test("reserveFillPercent clamps to 0..100 and is N-independent in footprint", () => {
  assert.equal(reserveFillPercent(20, 40), 50);
  assert.equal(reserveFillPercent(40, 40), 100);
  assert.equal(reserveFillPercent(0, 40), 0);
  assert.equal(reserveFillPercent(50, 40), 100); // over-cap clamps (no overflow)
  assert.equal(reserveFillPercent(-5, 40), 0); // bad server value floors at 0
  assert.equal(reserveFillPercent(10, 0), 0); // zero cap is safe
  assert.equal(reserveFillPercent(1, 3), 33); // rounds
});

test("wordmarkClass defaults to md", () => {
  assert.equal(wordmarkClass(), "ui-wordmark ui-wordmark--md");
  assert.equal(wordmarkClass("lg"), "ui-wordmark ui-wordmark--lg");
});

test("celebrationColors returns undefined for palettes with fewer than 3 colors", () => {
  assert.equal(celebrationColors([]), undefined);
  assert.equal(celebrationColors(["#ff0000"]), undefined);
  assert.equal(celebrationColors(["#ff0000", "#00ff00"]), undefined);
});

test("celebrationColors returns all colors when palette has 3–5 entries", () => {
  const three = ["#aaa", "#bbb", "#ccc"];
  assert.deepEqual(celebrationColors(three), ["#aaa", "#bbb", "#ccc"]);

  const five = ["#1", "#2", "#3", "#4", "#5"];
  assert.deepEqual(celebrationColors(five), ["#1", "#2", "#3", "#4", "#5"]);
});

test("celebrationColors caps at 5 and picks evenly from a large palette", () => {
  // 32-color palette (protocol size): expect exactly 5 colors.
  const palette = Array.from({ length: 32 }, (_, i) => `#${String(i).padStart(6, "0")}`);
  const result = celebrationColors(palette);
  assert.ok(result, "should not be undefined for 32-color palette");
  assert.equal(result!.length, 5);
  // All returned colors must come from the palette.
  for (const c of result!) {
    assert.ok(palette.includes(c), `${c} not found in palette`);
  }
  // Deterministic: same input → same output.
  assert.deepEqual(celebrationColors(palette), celebrationColors(palette));
  // Colors are distinct (evenly spread → no duplicates for palette.length >= 5).
  const unique = new Set(result!);
  assert.equal(unique.size, 5);
});
