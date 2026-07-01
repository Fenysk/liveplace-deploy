import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { STREAM_FIELDS } from "@canvas/redis-scripts";
import { assembleBatch, type RawEntry } from "../stream.js";

/** Build the flat [field, value, …] array place.lua XADDs, in STREAM_FIELDS order. */
function fields(r: {
  x: number;
  y: number;
  color: number;
  version: number | string;
  userId: string;
  ts: number;
}): string[] {
  const map: Record<string, string> = {
    x: String(r.x),
    y: String(r.y),
    color: String(r.color),
    version: String(r.version),
    userId: r.userId,
    ts: String(r.ts),
  };
  return STREAM_FIELDS.flatMap((f) => [f, map[f]!]);
}

describe("assembleBatch", () => {
  it("parses well-formed entries into placements and tracks ids + lastId", () => {
    const entries: RawEntry[] = [
      ["1-0", fields({ x: 1, y: 2, color: 3, version: 10, userId: "u1", ts: 1000 })],
      ["2-0", fields({ x: 4, y: 5, color: 0, version: 11, userId: "", ts: 1001 })],
    ];
    const batch = assembleBatch(entries);
    assert.equal(batch.ids.length, 2);
    assert.equal(batch.lastId, "2-0");
    assert.equal(batch.placements.length, 2);
    assert.deepEqual(batch.placements[0], {
      x: 1,
      y: 2,
      color: 3,
      version: 10,
      userId: "u1",
      ts: 1000,
    });
    // Empty userId ("" anonymous, defensive) maps to absent in the durable log.
    assert.equal(batch.placements[1]!.userId, undefined);
  });

  it("drops a malformed (NaN version) entry but still advances lastId past it", () => {
    const dropped: string[] = [];
    const entries: RawEntry[] = [
      ["1-0", fields({ x: 1, y: 1, color: 1, version: 5, userId: "u", ts: 1 })],
      ["2-0", fields({ x: 1, y: 1, color: 1, version: "oops", userId: "u", ts: 2 })],
    ];
    const batch = assembleBatch(entries, (id) => dropped.push(id));
    assert.deepEqual(dropped, ["2-0"]);
    assert.equal(batch.placements.length, 1);
    assert.equal(batch.ids.length, 2);
    assert.equal(batch.lastId, "2-0", "poison entry must still advance the cursor");
  });

  it("returns lastId null for an empty batch", () => {
    const batch = assembleBatch([]);
    assert.equal(batch.lastId, null);
    assert.equal(batch.placements.length, 0);
  });
});
