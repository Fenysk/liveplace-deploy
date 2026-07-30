/**
 * Tests for eyedropper↔draw coupling (FEN-2038).
 *   A1: I (OFF→ON) sets eyedropperMode=true, drawing=true (via enterDrawMode)
 *   A2: pick / Esc / re-I (ON→OFF) sets eyedropperMode=false, drawing unchanged
 *
 *   node --test apps/web/src/features/canvas/eyedropperDrawCoupling.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEyedropperToggle } from "./eyedropper.ts";

// A1 — OFF→ON when NOT already drawing: sets eyedropper + calls enterDrawMode + opens panel
test("A1: OFF→ON (not drawing) → eyedropper true + enterDrawMode called + panel opened", () => {
  const calls: string[] = [];
  applyEyedropperToggle(false, false, {
    setEyedropperMode: (v) => calls.push(`eyedropper:${v}`),
    enterDrawMode: () => calls.push("enterDrawMode"),
    openPanel: () => calls.push("openPanel"),
  });
  assert.deepEqual(calls, ["eyedropper:true", "enterDrawMode", "openPanel"]);
});

// A1 variant — OFF→ON when already drawing: sets eyedropper + opens panel but skips enterDrawMode
test("A1 (already drawing): OFF→ON → eyedropper true + openPanel + NO enterDrawMode", () => {
  const calls: string[] = [];
  applyEyedropperToggle(false, true, {
    setEyedropperMode: (v) => calls.push(`eyedropper:${v}`),
    enterDrawMode: () => calls.push("enterDrawMode"),
    openPanel: () => calls.push("openPanel"),
  });
  assert.deepEqual(calls, ["eyedropper:true", "openPanel"]);
});

// A2 — ON→OFF (re-I): only sets eyedropperMode=false, never touches drawing mode
test("A2: ON→OFF (re-I) → eyedropper false, enterDrawMode NOT called", () => {
  const calls: string[] = [];
  applyEyedropperToggle(true, true, {
    setEyedropperMode: (v) => calls.push(`eyedropper:${v}`),
    enterDrawMode: () => calls.push("enterDrawMode"),
    openPanel: () => calls.push("openPanel"),
  });
  assert.deepEqual(calls, ["eyedropper:false"]);
  assert.ok(!calls.includes("enterDrawMode"), "enterDrawMode must not be called on OFF");
  assert.ok(!calls.includes("openPanel"), "openPanel must not be called on OFF");
});

// A2 — ON→OFF with drawing=false: same — only eyedropper false, no drawing side-effect
test("A2: ON→OFF when drawing=false → only eyedropper:false", () => {
  const calls: string[] = [];
  applyEyedropperToggle(true, false, {
    setEyedropperMode: (v) => calls.push(`eyedropper:${v}`),
    enterDrawMode: () => calls.push("enterDrawMode"),
    openPanel: () => calls.push("openPanel"),
  });
  assert.deepEqual(calls, ["eyedropper:false"]);
});
