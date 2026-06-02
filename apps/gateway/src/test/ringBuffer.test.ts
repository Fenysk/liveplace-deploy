import { test } from "node:test";
import assert from "node:assert/strict";
import { SeqRingBuffer } from "../ringBuffer";

function push(rb: SeqRingBuffer, from: number, to: number) {
  for (let s = from; s <= to; s++) rb.push({ seq: s, x: s, y: 0, color: 1 });
}

test("empty buffer treats any seq as caught up", () => {
  const rb = new SeqRingBuffer(16);
  assert.deepEqual(rb.since(0), []);
  assert.deepEqual(rb.since(100), []);
});

test("returns only writes after the client seq", () => {
  const rb = new SeqRingBuffer(16);
  push(rb, 1, 5);
  const missed = rb.since(3);
  assert.ok(missed);
  assert.deepEqual(missed.map((d) => d.seq), [4, 5]);
});

test("caught-up client gets an empty replay", () => {
  const rb = new SeqRingBuffer(16);
  push(rb, 1, 5);
  assert.deepEqual(rb.since(5), []);
  assert.deepEqual(rb.since(9), []); // ahead → treated as caught up
});

test("client older than the window forces snapshot fallback (null)", () => {
  const rb = new SeqRingBuffer(4); // holds seq 7..10 after eviction
  push(rb, 1, 10);
  assert.equal(rb.latestSeq, 10);
  // oldest retained is seq 7; a client at seq 3 has a gap (4,5,6 evicted).
  assert.equal(rb.since(3), null);
  // a client exactly at oldest-1 (6) can still be served.
  assert.deepEqual(rb.since(6)?.map((d) => d.seq), [7, 8, 9, 10]);
});

test("reset drops the window so resync falls back to snapshot", () => {
  const rb = new SeqRingBuffer(16);
  push(rb, 1, 5);
  rb.reset();
  assert.equal(rb.latestSeq, 0);
  assert.deepEqual(rb.since(0), []); // empty again
});
