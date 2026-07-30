import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeDelta,
  decodeSnapshot,
  encodeDelta,
  encodeSnapshot,
  OP_DELTA,
  OP_SNAPSHOT,
  binaryOpcode,
} from "@canvas/protocol";

test("snapshot frame round-trips with seq", () => {
  const w = 4;
  const h = 3;
  const pixels = new Uint8Array(w * h);
  pixels[0] = 5;
  pixels[w * h - 1] = 31;
  const frame = encodeSnapshot(pixels, 12345, w, h);
  assert.equal(binaryOpcode(frame), OP_SNAPSHOT);
  const got = decodeSnapshot(frame);
  assert.equal(got.seq, 12345);
  assert.equal(got.width, w);
  assert.equal(got.height, h);
  assert.deepEqual([...got.pixels], [...pixels]);
});

test("delta frame round-trips with seq", () => {
  const writes = [
    { x: 1, y: 2, color: 7 },
    { x: 300, y: 400, color: 0 },
    { x: 511, y: 511, color: 31 },
  ];
  const frame = encodeDelta(99, writes);
  assert.equal(binaryOpcode(frame), OP_DELTA);
  const got = decodeDelta(frame);
  assert.equal(got.seq, 99);
  assert.deepEqual(got.writes, writes);
});

test("empty delta encodes to a header-only frame", () => {
  const got = decodeDelta(encodeDelta(0, []));
  assert.equal(got.seq, 0);
  assert.deepEqual(got.writes, []);
});

test("snapshot rejects size mismatch", () => {
  assert.throws(() => encodeSnapshot(new Uint8Array(3), 0, 4, 4));
});

// ── FEN-1762: snapshot encode/decode with non-512 canvas dims ─────────────────

test("FEN-1762: snapshot round-trips correctly on a 20×20 canvas", () => {
  const w = 20;
  const h = 20;
  const pixels = new Uint8Array(w * h);
  // seed a few non-zero pixels to ensure the payload isn't trivially empty
  pixels[0] = 1;
  pixels[w - 1] = 7;
  pixels[w * h - 1] = 31;
  const frame = encodeSnapshot(pixels, 42, w, h);
  assert.equal(binaryOpcode(frame), OP_SNAPSHOT);
  const got = decodeSnapshot(frame);
  assert.equal(got.seq, 42);
  assert.equal(got.width, w);
  assert.equal(got.height, h);
  assert.deepEqual([...got.pixels], [...pixels]);
});

test("FEN-1762: snapshot decode on 20×20 preserves pixel at (x=19,y=19) — last cell", () => {
  const w = 20;
  const h = 20;
  const pixels = new Uint8Array(w * h);
  const lastIdx = w * h - 1; // y=19, x=19
  pixels[lastIdx] = 5;
  const got = decodeSnapshot(encodeSnapshot(pixels, 0, w, h));
  assert.equal(got.pixels[lastIdx], 5, "corner pixel must survive round-trip");
});

test("FEN-1762: snapshot decode on 10×10 has exactly 100 pixels", () => {
  const w = 10;
  const h = 10;
  const pixels = new Uint8Array(w * h);
  const got = decodeSnapshot(encodeSnapshot(pixels, 0, w, h));
  assert.equal(got.pixels.length, 100);
  assert.equal(got.width, 10);
  assert.equal(got.height, 10);
});
