/**
 * Acceptance tests for the F2 canvas rules (FEN-12).
 * Runs under Node's built-in test runner with native TS type-stripping —
 * no Convex runtime, no dependency install required:
 *
 *   node --test apps/convex/convex/lib/canvasRules.test.ts
 *
 * These cover the pure decision logic behind the cahier §F2 acceptance criteria.
 * The DB-orchestration pieces (one-active-per-owner on create/activate) live in
 * ../canvases.ts and are exercised end-to-end at `convex dev` / deploy time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConvexError } from "convex/values";
import {
  ALLOWED_DIMENSIONS,
  DEFAULT_DIMENSION,
  MAX_DIMENSION,
  MIN_DIMENSION,
  assertResizeAllowed,
  assertValidDimensions,
  assertValidEventWindow,
  assertValidSlug,
  canvasesToDemote,
  countOutOfBounds,
  evaluatePlacement,
  isReservedSlug,
  isWithinEventWindow,
  latestCellsFromPlacements,
  matchesPersonalSlug,
  personalBaseSlug,
  slugify,
  type CanvasShape,
  type LatestCell,
} from "./canvasRules.ts";

function canvas(over: Partial<CanvasShape> = {}): CanvasShape {
  return {
    ownerId: "owner_1",
    width: 100,
    height: 100,
    status: "active",
    placementOpen: true,
    eventStartAt: null,
    eventEndAt: null,
    cellCount: 0,
    ...over,
  };
}

function ruleCode(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    assert.ok(e instanceof ConvexError, `expected ConvexError, got ${e}`);
    return (e as ConvexError).data as string;
  }
}

// ── Dimensions ───────────────────────────────────────────────────────────────
test("dimensions: default is 10×10, MIN is 10, whitelist is [10,20,50,100]", () => {
  assert.equal(DEFAULT_DIMENSION, 10);
  assert.equal(MIN_DIMENSION, 10);
  assert.deepEqual([...ALLOWED_DIMENSIONS], [10, 20, 50, 100]);
  // All whitelist sizes are valid squares
  assert.doesNotThrow(() => assertValidDimensions(10, 10));
  assert.doesNotThrow(() => assertValidDimensions(20, 20));
  assert.doesNotThrow(() => assertValidDimensions(50, 50));
  assert.doesNotThrow(() => assertValidDimensions(100, 100));
});

test("dimensions: whitelist — only [10,20,50,100] squares accepted, others rejected", () => {
  // Not in whitelist
  assert.equal(ruleCode(() => assertValidDimensions(16, 16)), "invalid_dimensions");
  assert.equal(ruleCode(() => assertValidDimensions(250, 250)), "invalid_dimensions");
  assert.equal(ruleCode(() => assertValidDimensions(MAX_DIMENSION, MAX_DIMENSION)), "invalid_dimensions"); // 512 is engine bound, not user-facing
  // Not square (even if values are individually in the whitelist)
  assert.equal(ruleCode(() => assertValidDimensions(50, 100)), "invalid_dimensions");
  assert.equal(ruleCode(() => assertValidDimensions(10, 20)), "invalid_dimensions");
  // Non-integer
  assert.equal(ruleCode(() => assertValidDimensions(50.5, 50.5)), "invalid_dimensions");
  assert.equal(ruleCode(() => assertValidDimensions(0, 0)), "invalid_dimensions");
});

// ── Slug ─────────────────────────────────────────────────────────────────────
test("slug: validation and slugify", () => {
  assert.doesNotThrow(() => assertValidSlug("pixelqueen"));
  assert.doesNotThrow(() => assertValidSlug("my-canvas-2"));
  assert.equal(ruleCode(() => assertValidSlug("-bad")), "invalid_slug");
  assert.equal(ruleCode(() => assertValidSlug("UPPER")), "invalid_slug");
  assert.equal(slugify("PixelQueen!! 2026"), "pixelqueen-2026");
  assert.equal(slugify("Café  Crème"), "cafe-creme");
});

// ── CA1: a fresh canvas is active and allows placement ───────────────────────
test("CA1 — a fresh active canvas allows placement (DEFAULT_DIMENSION is now 10)", () => {
  assert.equal(DEFAULT_DIMENSION, 10); // createCanvas without args now defaults to 10×10
  const c = canvas(); // helper uses 100×100 (still valid whitelist size)
  assert.equal(c.status, "active");
  assert.equal(evaluatePlacement(c, { isOwner: false, now: 0 }).allowed, true);
});

// ── CA2: activating/creating a canvas archives the previously-active one ─────
test("CA2 — creating a new active canvas demotes the current active one", () => {
  // owner already has one active canvas (a); the new canvas is not yet stored,
  // so targetId = null → every active canvas is demoted.
  const owned = [
    { id: "a", status: "active" as const },
    { id: "b", status: "archived" as const },
  ];
  assert.deepEqual(canvasesToDemote(owned, null), ["a"]);
});

test("CA2 — activating an archived canvas demotes the other active one, not itself", () => {
  const owned = [
    { id: "a", status: "active" as const }, // currently active
    { id: "b", status: "archived" as const }, // being activated
  ];
  assert.deepEqual(canvasesToDemote(owned, "b"), ["a"]);
  // activating the already-active one demotes nothing
  assert.deepEqual(canvasesToDemote(owned, "a"), []);
  // defensive: multiple stragglers are all demoted
  assert.deepEqual(
    canvasesToDemote(
      [
        { id: "a", status: "active" },
        { id: "x", status: "active" },
        { id: "b", status: "archived" },
      ],
      "b",
    ),
    ["a", "x"],
  );
});

// ── CA3: an archived canvas refuses ALL placement, even the owner ────────────
test("CA3 — archived canvas refuses placement, including the owner", () => {
  const c = canvas({ status: "archived" });
  assert.deepEqual(evaluatePlacement(c, { isOwner: false, now: 0 }), {
    allowed: false,
    reason: "canvas_archived",
  });
  assert.deepEqual(evaluatePlacement(c, { isOwner: true, now: 0 }), {
    allowed: false,
    reason: "canvas_archived",
  });
});

test("freeze — placementOpen=false refuses everyone (emergency freeze)", () => {
  const c = canvas({ placementOpen: false });
  assert.equal(evaluatePlacement(c, { isOwner: false, now: 0 }).reason, "placement_closed");
  assert.equal(evaluatePlacement(c, { isOwner: true, now: 0 }).reason, "placement_closed");
});

// ── F8 ban (FEN-132): a banned user is refused before the click ──────────────
test("F8 — a banned user is refused with reason 'banned'", () => {
  const open = canvas({ eventStartAt: null, eventEndAt: null });
  // banned non-owner on an otherwise-placeable canvas → denied
  assert.deepEqual(evaluatePlacement(open, { isOwner: false, isBanned: true, now: 0 }), {
    allowed: false,
    reason: "banned",
  });
  // not banned → allowed (default / explicit false both work)
  assert.equal(evaluatePlacement(open, { isOwner: false, now: 0 }).allowed, true);
  assert.equal(evaluatePlacement(open, { isOwner: false, isBanned: false, now: 0 }).allowed, true);
});

test("F8 — ban order: archive outranks ban; ban outranks freeze and window", () => {
  // archive is the hardest state and wins even over a ban
  const archived = canvas({ status: "archived" });
  assert.equal(
    evaluatePlacement(archived, { isOwner: false, isBanned: true, now: 0 }).reason,
    "canvas_archived",
  );
  // ban is reported ahead of a freeze and an event-window miss (most relevant per-user)
  const frozen = canvas({ placementOpen: false });
  assert.equal(
    evaluatePlacement(frozen, { isOwner: false, isBanned: true, now: 0 }).reason,
    "banned",
  );
  const windowed = canvas({ eventStartAt: 1000, eventEndAt: 2000 });
  assert.equal(
    evaluatePlacement(windowed, { isOwner: false, isBanned: true, now: 500 }).reason,
    "banned",
  );
});

// ── CA4: outside the event window, viewers are refused, the owner may test ───
test("CA4 — outside the event window viewer is refused, owner is allowed", () => {
  const c = canvas({ eventStartAt: 1000, eventEndAt: 2000 });
  // before window
  assert.equal(evaluatePlacement(c, { isOwner: false, now: 500 }).reason, "outside_event_window");
  assert.equal(evaluatePlacement(c, { isOwner: true, now: 500 }).allowed, true);
  // after window
  assert.equal(evaluatePlacement(c, { isOwner: false, now: 2000 }).reason, "outside_event_window");
  // inside window: viewer allowed
  assert.equal(evaluatePlacement(c, { isOwner: false, now: 1500 }).allowed, true);
  // open-ended window (no end)
  assert.equal(isWithinEventWindow({ eventStartAt: 1000, eventEndAt: null }, 5000), true);
});

test("event window: end must be after start", () => {
  assert.doesNotThrow(() => assertValidEventWindow(1000, 2000));
  assert.doesNotThrow(() => assertValidEventWindow(null, null));
  assert.equal(ruleCode(() => assertValidEventWindow(2000, 1000)), "invalid_event_window");
});

// ── CA5: assertResizeAllowed enforces only the whitelist (FEN-1798) ───────────
// The hard "shrink forbidden on non-empty" block was removed in FEN-1798.
// Shrinks now trigger a confirmation flow via countOutOfBounds in updateCanvasConfig.
test("CA5 — assertResizeAllowed only enforces the dimension whitelist (FEN-1798)", () => {
  // Empty canvas: any valid size is allowed
  const empty = canvas({ width: 100, height: 100, cellCount: 0 });
  assert.doesNotThrow(() => assertResizeAllowed(empty, 50, 50));
  assert.doesNotThrow(() => assertResizeAllowed(empty, 10, 10));

  // Non-empty canvas: shrink is now allowed at the rule level (confirmation handled upstream)
  const drawn = canvas({ width: 100, height: 100, cellCount: 42 });
  assert.doesNotThrow(() => assertResizeAllowed(drawn, 50, 50));
  assert.doesNotThrow(() => assertResizeAllowed(drawn, 10, 10));

  // Same dimensions: allowed
  assert.doesNotThrow(() => assertResizeAllowed(drawn, 100, 100));

  // Invalid dimensions still throw (whitelist guard stays)
  assert.equal(ruleCode(() => assertResizeAllowed(drawn, 30, 30)), "invalid_dimensions");
  assert.equal(ruleCode(() => assertResizeAllowed(drawn, 50, 100)), "invalid_dimensions"); // not square
});

test("CA5 — enlarging a non-empty canvas is allowed (FEN-1790)", () => {
  const drawn = canvas({ width: 10, height: 10, cellCount: 7 });
  assert.doesNotThrow(() => assertResizeAllowed(drawn, 20, 20));
  assert.doesNotThrow(() => assertResizeAllowed(drawn, 50, 50));
  assert.doesNotThrow(() => assertResizeAllowed(drawn, 100, 100));
});

// ── countOutOfBounds (FEN-1798/C-A) ──────────────────────────────────────────
function cells(list: Array<[number, number, number]>): LatestCell[] {
  return list.map(([x, y, color]) => ({ x, y, color }));
}

test("countOutOfBounds — empty cell list → 0", () => {
  assert.equal(countOutOfBounds([], 10, 10), 0);
});

test("countOutOfBounds — all cells in bounds → 0", () => {
  assert.equal(countOutOfBounds(cells([[0, 0, 1], [9, 9, 2], [5, 5, 3]]), 10, 10), 0);
});

test("countOutOfBounds — x=W and y=H are out of bounds (exclusive upper bound)", () => {
  // Cells at exactly x=10 or y=10 are outside a 10×10 canvas
  assert.equal(
    countOutOfBounds(cells([[10, 0, 1], [0, 10, 1], [9, 9, 1]]), 10, 10),
    2,
  );
});

test("countOutOfBounds — erased cells (color=0) at OOB coords are not counted", () => {
  assert.equal(
    countOutOfBounds(cells([[10, 5, 0], [5, 10, 0], [3, 3, 1]]), 10, 10),
    0,
  );
});

test("countOutOfBounds — mixed in/out of bounds → correct K", () => {
  // 3 OOB painted cells, 2 in-bounds painted cells
  assert.equal(
    countOutOfBounds(
      cells([[0, 0, 1], [9, 9, 1], [10, 0, 1], [0, 10, 1], [15, 15, 2]]),
      10, 10,
    ),
    3,
  );
});

test("countOutOfBounds — shrink 20→10: cells in rows/cols 10-19 are OOB", () => {
  const c = cells([
    [0, 0, 1], [9, 9, 1],   // in bounds after shrink to 10×10
    [10, 0, 1], [0, 10, 1], // out of bounds
    [19, 19, 1],             // out of bounds
  ]);
  assert.equal(countOutOfBounds(c, 10, 10), 3);
});

test("countOutOfBounds — enlargement 10→20: K is always 0 (no existing cell exceeds old bounds)", () => {
  // All cells from a 10×10 canvas stay in bounds of a 20×20 canvas
  const c = cells([[0, 0, 1], [9, 9, 1], [5, 5, 1]]);
  assert.equal(countOutOfBounds(c, 20, 20), 0);
});

// ── FEN-484: matchesPersonalSlug — idempotence predicate for personal canvases ─
test("matchesPersonalSlug — non-reserved login: exact slug matches", () => {
  assert.equal(matchesPersonalSlug("streamer42", "streamer42"), true);
});

test("matchesPersonalSlug — non-reserved login: no false positive on unrelated slug", () => {
  assert.equal(matchesPersonalSlug("streamer42-other", "streamer42"), false);
  assert.equal(matchesPersonalSlug("streamer42-abc", "streamer42"), false);
  assert.equal(matchesPersonalSlug("otherperson", "streamer42"), false);
});

test("matchesPersonalSlug — reserved login: baseSlug exact match (login-canvas)", () => {
  // login = "admin" → baseSlug = "admin-canvas"
  assert.equal(matchesPersonalSlug("admin-canvas", "admin-canvas"), true);
});

test("matchesPersonalSlug — reserved login: numeric-suffix variants match (AC-1)", () => {
  assert.equal(matchesPersonalSlug("admin-canvas-2", "admin-canvas"), true);
  assert.equal(matchesPersonalSlug("admin-canvas-3", "admin-canvas"), true);
  assert.equal(matchesPersonalSlug("admin-canvas-99", "admin-canvas"), true);
});

test("matchesPersonalSlug — reserved login: non-numeric suffix does NOT match", () => {
  assert.equal(matchesPersonalSlug("admin-canvas-abc", "admin-canvas"), false);
  assert.equal(matchesPersonalSlug("admin-canvas-2x", "admin-canvas"), false);
});

test("matchesPersonalSlug — slug collision: baseSlug is already suffixed (AC-3)", () => {
  // Collision: login = "foo", base = "foo", but "foo" taken → slug = "foo-2"
  assert.equal(matchesPersonalSlug("foo-2", "foo"), true);
  assert.equal(matchesPersonalSlug("foo-10", "foo"), true);
  assert.equal(matchesPersonalSlug("foo", "foo"), true);
  assert.equal(matchesPersonalSlug("foobar", "foo"), false);
});

// ── isReservedSlug ────────────────────────────────────────────────────────────
test("isReservedSlug — known reserved slugs are rejected", () => {
  assert.equal(isReservedSlug("admin"), true);
  assert.equal(isReservedSlug("me"), true);
  assert.equal(isReservedSlug("default"), true);
  assert.equal(isReservedSlug("studio"), true);
  assert.equal(isReservedSlug("obs"), true);
});

test("isReservedSlug — case-insensitive (B6)", () => {
  assert.equal(isReservedSlug("ADMIN"), true);
  assert.equal(isReservedSlug("Me"), true);
});

test("isReservedSlug — regular login is not reserved", () => {
  assert.equal(isReservedSlug("streamer42"), false);
  assert.equal(isReservedSlug("fenysk"), false);
});

// ── personalBaseSlug ──────────────────────────────────────────────────────────
test("personalBaseSlug — non-reserved login returns login as-is", () => {
  assert.equal(personalBaseSlug("streamer42"), "streamer42");
  assert.equal(personalBaseSlug("fenysk"), "fenysk");
});

test("personalBaseSlug — reserved login gets -canvas suffix (B3 edge)", () => {
  assert.equal(personalBaseSlug("admin"), "admin-canvas");
  assert.equal(personalBaseSlug("me"), "me-canvas");
  assert.equal(personalBaseSlug("default"), "default-canvas");
  assert.equal(personalBaseSlug("studio"), "studio-canvas");
});

// ── latestCellsFromPlacements ─────────────────────────────────────────────────
type PlacementRow = { x: number; y: number; color: number; version: number };

function plaRow(x: number, y: number, color: number, version: number): PlacementRow {
  return { x, y, color, version };
}

test("latestCellsFromPlacements — empty rows → empty result", () => {
  assert.deepEqual(latestCellsFromPlacements([]), []);
});

test("latestCellsFromPlacements — single row is returned as-is", () => {
  const result = latestCellsFromPlacements([plaRow(3, 5, 7, 1)]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { x: 3, y: 5, color: 7, version: 1 });
});

test("latestCellsFromPlacements — higher version wins per cell", () => {
  const rows = [
    plaRow(0, 0, 1, 1),
    plaRow(0, 0, 2, 3), // supersedes version 1
    plaRow(0, 0, 5, 2), // ignored (version 2 < 3)
  ];
  const result = latestCellsFromPlacements(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.color, 2);
  assert.equal(result[0]!.version, 3);
});

test("latestCellsFromPlacements — distinct cells are kept independently", () => {
  const rows = [
    plaRow(0, 0, 1, 1),
    plaRow(1, 0, 2, 1),
    plaRow(0, 1, 3, 1),
  ];
  const result = latestCellsFromPlacements(rows);
  assert.equal(result.length, 3);
});

test("latestCellsFromPlacements — erased cells (color=0) are preserved in output (filtering is caller's concern)", () => {
  // The function does NOT filter out erased cells; countOutOfBounds and cellCount callers do.
  const rows = [plaRow(2, 2, 0, 5)];
  const result = latestCellsFromPlacements(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.color, 0);
});

test("latestCellsFromPlacements — correctly counts occupied cells (mirrors worker usage)", () => {
  const rows = [
    plaRow(0, 0, 1, 1),
    plaRow(1, 1, 0, 2), // erased
    plaRow(2, 2, 3, 1),
    plaRow(0, 0, 4, 3), // overpaints (0,0)
  ];
  const occupied = latestCellsFromPlacements(rows).filter((c) => c.color > 0).length;
  assert.equal(occupied, 2); // (0,0) repainted + (2,2), (1,1) erased
});

