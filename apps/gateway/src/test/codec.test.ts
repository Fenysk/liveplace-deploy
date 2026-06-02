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
