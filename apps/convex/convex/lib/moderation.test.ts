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
  groupCellsAt,
  GROUP_WINDOW_MS,
  sortPlans,
  authorOfTop,
  planModeratorSync,
  planPreview,
  MOD_PREVIEW_MAX_CELLS,
  type PlacementRow,
  type ModRow,
} from "./moderation.ts";

// Helper: terse placement literal.
const p = (x: number, y: number, color: number, version: number, userId?: string): PlacementRow => ({
  x,
  y,
  color,
  version,
  userId,
});

// Helper: placement with a wall-clock ts (for the S8.4 batch-grouping tests).
const pt = (
  x: number,
  y: number,
  color: number,
  version: number,
  userId: string | undefined,
  ts: number,
): PlacementRow => ({ x, y, color, version, userId, ts });

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

// ─── S8.4 / gap G2: groupCellsAt (simultaneous-batch resolution) ──────────────

test("groupCellsAt: gathers the anchor author's same-burst cells, sorted row-major", () => {
  // alice's burst at t≈1000 (3 cells) + a later burst at t≈9000 (1 cell);
  // bob owns one cell in alice's time-window. Clicking any alice burst-1 cell
  // returns exactly alice's 3 burst-1 cells, not bob's, not her later burst.
  const log = [
    pt(1, 1, 5, 10, "alice", 1000),
    pt(2, 1, 5, 11, "alice", 1100),
    pt(3, 1, 5, 12, "alice", 1200),
    pt(9, 9, 7, 13, "bob", 1150),
    pt(1, 1, 6, 40, "alice", 9000), // alice repaints (1,1) in a later burst
    pt(5, 5, 5, 41, "alice", 9100),
  ];
  const { authorUserId, cells } = groupCellsAt(log, { x: 2, y: 1 });
  assert.equal(authorUserId, "alice");
  // (1,1)'s top is now the t=9000 repaint → it belongs to the LATER burst, so the
  // burst anchored at (2,1) t=1100 is just (2,1) and (3,1).
  assert.deepEqual(cells, [
    { x: 2, y: 1 },
    { x: 3, y: 1 },
  ]);
});

test("groupCellsAt: clicking the later burst returns the later burst's cells", () => {
  const log = [
    pt(2, 1, 5, 11, "alice", 1100),
    pt(1, 1, 6, 40, "alice", 9000),
    pt(5, 5, 5, 41, "alice", 9100),
  ];
  assert.deepEqual(groupCellsAt(log, { x: 1, y: 1 }).cells, [
    { x: 1, y: 1 },
    { x: 5, y: 5 },
  ]);
});

test("groupCellsAt: empty/erased/anonymous anchor → no target", () => {
  assert.deepEqual(groupCellsAt([], { x: 0, y: 0 }), { authorUserId: null, cells: [] });
  const erased = [pt(1, 1, 5, 10, "alice", 1000), pt(1, 1, 0, 20, "alice", 1100)];
  assert.deepEqual(groupCellsAt(erased, { x: 1, y: 1 }), { authorUserId: null, cells: [] });
  const anon = [pt(1, 1, 5, 10, undefined, 1000)];
  assert.deepEqual(groupCellsAt(anon, { x: 1, y: 1 }), { authorUserId: null, cells: [] });
});

test("groupCellsAt: legacy rows without ts are not grouped (anchor or members)", () => {
  // Anchor lacks ts → no target.
  assert.deepEqual(groupCellsAt([p(1, 1, 5, 10, "alice")], { x: 1, y: 1 }), {
    authorUserId: null,
    cells: [],
  });
  // A same-author member lacking ts is skipped, the timed anchor still returns itself.
  const mixed = [pt(1, 1, 5, 10, "alice", 1000), p(2, 1, 5, 11, "alice")];
  assert.deepEqual(groupCellsAt(mixed, { x: 1, y: 1 }).cells, [{ x: 1, y: 1 }]);
});

test("groupCellsAt: only currently-visible tops join the batch", () => {
  // alice placed (2,1) in the burst but bob later painted over it → (2,1)'s top
  // is bob's, so it is NOT part of alice's wipeable group.
  const log = [
    pt(1, 1, 5, 10, "alice", 1000),
    pt(2, 1, 5, 11, "alice", 1100),
    pt(2, 1, 8, 30, "bob", 1150),
  ];
  assert.deepEqual(groupCellsAt(log, { x: 1, y: 1 }).cells, [{ x: 1, y: 1 }]);
});

test("groupCellsAt: window boundary — just inside joins, just outside splits", () => {
  const log = [
    pt(1, 1, 5, 10, "alice", 1000),
    pt(2, 1, 5, 11, "alice", 1000 + GROUP_WINDOW_MS), // exactly at the edge → in
    pt(3, 1, 5, 12, "alice", 1000 + GROUP_WINDOW_MS + 1), // 1ms past → out
  ];
  assert.deepEqual(groupCellsAt(log, { x: 1, y: 1 }).cells, [
    { x: 1, y: 1 },
    { x: 2, y: 1 },
  ]);
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

// ─── planModeratorSync (CA5): Twitch roster diffing ──────────────────────────

test("planModeratorSync: all incoming become toUpsert, empty roster → no deactivations", () => {
  const plan = planModeratorSync([], [{ twitchId: "t1", login: "alice" }, { twitchId: "t2" }]);
  assert.deepEqual(plan.toUpsert, [{ twitchId: "t1", login: "alice" }, { twitchId: "t2" }]);
  assert.deepEqual(plan.toDeactivate, []);
});

test("planModeratorSync: stale twitch_sync rows go to toDeactivate", () => {
  const existing: ModRow[] = [
    { twitchId: "t1", source: "twitch_sync", active: true },
    { twitchId: "t2", source: "twitch_sync", active: true },
  ];
  const plan = planModeratorSync(existing, [{ twitchId: "t1" }]);
  assert.deepEqual(plan.toDeactivate, ["t2"]);
  assert.deepEqual(plan.toUpsert, [{ twitchId: "t1" }]);
});

test("planModeratorSync: manual rows are never deactivated regardless of incoming list", () => {
  const existing: ModRow[] = [
    { twitchId: "t1", source: "manual", active: true },
    { twitchId: "t2", source: "twitch_sync", active: true },
  ];
  const plan = planModeratorSync(existing, []);
  assert.deepEqual(plan.toDeactivate, ["t2"]);
  assert.ok(!plan.toDeactivate.includes("t1"), "manual rows must be preserved");
});

test("planModeratorSync: already-inactive rows are not re-deactivated", () => {
  const existing: ModRow[] = [
    { twitchId: "t1", source: "twitch_sync", active: false },
    { twitchId: "t2", source: "twitch_sync", active: true },
  ];
  const plan = planModeratorSync(existing, [{ twitchId: "t2" }]);
  assert.deepEqual(plan.toDeactivate, []);
});

test("planModeratorSync: empty incoming, empty roster → empty plan", () => {
  const plan = planModeratorSync([], []);
  assert.deepEqual(plan.toUpsert, []);
  assert.deepEqual(plan.toDeactivate, []);
});

// ─── planPreview (FEN-2159 E3-A): format removal plans as preview responses ──

test("planPreview: empty plans → count 0, bbox null, cells [], truncated false", () => {
  assert.deepEqual(planPreview([]), { count: 0, bbox: null, cells: [], truncated: false });
});

test("planPreview: correct count / bbox / cells / truncated for small plan set", () => {
  const plans = [
    { x: 1, y: 1, removedUserId: "alice", removedColor: 5, removedVersion: 10, underneathColor: 3 },
    { x: 3, y: 2, removedUserId: "alice", removedColor: 7, removedVersion: 11, underneathColor: 0 },
  ];
  assert.deepEqual(planPreview(plans), {
    count: 2,
    bbox: { minX: 1, minY: 1, maxX: 3, maxY: 2 },
    cells: [
      { x: 1, y: 1, color: 5 },
      { x: 3, y: 2, color: 7 },
    ],
    truncated: false,
  });
});

test("planPreview: bbox spans ALL plans, not just first maxCells (AC-F4)", () => {
  // Build plans where the last element defines the bbox extremes.
  const plans = Array.from({ length: MOD_PREVIEW_MAX_CELLS + 1 }, (_, i) => ({
    x: i,
    y: 0,
    removedColor: 1,
    removedVersion: i,
    underneathColor: 0,
  }));
  const result = planPreview(plans);
  assert.equal(result.count, MOD_PREVIEW_MAX_CELLS + 1);
  assert.equal(result.truncated, true);
  assert.equal(result.cells.length, MOD_PREVIEW_MAX_CELLS);
  // bbox must cover ALL plans (including the truncated one at x = MOD_PREVIEW_MAX_CELLS)
  assert.deepEqual(result.bbox, { minX: 0, minY: 0, maxX: MOD_PREVIEW_MAX_CELLS, maxY: 0 });
});

test("planPreview(deleteGroup) ≡ planDelete(groupCellsAt(...)) — anti-divergence guard (AC-B1/B2/B3)", () => {
  // alice placed a 3-cell burst; bob's pixel underlies (1,1).
  const log = [
    pt(1, 1, 3, 5, "bob", 500),
    pt(1, 1, 5, 10, "alice", 1000),
    pt(2, 1, 6, 11, "alice", 1100),
    pt(3, 1, 7, 12, "alice", 1200),
  ];
  const anchor = { x: 1, y: 1 };
  // Exact same path as PREAUTH_prepareGroupDelete in moderation.ts.
  const { cells } = groupCellsAt(log, anchor);
  const plans = planDelete(log, cells);
  const preview = planPreview(plans);
  // preview.cells must equal plans mapped to {x,y,color=removedColor} (never 0).
  assert.deepEqual(
    preview.cells,
    plans.map((p) => ({ x: p.x, y: p.y, color: p.removedColor })),
  );
  assert.equal(preview.count, plans.length);
  assert.equal(preview.truncated, false);
  // Bbox must cover (1,1)→(3,1).
  assert.deepEqual(preview.bbox, { minX: 1, minY: 1, maxX: 3, maxY: 1 });
});

test("planPreview(ban) ≡ planWipe(...) — anti-divergence guard (AC-B1/B2/B3)", () => {
  // alice tops two cells; bob underlies (1,1).
  const log = [
    p(1, 1, 3, 5, "bob"),
    p(1, 1, 5, 10, "alice"),
    p(3, 2, 7, 11, "alice"),
  ];
  const plans = planWipe(log, "alice");
  const preview = planPreview(plans);
  assert.deepEqual(
    preview.cells,
    plans.map((q) => ({ x: q.x, y: q.y, color: q.removedColor })),
  );
  assert.equal(preview.count, 2);
  assert.equal(preview.truncated, false);
  assert.deepEqual(preview.bbox, { minX: 1, minY: 1, maxX: 3, maxY: 2 });
});
