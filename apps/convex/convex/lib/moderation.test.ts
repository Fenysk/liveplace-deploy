/**
 * Acceptance tests for the F8 pure moderation rules (FEN-52). Runs under Node's
 * built-in test runner with native TS type-stripping — no Convex runtime, no
 * dependency install:
 *
 *   node --test apps/convex/convex/lib/moderation.test.ts
 *
 * Covers the ban+wipe stack fold (top-of-stack ownership, reveal underneath,
 * skip painted-over / already-erased), unit + group delete, restore-from-history,
 * and deterministic row-major ordering.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeWipeCells,
  computeDeleteCells,
  computeRestoreCells,
  groupByCell,
  sortCells,
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

test("computeWipeCells: reveals the colour underneath the banned author's top pixel", () => {
  // Cell (1,1): bob painted 5 over alice's 3 → wiping bob reveals 3.
  const log = [p(1, 1, 3, 10, "alice"), p(1, 1, 5, 20, "bob")];
  assert.deepEqual(computeWipeCells(log, "bob"), [{ x: 1, y: 1, color: 3 }]);
});

test("computeWipeCells: erases (colour 0) when the banned pixel sits on bare canvas", () => {
  const log = [p(2, 3, 7, 11, "bob")];
  assert.deepEqual(computeWipeCells(log, "bob"), [{ x: 2, y: 3, color: 0 }]);
});

test("computeWipeCells: skips cells the banned user no longer tops", () => {
  // bob placed first, alice painted over → bob is not on top, nothing to wipe.
  const log = [p(0, 0, 4, 5, "bob"), p(0, 0, 6, 9, "alice")];
  assert.deepEqual(computeWipeCells(log, "bob"), []);
});

test("computeWipeCells: skips an already-erased top (no visible pixel)", () => {
  const log = [p(1, 0, 8, 5, "bob"), p(1, 0, 0, 7, "bob")];
  assert.deepEqual(computeWipeCells(log, "bob"), []);
});

test("computeWipeCells: ignores anonymous and other users, handles unsorted input", () => {
  const log = [
    p(5, 5, 2, 30, "bob"), // top at (5,5) is bob
    p(5, 5, 1, 10, undefined), // anon underneath
    p(9, 9, 3, 40, "carol"), // carol's, untouched
  ];
  assert.deepEqual(computeWipeCells(log, "bob"), [{ x: 5, y: 5, color: 1 }]);
});

test("computeDeleteCells: unit + group reveal underneath, de-dupe, missing cell → 0", () => {
  const log = [
    p(1, 1, 3, 10, "alice"),
    p(1, 1, 5, 20, "bob"),
    p(2, 2, 9, 15, "carol"),
  ];
  const out = computeDeleteCells(log, [
    { x: 1, y: 1 },
    { x: 2, y: 2 },
    { x: 1, y: 1 }, // duplicate ignored
    { x: 7, y: 7 }, // no history → erase
  ]);
  assert.deepEqual(out, [
    { x: 1, y: 1, color: 3 },
    { x: 2, y: 2, color: 0 },
    { x: 7, y: 7, color: 0 },
  ]);
});

test("computeRestoreCells: rebuilds cells from the durable top-of-stack", () => {
  const log = [p(1, 1, 3, 10, "alice"), p(1, 1, 5, 20, "bob")];
  // Restore re-asserts what history says is on top (bob's 5), undoing a wipe.
  assert.deepEqual(computeRestoreCells(log, [{ x: 1, y: 1 }, { x: 4, y: 4 }]), [
    { x: 1, y: 1, color: 5 },
    { x: 4, y: 4, color: 0 },
  ]);
});

test("groupByCell: sorts each cell's stack ascending by version", () => {
  const groups = groupByCell([p(0, 0, 1, 30), p(0, 0, 2, 10), p(0, 0, 3, 20)]);
  assert.deepEqual(
    groups.get("0,0")!.map((r) => r.version),
    [10, 20, 30],
  );
});

test("sortCells: deterministic row-major (y then x)", () => {
  const out = sortCells([
    { x: 2, y: 1, color: 1 },
    { x: 1, y: 1, color: 1 },
    { x: 0, y: 0, color: 1 },
  ]);
  assert.deepEqual(out, [
    { x: 0, y: 0, color: 1 },
    { x: 1, y: 1, color: 1 },
    { x: 2, y: 1, color: 1 },
  ]);
});
