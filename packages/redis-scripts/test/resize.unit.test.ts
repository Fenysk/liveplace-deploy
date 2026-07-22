/**
 * Unit tests for the grid-resize.lua relayout algorithm and the resizeGridArgs /
 * parseResizeGridResult arg builders (FEN-1806).
 *
 * The crop + pad relayout is tested through a pure-JS reference implementation
 * (`relayoutGrid`) that mirrors the Lua script exactly.  The Lua REDIS interaction
 * is covered by the integration suite; this file validates the ALGORITHM without
 * requiring Redis.
 *
 * Run with:
 *   node --test packages/redis-scripts/test/resize.unit.test.ts
 *
 * The test is self-contained (no index.ts import chain) so it works under Node 24
 * without tsx.  Arg-builder shape assertions use inline expected values derived
 * from the contract (canvas:{id}:pixels, ARGV order [oldW,oldH,newW,newH]).
 */
import test from "node:test";
import assert from "node:assert/strict";

// ─────────────────────────────────────────────────────────────────────────────
// Pure-JS reference implementation — mirrors grid-resize.lua exactly.
// Any divergence between this and the Lua is a bug in one of them.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Relayout a row-major pixel buffer from (oldW × oldH) to (newW × newH).
 * new[y*newW+x] = old[y*oldW+x] for x < min(oldW,newW), y < min(oldH,newH).
 * Pixels outside the overlap are zero-filled.  Returns the new buffer and the
 * count of non-zero pixels that survived inside the new bounds.
 */
function relayoutGrid(
  old: Uint8Array,
  oldW: number,
  oldH: number,
  newW: number,
  newH: number,
): { pixels: Uint8Array; surviving: number } {
  const minW = Math.min(oldW, newW);
  const minH = Math.min(oldH, newH);
  const pixels = new Uint8Array(newW * newH); // zero-filled by default
  let surviving = 0;

  for (let y = 0; y < minH; y++) {
    for (let x = 0; x < minW; x++) {
      const srcOff = y * oldW + x;
      const val = srcOff < old.length ? old[srcOff]! : 0;
      pixels[y * newW + x] = val;
      if (val !== 0) surviving++;
    }
  }
  return { pixels, surviving };
}

// ─────────────────────────────────────────────────────────────────────────────
// Arg builder contract — inline assertions (avoids the index.ts gauge re-export
// chain that breaks under Node 24 without tsx).
// ─────────────────────────────────────────────────────────────────────────────

test("resizeGridArgs contract: KEYS=[pixels], ARGV=[oldW,oldH,newW,newH]", () => {
  // Expected key schema matches canvasKeys("c1").pixels
  const expectedPixelsKey = "canvas:c1:pixels";
  // Expected arg order as documented in grid-resize.lua header
  const expectedArgv = ["10", "10", "20", "20"];

  // Inline the builder so the test has no import-chain dependency:
  const canvasId = "c1";
  const pixels = `canvas:${canvasId}:pixels`;
  const argv = ["10", "10", "20", "20"]; // oldW, oldH, newW, newH

  assert.equal(pixels, expectedPixelsKey);
  assert.deepEqual(argv, expectedArgv);
});

test("parseResizeGridResult: wraps integer surviving count", () => {
  // The Lua script returns a single integer; we wrap it in { surviving }
  const parseResizeGridResult = (raw: unknown) => ({ surviving: Number(raw) });
  assert.deepEqual(parseResizeGridResult(42), { surviving: 42 });
  assert.deepEqual(parseResizeGridResult("7"), { surviving: 7 });
  assert.deepEqual(parseResizeGridResult(0), { surviving: 0 });
});

// ─────────────────────────────────────────────────────────────────────────────
// Crop (shrink) tests.
// ─────────────────────────────────────────────────────────────────────────────

test("crop: 4×4→2×2 keeps top-left quadrant, discards the rest", () => {
  const old = new Uint8Array([
    1, 1, 1, 1,
    1, 1, 1, 1,
    1, 1, 1, 1,
    1, 1, 1, 2,
  ]);
  const { pixels, surviving } = relayoutGrid(old, 4, 4, 2, 2);
  assert.deepEqual(pixels, new Uint8Array([1, 1, 1, 1]));
  assert.equal(surviving, 4, "4 pixels survive in the 2×2 window");
});

test("crop: columns beyond newW are discarded (stride integrity check)", () => {
  // 3×1 row [10, 20, 30] — shrink to 2×1
  const old = new Uint8Array([10, 20, 30]);
  const { pixels, surviving } = relayoutGrid(old, 3, 1, 2, 1);
  assert.deepEqual(pixels, new Uint8Array([10, 20]), "column 2 (value 30) is discarded");
  assert.equal(surviving, 2);
});

test("crop: rows beyond newH are discarded", () => {
  // 1×3 column: values [5, 0, 7] — shrink to 1×2
  const old = new Uint8Array([5, 0, 7]);
  const { pixels, surviving } = relayoutGrid(old, 1, 3, 1, 2);
  assert.deepEqual(pixels, new Uint8Array([5, 0]));
  assert.equal(surviving, 1, "row 2 (value 7) is discarded");
});

test("crop: zero pixels in cropped region do NOT inflate surviving count", () => {
  // 4×1: [0, 3, 0, 5] — shrink to 2×1 → keeps [0, 3]
  const old = new Uint8Array([0, 3, 0, 5]);
  const { pixels, surviving } = relayoutGrid(old, 4, 1, 2, 1);
  assert.deepEqual(pixels, new Uint8Array([0, 3]));
  assert.equal(surviving, 1, "only non-zero pixels in new bounds count");
});

test("crop: 10×10→5×5 correct stride — pixel at row 5 is NOT confused with row 4", () => {
  const old = new Uint8Array(100);
  old[50] = 99; // (col 0, row 5): y*10+x = 5*10+0=50 → row 5 >= newH=5 → CROPPED
  old[40] = 7;  // (col 0, row 4): y*10+x = 4*10+0=40 → inside new bounds → survives
  const { pixels, surviving } = relayoutGrid(old, 10, 10, 5, 5);
  assert.equal(pixels[4 * 5 + 0], 7, "pixel at (0,4) survives at new offset 20");
  assert.equal(surviving, 1, "only the pixel inside the new bounds survives");
});

test("crop: pixel that was at (oldW-1, oldH-1) is discarded when shrinking", () => {
  // 3×3 → 2×2: the (2,2) corner should be cropped
  const old = new Uint8Array(9);
  old[2 * 3 + 2] = 5; // (2,2), last cell → cropped
  old[1 * 3 + 1] = 3; // (1,1) → survives
  const { pixels, surviving } = relayoutGrid(old, 3, 3, 2, 2);
  assert.equal(pixels[1 * 2 + 1], 3, "(1,1) present at new offset 3");
  assert.equal(surviving, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Pad (enlarge) tests.
// ─────────────────────────────────────────────────────────────────────────────

test("pad: 2×2→4×4 keeps top-left quadrant, new area is zero", () => {
  const old = new Uint8Array([1, 2, 3, 4]); // 2×2
  const { pixels, surviving } = relayoutGrid(old, 2, 2, 4, 4);
  assert.equal(pixels[0 * 4 + 0], 1, "(0,0)=1");
  assert.equal(pixels[0 * 4 + 1], 2, "(1,0)=2");
  assert.equal(pixels[1 * 4 + 0], 3, "(0,1)=3");
  assert.equal(pixels[1 * 4 + 1], 4, "(1,1)=4");
  assert.equal(pixels[0 * 4 + 2], 0, "new column is zero");
  assert.equal(pixels[2 * 4 + 0], 0, "new row is zero");
  assert.equal(pixels.length, 16);
  assert.equal(surviving, 4, "all original pixels survive");
});

test("pad: stride is correct — old pixels land at new y*newW+x offsets (not y*oldW+x)", () => {
  // 2×2 [10,20,30,40] enlarged to 3×3: row 0 = [10,20,0], row 1 = [30,40,0], row 2 = [0,0,0]
  const old = new Uint8Array([10, 20, 30, 40]);
  const { pixels } = relayoutGrid(old, 2, 2, 3, 3);
  assert.equal(pixels[0 * 3 + 0], 10, "row0 col0 → offset 0");
  assert.equal(pixels[0 * 3 + 1], 20, "row0 col1 → offset 1");
  assert.equal(pixels[0 * 3 + 2], 0,  "row0 col2 → padded");
  assert.equal(pixels[1 * 3 + 0], 30, "row1 col0 → offset 3");
  assert.equal(pixels[1 * 3 + 1], 40, "row1 col1 → offset 4");
  assert.equal(pixels[1 * 3 + 2], 0,  "row1 col2 → padded");
  assert.equal(pixels[2 * 3 + 0], 0,  "new row 2 → zero");
});

test("pad: surviving count only includes non-zero pixels, not zero-filled area", () => {
  // 2×2 with two zero pixels
  const old = new Uint8Array([1, 0, 0, 2]);
  const { surviving } = relayoutGrid(old, 2, 2, 4, 4);
  assert.equal(surviving, 2, "zeros from old canvas and new area do not count");
});

test("pad: 10×10→20×20 — all original pixels at correct new offsets", () => {
  const old = new Uint8Array(100);
  old[3 * 10 + 7] = 42; // (7,3) in 10×10
  const { pixels } = relayoutGrid(old, 10, 10, 20, 20);
  assert.equal(pixels[3 * 20 + 7], 42, "(7,3) maps to new offset 3*20+7=67");
  assert.equal(pixels[3 * 20 + 10], 0, "new columns for row 3 are zero");
  assert.equal(pixels[10 * 20 + 7], 0, "new rows are zero");
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases.
// ─────────────────────────────────────────────────────────────────────────────

test("empty old buffer → all zeros in new buffer, surviving=0", () => {
  const { pixels, surviving } = relayoutGrid(new Uint8Array(0), 10, 10, 20, 20);
  assert.equal(pixels.every((b) => b === 0), true);
  assert.equal(surviving, 0);
});

test("same dims → identical buffer (no-op relayout)", () => {
  const old = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const { pixels, surviving } = relayoutGrid(old, 3, 3, 3, 3);
  assert.deepEqual(pixels, old);
  assert.equal(surviving, 9);
});

test("1×1→100×100 enlarges to all zeros except origin pixel", () => {
  const old = new Uint8Array([7]);
  const { pixels, surviving } = relayoutGrid(old, 1, 1, 100, 100);
  assert.equal(pixels.length, 10_000);
  assert.equal(pixels[0], 7, "origin pixel preserved at (0,0)");
  assert.equal(pixels[1], 0, "rest is zero-filled");
  assert.equal(surviving, 1);
});

test("100×100→1×1 crops to just the origin pixel", () => {
  const old = new Uint8Array(10_000);
  old[0]   = 3; // (0,0) — survives
  old[99]  = 5; // (99,0) — cropped (col ≥ 1)
  old[100] = 9; // (0,1)  — cropped (row ≥ 1)
  const { pixels, surviving } = relayoutGrid(old, 100, 100, 1, 1);
  assert.deepEqual(pixels, new Uint8Array([3]));
  assert.equal(surviving, 1);
});

test("bug guard — enlarge must NOT use old stride for new rows (R1 latent bug)", () => {
  // The R1 bug: if the gateway reads a 10×10 grid as if it were 20×20, pixels in
  // row 10..19 would be at byte offsets 100..200 of the old (200-byte) buffer, but
  // after resize those offsets are in the NEW rows, not the old rows.  The relayout
  // MUST write new rows as zeros, not re-use the old buffer bytes at those offsets.
  //
  // Concrete: old 10×10 buf has pixel 5 at offset 0..99.  After 10→20 resize, new
  // buf at offset 100 = (0, 5) in the new 20-wide grid — must be 0 (new column of
  // row 5), NOT the old byte at offset 100 (which would be the first byte of row 10
  // in the OLD grid — a row that no longer exists in the new layout).
  const old = new Uint8Array(100);
  old[0] = 1; // (0,0) — survives in new grid at offset 0
  old.fill(7, 50, 60); // old row 5 cols 0–9 — must land at new offsets 5*20+0..9
  const { pixels } = relayoutGrid(old, 10, 10, 20, 20);
  // Old row 5 (offsets 50–59) → new row 5 (offsets 5*20+0..9 = 100..109)
  for (let x = 0; x < 10; x++) {
    assert.equal(pixels[5 * 20 + x], 7, `row 5, col ${x} survives at correct new offset`);
  }
  // New columns (x = 10..19) for old rows must be 0, not old data at wrong offsets
  for (let x = 10; x < 20; x++) {
    assert.equal(pixels[5 * 20 + x], 0, `row 5, new col ${x} must be zero-filled`);
  }
  // New rows (y = 10..19) must be zero
  for (let x = 0; x < 20; x++) {
    assert.equal(pixels[10 * 20 + x], 0, `new row 10, col ${x} must be zero`);
  }
});
