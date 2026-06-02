import { test } from "node:test";
import assert from "node:assert/strict";
import { ViewTransform } from "./view.ts";

/** Continuous board coordinate under a device pixel (the invariant zoom must preserve). */
function boardCoord(v: ViewTransform, dx: number, dy: number): [number, number] {
  return [(dx - v.tx) / v.scale, (dy - v.ty) / v.scale];
}

test("fit centres the board and keeps it inside the viewport", () => {
  const v = new ViewTransform();
  v.setBoard(500, 500);
  v.setViewport(1000, 800);
  v.fit();
  // limiting dimension is height: 800/500 * 0.98
  assert.ok(Math.abs(v.scale - (800 / 500) * 0.98) < 1e-9);
  assert.ok(v.width * v.scale <= 1000 + 1e-9);
  assert.ok(v.height * v.scale <= 800 + 1e-9);
  // centred
  assert.ok(Math.abs(v.tx - (1000 - 500 * v.scale) / 2) < 1e-9);
  assert.ok(Math.abs(v.ty - (800 - 500 * v.scale) / 2) < 1e-9);
});

test("zoomAt keeps the board point under the cursor fixed (CA3 zoom feel)", () => {
  const v = new ViewTransform();
  v.setBoard(500, 500);
  v.setViewport(1000, 800);
  v.fit();
  const cx = 620;
  const cy = 410;
  const before = boardCoord(v, cx, cy);
  v.zoomAt(cx, cy, 3.2); // zoom in
  const after = boardCoord(v, cx, cy);
  assert.ok(Math.abs(before[0] - after[0]) < 1e-6, `x drifted: ${before[0]} -> ${after[0]}`);
  assert.ok(Math.abs(before[1] - after[1]) < 1e-6, `y drifted: ${before[1]} -> ${after[1]}`);
});

test("cannot zoom out past the fit scale", () => {
  const v = new ViewTransform();
  v.setBoard(500, 500);
  v.setViewport(1000, 800);
  v.fit();
  const fit = v.scale;
  v.zoomAt(500, 400, 0.01); // try to zoom way out
  assert.equal(v.scale, fit);
});

test("panning is clamped so the board never leaves the viewport", () => {
  const v = new ViewTransform();
  v.setBoard(500, 500);
  v.setViewport(1000, 800);
  v.fit();
  v.zoomAt(500, 400, 6); // zoom in so the board overflows the viewport
  v.panBy(100000, 100000); // yank it far
  const cw = v.width * v.scale;
  const ch = v.height * v.scale;
  assert.ok(v.tx <= 0 + 1e-9 && v.tx >= 1000 - cw - 1e-9, `tx ${v.tx} out of [${1000 - cw}, 0]`);
  assert.ok(v.ty <= 0 + 1e-9 && v.ty >= 800 - ch - 1e-9, `ty ${v.ty} out of [${800 - ch}, 0]`);
});

test("fitRegion frames a sub-region and centres it (OBS cadrage)", () => {
  const v = new ViewTransform();
  v.setBoard(500, 500);
  v.setViewport(800, 800);
  v.fitRegion(100, 100, 100, 100); // a 100x100 window centred at (150,150)
  // scale fills the square viewport with the square region (×0.98 margin)
  assert.ok(Math.abs(v.scale - (800 / 100) * 0.98) < 1e-9);
  // region centre lands at the viewport centre
  assert.ok(Math.abs(v.tx + 150 * v.scale - 400) < 1e-6);
  assert.ok(Math.abs(v.ty + 150 * v.scale - 400) < 1e-6);
});

test("fitRegion falls back to whole-board fit for a degenerate region", () => {
  const v = new ViewTransform();
  v.setBoard(500, 500);
  v.setViewport(800, 800);
  v.fitRegion(0, 0, 0, 0);
  assert.ok(Math.abs(v.scale - (800 / 500) * 0.98) < 1e-9);
});

test("setFixedScale honours the zoom but never below the fit floor", () => {
  const v = new ViewTransform();
  v.setBoard(500, 500);
  v.setViewport(800, 800);
  v.setFixedScale(4); // 4 px/cell -> board (2000px) overflows the viewport
  assert.equal(v.scale, 4);
  // a too-small fixed zoom is lifted to the fit scale (no gaps)
  v.setFixedScale(0.1);
  assert.ok(Math.abs(v.scale - (800 / 500) * 0.98) < 1e-9);
});

test("cellAt floors to integer cells and rejects out-of-bounds", () => {
  const v = new ViewTransform();
  v.setBoard(500, 500);
  v.setViewport(1000, 1000);
  v.fit();
  // device pixel at the board's top-left corner maps to cell (0,0)
  const tl = v.cellAt(v.tx + 0.5 * v.scale, v.ty + 0.5 * v.scale);
  assert.deepEqual(tl, { x: 0, y: 0 });
  // just outside the board (left of tx) -> null
  assert.equal(v.cellAt(v.tx - 1, v.ty + 1), null);
  // far beyond the right edge -> null
  assert.equal(v.cellAt(v.tx + 500 * v.scale + 1, v.ty + 1), null);
});
