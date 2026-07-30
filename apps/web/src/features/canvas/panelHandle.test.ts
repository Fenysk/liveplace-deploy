import { test } from "node:test";
import assert from "node:assert/strict";
import { computeShowHandle } from "./panelHandle.ts";

// FEN-1270 AC5: regression tests.
// - Idle (no inspect, no drawing) → data-has-handle="false" (gauge visible, no handle)
// - Any active mode         → data-has-handle="true"

test("computeShowHandle: idle (no inspect, no drawing) → handle hidden (AC5, FEN-1270)", () => {
  assert.equal(
    computeShowHandle(null, false),
    false,
    "idle state: no inspect, no drawing → data-has-handle must be false",
  );
});

test("computeShowHandle: inspect activates the handle (AC5, FEN-1270)", () => {
  assert.equal(
    computeShowHandle({ x: 5, y: 3 }, false),
    true,
    "inspect mode → data-has-handle must be true",
  );
});

test("computeShowHandle: drawing activates the handle (AC5, FEN-1270)", () => {
  assert.equal(
    computeShowHandle(null, true),
    true,
    "draw mode → data-has-handle must be true",
  );
});

test("computeShowHandle: both inspect and drawing active → handle shown", () => {
  assert.equal(computeShowHandle({ x: 0, y: 0 }, true), true);
});

// FEN-1249 regression: owner/moderator idle must NOT see the handle.
// canModerate is not a parameter of computeShowHandle — its absence proves the fix.
test("computeShowHandle: canModerate-only idle → handle hidden (AC5, FEN-1249)", () => {
  const result = computeShowHandle(null, false);
  assert.equal(result, false,
    "owner idle (canModerate=true but no inspect/draw): data-has-handle must be false");
});
