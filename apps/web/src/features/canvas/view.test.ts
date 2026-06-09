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

test("can zoom out past fit scale to the deep dezoom floor (AC1, FEN-383)", () => {
  const v = new ViewTransform();
  v.setBoard(500, 500);
  v.setViewport(1000, 800);
  v.fit();
  const fit = v.scale;
  // Zoom way out — should stop at DEEP_ZOOM_FACTOR × fitScale, not at fit
  v.zoomAt(500, 400, 0.0001);
  // Deep floor is well below the fit scale
  assert.ok(v.scale < fit, `scale ${v.scale} should be below fit ${fit}`);
  // But bounded at deepMin = fit * 0.15
  const deepMin = fit * 0.15;
  assert.ok(Math.abs(v.scale - deepMin) < 1e-9, `scale ${v.scale} should equal deepMin ${deepMin}`);
});

test("pan can push the board off screen — board is panned to the viewport edge (AC2, FEN-383)", () => {
  const v = new ViewTransform();
  v.setBoard(500, 500);
  v.setViewport(1000, 800);
  v.fit();
  v.zoomAt(500, 400, 6); // zoom in so the board overflows the viewport
  const cw = v.width * v.scale;
  const ch = v.height * v.scale;
  // Pan far right/down — board goes off screen but is bounded at one board-width past the edge
  v.panBy(100000, 100000);
  assert.ok(Math.abs(v.tx - 1000) < 1e-9, `tx ${v.tx} should reach the off-right bound (viewW=${1000})`);
  assert.ok(Math.abs(v.ty - 800) < 1e-9, `ty ${v.ty} should reach the off-bottom bound (visH=${800})`);
  // Pan far left/up
  v.panBy(-200000, -200000);
  assert.ok(Math.abs(v.tx - (-cw)) < 1e-9, `tx ${v.tx} should reach the off-left bound (-cw=${-cw})`);
  assert.ok(Math.abs(v.ty - (-ch)) < 1e-9, `ty ${v.ty} should reach the off-top bound (-ch=${-ch})`);
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

test("coverCenter: fills viewport (max dimension) and minScale is the deep dezoom floor (AC-R2-3, AC1/FEN-383)", () => {
  const v = new ViewTransform();
  v.cover = true;
  v.setBoard(500, 500);
  v.setViewport(390, 844); // portrait phone
  v.coverCenter();
  // Cover scale uses max(viewW/w, viewH/h) — height axis drives (844/500)
  const expectedCoverScale = 844 / 500;
  assert.ok(Math.abs(v.scale - expectedCoverScale) < 1e-9, `scale ${v.scale} != ${expectedCoverScale}`);
  // Board fills the viewport height in cover mode
  assert.ok(v.height * v.scale >= 844 - 1e-9, "board must fill viewport height");
  // minScale is the DEEP ZOOM floor (DEEP_ZOOM_FACTOR × contain), so user can zoom out past full fresco
  const containScale = Math.min(390 / 500, 844 / 500) * 0.98;
  const expectedMinScale = containScale * 0.15;
  assert.ok(Math.abs(v.minScale - expectedMinScale) < 1e-9, `minScale ${v.minScale} != deep floor ${expectedMinScale}`);
  // cover scale > minScale: the user starts zoomed in but CAN zoom out further
  assert.ok(v.scale > v.minScale, "initial cover scale should exceed deep floor");
});

test("coverCenter: can zoom out past fit-to-screen to the deep floor (AC-R2-3 + AC1/FEN-383)", () => {
  const v = new ViewTransform();
  v.cover = true;
  v.setBoard(500, 500);
  v.setViewport(390, 844);
  v.coverCenter();
  const coverScale = v.scale;
  // zoom out all the way — past contain level to deep floor
  v.zoomAt(195, 422, 0.0001);
  // should stop at minScale (deep dezoom floor), not at cover or contain scale
  assert.ok(v.scale < coverScale, "should be able to zoom below initial cover scale");
  assert.ok(Math.abs(v.scale - v.minScale) < 1e-9, "should stop at deep dezoom floor");
  // The deep floor is well below the contain level
  const containScale = Math.min(390 / 500, 844 / 500) * 0.98;
  assert.ok(v.scale < containScale, "deep floor must be below contain (fit-to-screen) level");
});

test("fit always uses contain scale regardless of cover flag (AC-R2-3)", () => {
  const v = new ViewTransform();
  v.cover = true;
  v.setBoard(500, 500);
  v.setViewport(390, 844);
  v.fit();
  // fit() always contains: min(390/500, 844/500) * 0.98
  const containScale = Math.min(390 / 500, 844 / 500) * 0.98;
  assert.ok(Math.abs(v.scale - containScale) < 1e-9, `fit() should use contain scale even with cover=true`);
  // entire board fits in the viewport
  assert.ok(v.width * v.scale <= 390 + 1e-9);
  assert.ok(v.height * v.scale <= 844 + 1e-9);
  // minScale (deep floor) is below the contain scale so further zoom-out is allowed
  assert.ok(v.minScale < containScale, "minScale should be below contain so user can dezoom past fit");
});

test("setBottomInset: fit uses visible height for scale; centres in full viewport when board fits above dock (AC-R2-2/3, FEN-383)", () => {
  const v = new ViewTransform();
  v.setBoard(64, 40); // typical wide 64×40 board
  v.setViewport(390 * 3, 844 * 3); // dpr=3 device px
  const INSET = 250 * 3; // 250 CSS px dock at dpr=3
  v.setBottomInset(INSET);
  v.fit();
  const viewH = 844 * 3;
  const visH = viewH - INSET;
  const expectedScale = Math.min((390 * 3) / 64, visH / 40) * 0.98;
  assert.ok(Math.abs(v.scale - expectedScale) < 1e-6, `scale with inset: ${v.scale} != ${expectedScale}`);
  const ch = v.height * v.scale;
  // Board fits in the visible area (not blocked by the dock)
  assert.ok(ch <= visH + 1e-9, "board must fit in the visible viewport above the dock");
  // ty centres in the FULL viewport when the board fits above the dock (FEN-383):
  // for this wide board the full-screen centre (viewH/2) keeps the board above the dock.
  const expectedTy = Math.min((viewH - ch) / 2, visH - ch);
  assert.ok(Math.abs(v.ty - expectedTy) < 1e-6, `ty=${v.ty} should equal min(viewH-centre, just-above-dock)=${expectedTy}`);
  // Board bottom must still be at or above the dock (visH)
  assert.ok(v.ty + ch <= visH + 1e-9, "board bottom must not extend into the dock area");
});

test("setBottomInset: pan clamp uses visH boundary — board can pan off-top; bottom cells remain reachable (AC-R2-2 + AC2/FEN-383)", () => {
  const v = new ViewTransform();
  v.setBoard(64, 40);
  v.setViewport(390, 844);
  const INSET = 200; // 200px dock
  v.setBottomInset(INSET);
  v.zoomAt(195, 422, 8); // zoom in so board overflows
  v.panBy(0, -100000); // pan hard to show the board bottom (board moves up)
  const ch = v.height * v.scale;
  const visH = 844 - INSET; // 644 visible px
  // AC2: board can be panned completely off the top — new ty_min = -ch
  assert.ok(Math.abs(v.ty - (-ch)) < 1e-9, `ty ${v.ty} should reach off-top bound -ch=${-ch}`);
  // AC-R2-2: the ty position where bottom cells sit at the dock top (ty = visH-ch)
  // is within the valid clamp range [-ch, visH], so cells are reachable by panning there.
  assert.ok(visH - ch >= -ch - 1e-9, "AC-R2-2: 'bottom cells at dock top' ty is within the new clamp range");
  // The visH boundary is still used: panning in the other direction, the board
  // top can only reach as far as visH (not viewH), keeping the pan anchored to
  // the visible area above the dock (not the hidden area under it).
  v.panBy(0, 200000); // pan the other way (board down / top into view)
  assert.ok(Math.abs(v.ty - visH) < 1e-9, `ty ${v.ty} should reach off-bottom bound visH=${visH}`);
});

test("setBottomInset: zoom out hits deep dezoom floor (DEEP_ZOOM_FACTOR × contain) after inset change (AC1/FEN-383)", () => {
  const v = new ViewTransform();
  v.cover = true;
  v.setBoard(64, 40);
  v.setViewport(390, 844);
  v.coverCenter();
  // Now panel opens: set inset
  v.setBottomInset(200);
  // Zoom out as far as possible
  v.zoomAt(195, 422, 0.0001);
  // Should reach the deep dezoom floor (not the contain floor) with the inset
  const visH = 844 - 200;
  const containMin = Math.min(390 / 64, visH / 40) * 0.98;
  const expectedDeepFloor = containMin * 0.15;
  assert.ok(Math.abs(v.scale - expectedDeepFloor) < 1e-6, `deep floor with inset: ${v.scale} != ${expectedDeepFloor}`);
  // And the deep floor is below the contain level
  assert.ok(v.scale < containMin, "deep floor must be below contain level");
});

test("atFit: true at fitScale, false when zoomed in or at deep dezoom floor (FEN-383)", () => {
  const v = new ViewTransform();
  v.setBoard(64, 40);
  v.setViewport(390, 844);
  v.fit();
  assert.ok(v.atFit, "should be at fit after fit()");
  v.zoomAt(195, 422, 2);
  assert.ok(!v.atFit, "should not be at fit after zooming in");
  // Zoom out to deep floor — atFit should be FALSE (deep floor ≠ fit level)
  v.zoomAt(195, 422, 0.0001);
  assert.ok(!v.atFit, "atFit should be false at the deep dezoom floor — press ⊡ to return to fit");
  // Pressing ⊡ (fitToScreen) brings back atFit
  v.fit();
  assert.ok(v.atFit, "should be at fit after explicit fit()");
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
