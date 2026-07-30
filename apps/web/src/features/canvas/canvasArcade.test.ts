import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pillStateForPlace,
  gaugeModeForCharges,
  cooldownRingPercent,
  type CanvasPillState,
} from "./canvasArcade.ts";
import type { PlaceStateKind } from "./placeState.ts";

test("pillStateForPlace: every place-state kind maps to a pill variant", () => {
  const expected: Record<PlaceStateKind, CanvasPillState> = {
    loading: "cooldown",
    offline: "error",
    notFound: "error",
    archived: "ended",
    banned: "error",
    ended: "ended",
    notStarted: "cooldown",
    frozen: "frozen",
    signedOut: "open",
    cooldown: "cooldown",
    ready: "open",
  };
  for (const [kind, pill] of Object.entries(expected)) {
    assert.equal(pillStateForPlace(kind as PlaceStateKind), pill, `kind=${kind}`);
  }
});

test("pillStateForPlace: ready and signedOut both read as a live (open) canvas", () => {
  assert.equal(pillStateForPlace("ready"), "open");
  assert.equal(pillStateForPlace("signedOut"), "open");
});

test("pillStateForPlace: offline (non-connecté) is an error glyph, not a calm one", () => {
  assert.equal(pillStateForPlace("offline"), "error");
});

test("gaugeModeForCharges: empty reserve drains a cooldown ring, else a ready bar", () => {
  assert.equal(gaugeModeForCharges(0), "cooldown");
  assert.equal(gaugeModeForCharges(-1), "cooldown");
  assert.equal(gaugeModeForCharges(1), "ready");
  assert.equal(gaugeModeForCharges(6), "ready");
});

test("cooldownRingPercent: drains 0→100 across the cooling cycle", () => {
  // Just entered cooling: remaining == total ⇒ empty ring.
  assert.equal(cooldownRingPercent(10, 10), 0);
  // Halfway through.
  assert.equal(cooldownRingPercent(5, 10), 50);
  // About to refill ⇒ full ring.
  assert.equal(cooldownRingPercent(0, 10), 100);
});

test("cooldownRingPercent: clamps out-of-range and guards a zero/absent total", () => {
  assert.equal(cooldownRingPercent(99, 10), 0); // remaining > total ⇒ clamp low
  assert.equal(cooldownRingPercent(-5, 10), 100); // negative remaining ⇒ clamp high
  assert.equal(cooldownRingPercent(3, 0), 100); // no known total ⇒ full (no fake drain)
});
