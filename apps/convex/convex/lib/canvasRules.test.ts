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
import {
  CanvasRuleError,
  DEFAULT_DIMENSION,
  DEFAULT_PALETTE_COLORS,
  MAX_DIMENSION,
  MIN_DIMENSION,
  assertPaletteEditable,
  assertPaletteUsable,
  assertResizeAllowed,
  assertValidDimensions,
  assertValidEventWindow,
  assertValidPalette,
  assertValidSlug,
  canvasesToDemote,
  evaluatePlacement,
  isWithinEventWindow,
  matchesPersonalSlug,
  slugify,
  type CanvasShape,
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
    assert.ok(e instanceof CanvasRuleError, `expected CanvasRuleError, got ${e}`);
    return (e as CanvasRuleError).code;
  }
}

// ── Dimensions ───────────────────────────────────────────────────────────────
test("dimensions: default is 100×100 and within bounds", () => {
  assert.equal(DEFAULT_DIMENSION, 100);
  assert.doesNotThrow(() => assertValidDimensions(DEFAULT_DIMENSION, DEFAULT_DIMENSION));
  assert.doesNotThrow(() => assertValidDimensions(MIN_DIMENSION, MIN_DIMENSION));
  assert.doesNotThrow(() => assertValidDimensions(MAX_DIMENSION, MAX_DIMENSION));
});

test("dimensions: out-of-bounds and non-integers are rejected", () => {
  assert.equal(ruleCode(() => assertValidDimensions(15, 100)), "invalid_dimensions");
  assert.equal(ruleCode(() => assertValidDimensions(100, MAX_DIMENSION + 1)), "invalid_dimensions");
  assert.equal(ruleCode(() => assertValidDimensions(100.5, 100)), "invalid_dimensions");
  assert.equal(ruleCode(() => assertValidDimensions(0, 0)), "invalid_dimensions");
});

// ── Palette ──────────────────────────────────────────────────────────────────
test("palette: the system default is valid and has 16 colours (index 0 = empty)", () => {
  assert.equal(DEFAULT_PALETTE_COLORS.length, 16);
  assert.equal(DEFAULT_PALETTE_COLORS[0]?.index, 0);
  assert.doesNotThrow(() => assertValidPalette(DEFAULT_PALETTE_COLORS));
});

test("palette: size, hex, contiguity and duplicates are enforced", () => {
  assert.equal(ruleCode(() => assertValidPalette([{ index: 0, hex: "#ffffff" }])), "invalid_palette"); // < 2
  assert.equal(
    ruleCode(() => assertValidPalette([{ index: 0, hex: "#fff" }, { index: 1, hex: "#000000" }])),
    "invalid_palette", // bad hex
  );
  assert.equal(
    ruleCode(() => assertValidPalette([{ index: 0, hex: "#ffffff" }, { index: 2, hex: "#000000" }])),
    "invalid_palette", // missing index 1 (non-contiguous)
  );
  assert.equal(
    ruleCode(() => assertValidPalette([{ index: 0, hex: "#ffffff" }, { index: 0, hex: "#000000" }])),
    "invalid_palette", // duplicate index
  );
  const max = Array.from({ length: 65 }, (_, i) => ({ index: i, hex: "#000000" }));
  assert.equal(ruleCode(() => assertValidPalette(max)), "invalid_palette"); // > 64
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

// ── CA1: a fresh canvas with defaults is active ──────────────────────────────
test("CA1 — a default canvas (100×100, default palette) is active", () => {
  const c = canvas(); // mirrors createCanvas defaults
  assert.equal(c.width, 100);
  assert.equal(c.height, 100);
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

// ── CA5: resizing a non-empty canvas fails clearly ───────────────────────────
test("CA5 — resizing a canvas with pixels fails with a clear error", () => {
  const empty = canvas({ width: 100, height: 100, cellCount: 0 });
  assert.doesNotThrow(() => assertResizeAllowed(empty, 200, 200)); // empty → ok

  const drawn = canvas({ width: 100, height: 100, cellCount: 42 });
  const code = ruleCode(() => assertResizeAllowed(drawn, 200, 200));
  assert.equal(code, "resize_forbidden_non_empty");

  // same dimensions on a non-empty canvas is NOT a resize → allowed
  assert.doesNotThrow(() => assertResizeAllowed(drawn, 100, 100));

  // a clear, human-readable message is produced
  try {
    assertResizeAllowed(drawn, 200, 200);
  } catch (e) {
    assert.match((e as Error).message, /Cannot resize a canvas that already has 42 pixel/);
  }
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

// ── Palette ownership (audit 3c) ─────────────────────────────────────────────
test("assertPaletteUsable — system palette (ownerId null) is usable by anyone", () => {
  assert.equal(ruleCode(() => assertPaletteUsable({ ownerId: null }, "u1")), undefined);
});

test("assertPaletteUsable — caller's own palette is usable", () => {
  assert.equal(ruleCode(() => assertPaletteUsable({ ownerId: "u1" }, "u1")), undefined);
});

test("assertPaletteUsable — another user's palette is not_owner", () => {
  assert.equal(ruleCode(() => assertPaletteUsable({ ownerId: "u2" }, "u1")), "not_owner");
});

test("assertPaletteEditable — caller may edit their own palette", () => {
  assert.equal(ruleCode(() => assertPaletteEditable({ ownerId: "u1" }, "u1")), undefined);
});

test("assertPaletteEditable — system palette is immutable (not_owner)", () => {
  assert.equal(ruleCode(() => assertPaletteEditable({ ownerId: null }, "u1")), "not_owner");
});

test("assertPaletteEditable — another user's palette is not_owner", () => {
  assert.equal(ruleCode(() => assertPaletteEditable({ ownerId: "u2" }, "u1")), "not_owner");
});
