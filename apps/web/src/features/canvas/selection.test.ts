/**
 * Tests for the FEN-113 batch-selection controller — the Definition-of-Done
 * surface for the "sélection multiple → validation" pose model.
 *   node --test apps/web/src/features/canvas/selection.test.ts
 *
 * Covers the acceptance criteria:
 *   - stage N cells (≤ gauge), multi-colour + eraser, in one batch
 *   - toggle off, recolor, clear, express 1-cell path
 *   - hard cap at the gauge ceiling (k/N); recolor/deselect never cap-gated
 *   - blocking state during selection locks adds + commit but KEEPS the batch
 *   - cap recompute keeps surplus cells (server resolves overflow at commit)
 *   - committing the batch through the real OptimisticPlacement reconciles
 *     per `cid` with partial server refusal (one cell rejected, rest kept)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BatchSelection, EMPTY_COLOR } from "./selection.ts";
import { OptimisticPlacement, type PlacementSurface } from "./placement.ts";
import type { GaugeState } from "@canvas/protocol";

test("stages N multi-colour + eraser cells in one batch (k/N)", () => {
  const sel = new BatchSelection(5);
  assert.equal(sel.apply(0, 0, 3).kind, "added");
  assert.equal(sel.apply(1, 0, 7).kind, "added"); // a different colour
  assert.equal(sel.apply(2, 0, EMPTY_COLOR).kind, "added"); // eraser
  assert.equal(sel.count, 3);
  assert.equal(sel.capacity, 5);
  const entries = sel.entries();
  assert.deepEqual(
    entries,
    [
      { x: 0, y: 0, color: 3 },
      { x: 1, y: 0, color: 7 },
      { x: 2, y: 0, color: EMPTY_COLOR },
    ],
    "insertion-ordered, colours preserved per cell",
  );
});

test("re-tap with same tool toggles the cell off; different tool recolors", () => {
  const sel = new BatchSelection(5);
  sel.apply(4, 4, 5);
  // same colour → removed
  assert.deepEqual(sel.apply(4, 4, 5), { kind: "removed", x: 4, y: 4 });
  assert.equal(sel.count, 0);
  // re-add, then recolor with a different tool
  sel.apply(4, 4, 5);
  const r = sel.apply(4, 4, 9);
  assert.equal(r.kind, "recolored");
  assert.equal(sel.colorAt(4, 4), 9);
  assert.equal(sel.count, 1, "recolor does not grow the count");
});

test("hard cap at the gauge ceiling; recolor/deselect stay allowed at cap", () => {
  const sel = new BatchSelection(2);
  assert.equal(sel.apply(0, 0, 1).kind, "added");
  assert.equal(sel.apply(1, 0, 1).kind, "added");
  assert.equal(sel.canAddMore, false);
  // a NEW cell is refused (hard cap)
  assert.deepEqual(sel.apply(2, 0, 1), { kind: "cap", cap: 2 });
  assert.equal(sel.count, 2);
  // but recoloring an existing cell at cap is fine
  assert.equal(sel.apply(0, 0, 4).kind, "recolored");
  // and deselecting at cap is fine, then a new add fits again
  assert.equal(sel.apply(1, 0, 1).kind, "removed");
  assert.equal(sel.apply(2, 0, 1).kind, "added");
  assert.equal(sel.count, 2);
});

test("express 1-cell path: one tap then take() yields a single cell", () => {
  const sel = new BatchSelection(6);
  sel.apply(8, 8, 2);
  const out = sel.take();
  assert.deepEqual(out, [{ x: 8, y: 8, color: 2 }]);
  assert.equal(sel.count, 0, "take() clears the batch");
});

test("clear empties the batch; take() on empty is a no-op", () => {
  const sel = new BatchSelection(6);
  sel.apply(1, 1, 1);
  sel.clear();
  assert.equal(sel.isEmpty, true);
  assert.deepEqual(sel.take(), []);
});

test("locked canvas refuses new adds + commit but KEEPS the staged batch", () => {
  const sel = new BatchSelection(6);
  sel.apply(0, 0, 1);
  sel.apply(1, 1, 2);
  sel.setLocked(true);
  // new add refused
  assert.deepEqual(sel.apply(2, 2, 3), { kind: "locked" });
  // commit refused, batch preserved
  assert.deepEqual(sel.take(), []);
  assert.equal(sel.count, 2, "staged work not lost while locked");
  // unlocking restores commit
  sel.setLocked(false);
  assert.equal(sel.take().length, 2);
});

test("locked still allows toggling-off / recoloring existing staged cells", () => {
  const sel = new BatchSelection(6);
  sel.apply(0, 0, 1);
  sel.setLocked(true);
  assert.equal(sel.apply(0, 0, 4).kind, "recolored");
  assert.equal(sel.apply(0, 0, 4).kind, "removed");
});

test("shrinking the cap keeps already-staged surplus (server resolves overflow)", () => {
  const sel = new BatchSelection(5);
  for (let i = 0; i < 5; i++) sel.apply(i, 0, 1);
  assert.equal(sel.count, 5);
  sel.setCapacity(2); // a charge was spent elsewhere
  assert.equal(sel.count, 5, "surplus not trimmed");
  assert.equal(sel.canAddMore, false);
  assert.deepEqual(sel.apply(9, 9, 1), { kind: "cap", cap: 2 });
});

test("growing the cap immediately allows more cells (claimed tier — Lot D)", () => {
  const sel = new BatchSelection(1);
  sel.apply(0, 0, 1);
  assert.equal(sel.canAddMore, false);
  sel.setCapacity(3);
  assert.equal(sel.canAddMore, true);
  assert.equal(sel.apply(1, 0, 1).kind, "added");
});

// --- batch commit integration: per-`cid` reconciliation w/ partial refusal ---

const W = 64;
const H = 64;
const PALETTE = 32;

function makeSurface(): PlacementSurface & { at(x: number, y: number): number } {
  const px = new Map<string, number>();
  const k = (x: number, y: number) => `${x},${y}`;
  return {
    getPixel: (x, y) => px.get(k(x, y)) ?? EMPTY_COLOR,
    setPixel: (x, y, c) => void px.set(k(x, y), c),
    at: (x, y) => px.get(k(x, y)) ?? EMPTY_COLOR,
  };
}

test("batch commit places one cid per cell and handles partial server refusal", () => {
  const surface = makeSurface();
  let n = 0;
  const ctrl = new OptimisticPlacement({
    width: W,
    height: H,
    paletteSize: PALETTE,
    surface,
    genCid: () => `op-${++n}`,
    blockWhenEmpty: false,
  });

  const sel = new BatchSelection(3);
  sel.apply(0, 0, 5);
  sel.apply(1, 0, 6);
  sel.apply(2, 0, EMPTY_COLOR); // erase

  // Commit: feed each staged cell to the optimistic controller (one place/cell).
  const msgs = sel.take().map((e) => ctrl.place(e.x, e.y, e.color));
  assert.equal(msgs.every((m) => m && m.t === "place"), true);
  const cids = msgs.map((m) => m!.cid);
  assert.equal(new Set(cids).size, 3, "one distinct cid per cell");
  assert.equal(ctrl.pendingCount, 3);
  // all three painted optimistically
  assert.equal(surface.at(0, 0), 5);
  assert.equal(surface.at(1, 0), 6);
  assert.equal(surface.at(2, 0), EMPTY_COLOR);

  const gauge: GaugeState = { charges: 1, max: 3, cooldownUntil: 0 };
  // cell 0 acked (kept), cell 1 refused (rolled back), cell 2 acked (kept)
  ctrl.handle({ t: "ack", cid: cids[0]!, charges: gauge.charges, max: gauge.max, cooldownUntil: 0 });
  ctrl.handle({ t: "error", code: "rate_limited", message: "", cid: cids[1]! });
  ctrl.handle({ t: "ack", cid: cids[2]!, charges: 0, max: gauge.max, cooldownUntil: 0 });

  assert.equal(ctrl.pendingCount, 0, "all cids reconciled");
  assert.equal(surface.at(0, 0), 5, "acked cell kept");
  assert.equal(surface.at(1, 0), EMPTY_COLOR, "refused cell rolled back to base");
  assert.equal(surface.at(2, 0), EMPTY_COLOR, "acked erase kept");
});
