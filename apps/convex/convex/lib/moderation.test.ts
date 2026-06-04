/**
 * Acceptance tests for the F8 pure moderation rules (FEN-52), aligned to the
 * frozen contract docs/contracts/moderation.md. Runs under Node's built-in test
 * runner with native TS type-stripping — no Convex runtime:
 *
 *   node --test apps/convex/convex/lib/moderation.test.ts
 *
 * Covers the ban+wipe fold (skip a run of the banned user's own stacked pixels,
 * reveal underneath, skip painted-over / already-erased), unit + group delete,
 * the bulkDelta mapping, and deterministic row-major ordering.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planWipe,
  planDelete,
  removalCells,
  groupByCell,
  sortPlans,
  authorOfTop,
  type PlacementRow,
} from "./moderation.ts";

// Helper: terse placement literal.
const p = (x: number, y: number, color: number, version: number, userId?: string): PlacementRow => ({
  x,
  y,
  color,
  version,
  userId,
});

test("planWipe: reveals the colour underneath the banned author's top pixel", () => {
  // (1,1): bob painted 5 over alice's 3 → wiping bob reveals 3.
  const log = [p(1, 1, 3, 10, "alice"), p(1, 1, 5, 20, "bob")];
  assert.deepEqual(planWipe(log, "bob"), [
    { x: 1, y: 1, removedUserId: "bob", removedColor: 5, removedVersion: 20, underneathColor: 3 },
  ]);
});

test("planWipe: skips a run of the banned user's OWN stacked pixels", () => {
  // bob placed twice (v20, v30) over alice's 3 → wiping bob reveals alice's 3.
  const log = [p(1, 1, 3, 10, "alice"), p(1, 1, 4, 20, "bob"), p(1, 1, 5, 30, "bob")];
  assert.deepEqual(planWipe(log, "bob"), [
    { x: 1, y: 1, removedUserId: "bob", removedColor: 5, removedVersion: 30, underneathColor: 3 },
  ]);
});

test("planWipe: erases (0) when only the banned user ever touched the cell", () => {
  const log = [p(2, 3, 7, 11, "bob"), p(2, 3, 8, 12, "bob")];
  assert.deepEqual(planWipe(log, "bob"), [
    { x: 2, y: 3, removedUserId: "bob", removedColor: 8, removedVersion: 12, underneathColor: 0 },
  ]);
});

test("planWipe: skips cells the banned user no longer tops, and erased tops", () => {
  const log = [
    p(0, 0, 4, 5, "bob"),
    p(0, 0, 6, 9, "alice"), // alice on top now
    p(1, 0, 8, 5, "bob"),
    p(1, 0, 0, 7, "bob"), // bob erased their own → nothing visible
  ];
  assert.deepEqual(planWipe(log, "bob"), []);
});

test("planDelete: unit + group reveal immediately-previous, de-dupe, skip empty/missing", () => {
  const log = [
    p(1, 1, 3, 10, "alice"),
    p(1, 1, 5, 20, "bob"),
    p(2, 2, 9, 15, "carol"),
  ];
  const out = planDelete(log, [
    { x: 1, y: 1 },
    { x: 2, y: 2 },
    { x: 1, y: 1 }, // duplicate ignored
    { x: 7, y: 7 }, // no history → skipped
  ]);
  assert.deepEqual(out, [
    { x: 1, y: 1, removedUserId: "bob", removedColor: 5, removedVersion: 20, underneathColor: 3 },
    { x: 2, y: 2, removedUserId: "carol", removedColor: 9, removedVersion: 15, underneathColor: 0 },
  ]);
});

test("removalCells: maps plans onto bulkDelta cells writing the underneath colour", () => {
  const log = [p(1, 1, 3, 10, "alice"), p(1, 1, 5, 20, "bob")];
  assert.deepEqual(removalCells(planWipe(log, "bob")), [{ x: 1, y: 1, color: 3 }]);
});

test("groupByCell: sorts each cell's stack ascending by version", () => {
  const groups = groupByCell([p(0, 0, 1, 30), p(0, 0, 2, 10), p(0, 0, 3, 20)]);
  assert.deepEqual(
    groups.get("0,0")!.map((r) => r.version),
    [10, 20, 30],
  );
});

// ── authorOfTop (FEN-159): ban target from a cell's top placement ───────────

test("authorOfTop: returns the visible author of the top placement", () => {
  // The query feeds the highest-version row (by_canvas_cell desc).
  assert.deepEqual(authorOfTop(p(4, 7, 5, 20, "bob")), {
    userId: "bob",
    color: 5,
    version: 20,
  });
});

test("authorOfTop: null for an empty cell (no placement)", () => {
  assert.equal(authorOfTop(null), null);
  assert.equal(authorOfTop(undefined), null);
});

test("authorOfTop: null when the top is erased (color 0 shows nothing)", () => {
  assert.equal(authorOfTop(p(1, 1, 0, 99, "bob")), null);
});

test("authorOfTop: null when the top is anonymous (no userId to ban)", () => {
  assert.equal(authorOfTop(p(1, 1, 5, 99)), null);
});

test("sortPlans: deterministic row-major (y then x)", () => {
  const out = sortPlans([
    { x: 2, y: 1 },
    { x: 1, y: 1 },
    { x: 0, y: 0 },
  ]);
  assert.deepEqual(out, [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
  ]);
});
