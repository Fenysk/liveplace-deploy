import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregatePlacementCounts,
  cellCountDelta,
} from "./placementAggregate.ts";

/**
 * The pure per-user count fold behind `worker:applyFlush` (FEN-47, ADR-0001).
 * These pin the exactly-once + anonymous-excluded contract that keeps the F2
 * `userCanvasStats` accrual aligned with the placement log under at-least-once
 * redelivery (R2).
 */

test("counts placements per identified user", () => {
  const counts = aggregatePlacementCounts([
    { userId: "u1", version: 1 },
    { userId: "u2", version: 2 },
    { userId: "u1", version: 3 },
  ]);
  assert.deepEqual(counts, [
    { userId: "u1", count: 2 },
    { userId: "u2", count: 1 },
  ]);
});

test("ignores anonymous placements (missing or empty userId)", () => {
  const counts = aggregatePlacementCounts([
    { version: 1 },
    { userId: "", version: 2 },
    { userId: "u1", version: 3 },
  ]);
  assert.deepEqual(counts, [{ userId: "u1", count: 1 }]);
});

test("empty batch yields no deltas", () => {
  assert.deepEqual(aggregatePlacementCounts([]), []);
});

test("preserves first-seen user order (deterministic)", () => {
  const counts = aggregatePlacementCounts([
    { userId: "b", version: 1 },
    { userId: "a", version: 2 },
    { userId: "b", version: 3 },
    { userId: "a", version: 4 },
  ]);
  assert.deepEqual(counts.map((c) => c.userId), ["b", "a"]);
});

// ── cellCountDelta ────────────────────────────────────────────────────────────

test("cellCountDelta: empty→filled returns +1", () => {
  assert.equal(cellCountDelta(0, 1), 1);
  assert.equal(cellCountDelta(0, 255), 1);
});

test("cellCountDelta: filled→empty returns -1", () => {
  assert.equal(cellCountDelta(1, 0), -1);
  assert.equal(cellCountDelta(255, 0), -1);
});

test("cellCountDelta: filled→filled (repaint) returns 0", () => {
  assert.equal(cellCountDelta(1, 2), 0);
  assert.equal(cellCountDelta(3, 3), 0);
});

test("cellCountDelta: empty→empty returns 0", () => {
  assert.equal(cellCountDelta(0, 0), 0);
});

