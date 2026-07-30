/**
 * Unit tests for {@link BoardBuffer} — the pure pixel-buffer extracted from
 * the renderer (FEN-1950, FE-B). Exercises the 9-byte header format via the
 * `@canvas/protocol` encode helpers, matching the headless test pattern from
 * `surface.test.ts`.
 *
 * Snapshot frame layout (SNAPSHOT_HEADER_BYTES = 9):
 *   [0]     u8  opcode (0x01)
 *   [1..4]  u32 seq (big-endian)
 *   [5..6]  u16 width
 *   [7..8]  u16 height
 *   [9..]   u8[]  palette-index pixels (width × height)
 *
 * Delta frame layout (DELTA_HEADER_BYTES = 7, DELTA_RECORD_BYTES = 5):
 *   [0]     u8  opcode (0x02)
 *   [1..4]  u32 seq
 *   [5..6]  u16 write count
 *   per write: u16 x, u16 y, u8 color
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeSnapshot, encodeDelta } from "@canvas/protocol";
import { BoardBuffer, PALETTE_RGBA, TRANSPARENT } from "./boardBuffer.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeSnap(w: number, h: number, fill: number, seq = 0): ArrayBuffer {
  return encodeSnapshot(new Uint8Array(w * h).fill(fill), seq, w, h);
}

// ── applyBinary routing ───────────────────────────────────────────────────────

test("applyBinary routes snapshot (0x01) and loads board", () => {
  const buf = new BoardBuffer();
  const snap = makeSnap(4, 4, 0, 1);
  const seq = buf.applyBinary(snap);
  assert.equal(seq, 1);
  assert.equal(buf.loaded, true);
  assert.equal(buf.width, 4);
  assert.equal(buf.height, 4);
});

test("applyBinary routes delta (0x02) after snapshot", () => {
  const buf = new BoardBuffer();
  buf.applyBinary(makeSnap(4, 4, 0, 1));
  const delta = encodeDelta(2, [{ x: 1, y: 2, color: 5 }]);
  const seq = buf.applyBinary(delta);
  assert.equal(seq, 2);
  assert.equal(buf.getPixel(1, 2), 5);
});

test("applyBinary returns -1 for unknown opcode", () => {
  const buf = new BoardBuffer();
  const junk = new ArrayBuffer(1);
  new DataView(junk).setUint8(0, 0x99);
  assert.equal(buf.applyBinary(junk), -1);
});

// ── loadSnapshot ─────────────────────────────────────────────────────────────

test("loadSnapshot fills pixels and imageView from 9-byte header frame", () => {
  const buf = new BoardBuffer();
  const pixels = new Uint8Array([1, 2, 0, 3, 5, 0, 7, 0, 0]);
  const snap = encodeSnapshot(pixels, 42, 3, 3);
  const seq = buf.loadSnapshot(snap);

  assert.equal(seq, 42);
  assert.equal(buf.appliedSeq, 42);
  assert.equal(buf.width, 3);
  assert.equal(buf.height, 3);
  assert.equal(buf.loaded, true);
  assert.deepEqual(Array.from(buf.pixels), Array.from(pixels));
  // imageView mirrors pixels
  assert.equal(buf.imageView[0], PALETTE_RGBA[1]);   // color 1
  assert.equal(buf.imageView[2], TRANSPARENT);        // color 0 → transparent
  assert.equal(buf.imageView[3], PALETTE_RGBA[3]);   // color 3
});

test("loadSnapshot replaces a previous snapshot", () => {
  const buf = new BoardBuffer();
  buf.loadSnapshot(makeSnap(2, 2, 3, 1));
  buf.loadSnapshot(makeSnap(4, 2, 7, 5));
  assert.equal(buf.width, 4);
  assert.equal(buf.height, 2);
  assert.equal(buf.appliedSeq, 5);
  assert.equal(buf.getPixel(3, 1), 7);
});

// ── applyDelta ────────────────────────────────────────────────────────────────

test("applyDelta applies writes and advances seq", () => {
  const buf = new BoardBuffer();
  buf.loadSnapshot(makeSnap(8, 8, 0, 1));
  const delta = encodeDelta(5, [
    { x: 0, y: 0, color: 3 },
    { x: 7, y: 7, color: 10 },
  ]);
  const seq = buf.applyDelta(delta);
  assert.equal(seq, 5);
  assert.equal(buf.appliedSeq, 5);
  assert.equal(buf.getPixel(0, 0), 3);
  assert.equal(buf.getPixel(7, 7), 10);
  assert.equal(buf.imageView[0], PALETTE_RGBA[3]);
  assert.equal(buf.imageView[63], PALETTE_RGBA[10]);
});

test("applyDelta ignores stale seq (snapshot↔stream overlap)", () => {
  const buf = new BoardBuffer();
  buf.loadSnapshot(makeSnap(4, 4, 0, 10));
  const stale = encodeDelta(5, [{ x: 0, y: 0, color: 9 }]);
  const seq = buf.applyDelta(stale);
  assert.equal(seq, 10, "returns current appliedSeq unchanged");
  assert.equal(buf.getPixel(0, 0), 0, "stale delta not applied");
});

test("applyDelta ignores frame when not yet loaded", () => {
  const buf = new BoardBuffer();
  const delta = encodeDelta(1, [{ x: 0, y: 0, color: 5 }]);
  const seq = buf.applyDelta(delta);
  assert.equal(seq, -1);
  assert.equal(buf.loaded, false);
});

test("applyDelta fires onWrite callback for each cell", () => {
  const buf = new BoardBuffer();
  buf.loadSnapshot(makeSnap(4, 4, 0, 1));
  const writes: Array<[number, number, number]> = [];
  buf.applyDelta(
    encodeDelta(2, [
      { x: 1, y: 0, color: 5 },
      { x: 2, y: 3, color: 7 },
    ]),
    (x, y, idx) => writes.push([x, y, idx]),
  );
  assert.deepEqual(writes, [
    [1, 0, 1],          // idx = 0*4 + 1 = 1
    [2, 3, 14],         // idx = 3*4 + 2 = 14
  ]);
});

// ── resizeTo ─────────────────────────────────────────────────────────────────

test("resizeTo expands board and preserves existing pixels", () => {
  const buf = new BoardBuffer();
  // 2×2 board: row0=[1,2], row1=[3,4]
  const pixels = new Uint8Array([1, 2, 3, 4]);
  buf.loadSnapshot(encodeSnapshot(pixels, 0, 2, 2));

  buf.resizeTo(4, 3);
  assert.equal(buf.width, 4);
  assert.equal(buf.height, 3);
  assert.equal(buf.pixels.length, 12);
  // old 2×2 preserved in top-left
  assert.equal(buf.getPixel(0, 0), 1);
  assert.equal(buf.getPixel(1, 0), 2);
  assert.equal(buf.getPixel(0, 1), 3);
  assert.equal(buf.getPixel(1, 1), 4);
  // new cells zero-filled
  assert.equal(buf.getPixel(2, 0), 0);
  assert.equal(buf.getPixel(3, 2), 0);
});

test("resizeTo rebuilds imageView for new dimensions", () => {
  const buf = new BoardBuffer();
  buf.loadSnapshot(encodeSnapshot(new Uint8Array([5, 0, 0, 5]), 0, 2, 2));
  buf.resizeTo(2, 4);
  assert.equal(buf.imageView.length, 8);
  assert.equal(buf.imageView[0], PALETTE_RGBA[5]);
  assert.equal(buf.imageView[1], TRANSPARENT);
  assert.equal(buf.imageView[4], 0, "new row zero-filled → transparent");
});

test("resizeTo is a no-op for same dimensions", () => {
  const buf = new BoardBuffer();
  buf.loadSnapshot(makeSnap(3, 3, 2, 0));
  const prevPixels = buf.pixels;
  buf.resizeTo(3, 3);
  assert.equal(buf.pixels, prevPixels, "pixels array unchanged");
});

test("resizeTo is a no-op when not yet loaded", () => {
  const buf = new BoardBuffer();
  buf.resizeTo(4, 4);
  assert.equal(buf.loaded, false);
  assert.equal(buf.width, 0);
});

// ── setPixel / getPixel / colorAt ────────────────────────────────────────────

test("setPixel updates pixels and imageView in O(1)", () => {
  const buf = new BoardBuffer();
  buf.loadSnapshot(makeSnap(4, 4, 0, 0));
  buf.setPixel(2, 1, 6);
  assert.equal(buf.getPixel(2, 1), 6);
  assert.equal(buf.imageView[1 * 4 + 2], PALETTE_RGBA[6]);
});

test("setPixel to 0 writes TRANSPARENT into imageView", () => {
  const buf = new BoardBuffer();
  buf.loadSnapshot(encodeSnapshot(new Uint8Array([5, 0]), 0, 2, 1));
  buf.setPixel(0, 0, 0);
  assert.equal(buf.imageView[0], TRANSPARENT);
  assert.equal(buf.pixels[0], 0);
});

test("setPixel ignores out-of-bounds coordinates", () => {
  const buf = new BoardBuffer();
  buf.loadSnapshot(makeSnap(4, 4, 1, 0));
  buf.setPixel(-1, 0, 9);
  buf.setPixel(4, 0, 9);
  buf.setPixel(0, 4, 9);
  // all in-bounds cells still 1
  assert.equal(buf.getPixel(0, 0), 1);
});

test("setPixel is a no-op when not yet loaded", () => {
  const buf = new BoardBuffer();
  buf.setPixel(0, 0, 5);
  assert.equal(buf.loaded, false);
});

test("getPixel returns 0 for out-of-bounds or unloaded", () => {
  const buf = new BoardBuffer();
  assert.equal(buf.getPixel(0, 0), 0, "unloaded → 0");
  buf.loadSnapshot(makeSnap(4, 4, 3, 0));
  assert.equal(buf.getPixel(-1, 0), 0);
  assert.equal(buf.getPixel(4, 0), 0);
});

test("colorAt returns -1 for out-of-bounds or unloaded", () => {
  const buf = new BoardBuffer();
  assert.equal(buf.colorAt(0, 0), -1, "unloaded → -1");
  buf.loadSnapshot(makeSnap(4, 4, 2, 0));
  assert.equal(buf.colorAt(4, 0), -1);
  assert.equal(buf.colorAt(0, 0), 2);
});
