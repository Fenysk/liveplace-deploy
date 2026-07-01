import { test } from "node:test";
import assert from "node:assert/strict";
import { DeltaCoalescer } from "../coalescer";

const W = 512;

test("flush returns null when nothing pending", () => {
  const c = new DeltaCoalescer(W);
  assert.equal(c.flush(), null);
});

test("collapses repeated writes to the same pixel (last-write-wins)", () => {
  const c = new DeltaCoalescer(W);
  c.add({ seq: 1, x: 3, y: 3, color: 5 });
  c.add({ seq: 2, x: 3, y: 3, color: 9 }); // same pixel, later
  c.add({ seq: 3, x: 4, y: 3, color: 1 });
  const batch = c.flush();
  assert.ok(batch);
  assert.equal(batch.writes.length, 2);
  assert.equal(batch.seq, 3); // highest seq folded in
  const px = batch.writes.find((w) => w.x === 3 && w.y === 3);
  assert.equal(px?.color, 9);
});

test("flush drains, leaving the coalescer empty", () => {
  const c = new DeltaCoalescer(W);
  c.add({ seq: 1, x: 0, y: 0, color: 2 });
  assert.equal(c.size, 1);
  assert.ok(c.flush());
  assert.equal(c.size, 0);
  assert.equal(c.flush(), null);
});

test("distinct pixels on the same row are not merged", () => {
  const c = new DeltaCoalescer(W);
  c.add({ seq: 1, x: 0, y: 0, color: 1 });
  c.add({ seq: 2, x: 1, y: 0, color: 1 });
  assert.equal(c.flush()?.writes.length, 2);
});
