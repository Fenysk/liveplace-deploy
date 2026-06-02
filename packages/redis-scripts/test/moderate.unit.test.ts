/**
 * Pure unit tests for the moderation hot-path arg builders / parsers
 * (../src/index.ts), the F8 counterpart to gauge.test.ts. No Redis: these
 * validate the EVAL argument layout that moderate.lua / place.lua depend on, so
 * a header/order drift is caught in the default dependency-free `node --test`.
 *
 * Coverage:
 *   - moderateArgs flattens cells into [w,h,palette,chan,N, x,y,c …] in order
 *   - parseModerateResult reads [applied, lastSeq]
 *   - placeArgs carries the frozen-flag key as KEYS[4] (F8.4 freeze)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  moderateArgs,
  parseModerateResult,
  placeArgs,
  CANVAS_BITMAP_KEY,
  CANVAS_WRITE_COUNTER_KEY,
  CANVAS_FROZEN_KEY,
  DELTA_CHANNEL,
  DEFAULT_GAUGE,
} from "../src/index.ts";

test("moderateArgs lays out KEYS + ARGV in the order moderate.lua expects", () => {
  const cells = [
    { x: 1, y: 2, color: 0 }, // wipe to white
    { x: 3, y: 4, color: 7 }, // restore previous colour
  ];
  const { keys, argv } = moderateArgs({
    width: 512,
    height: 512,
    paletteSize: 32,
    cells,
    deltaChannel: DELTA_CHANNEL,
  });

  assert.deepEqual(keys, [CANVAS_BITMAP_KEY, CANVAS_WRITE_COUNTER_KEY]);
  // [width, height, paletteSize, deltaChannel, count, then x,y,color * N]
  assert.deepEqual(argv, [
    "512", "512", "32", DELTA_CHANNEL, "2",
    "1", "2", "0",
    "3", "4", "7",
  ]);
});

test("moderateArgs defaults the channel and handles an empty batch", () => {
  const { argv } = moderateArgs({ width: 16, height: 16, paletteSize: 32, cells: [] });
  assert.equal(argv[3], DELTA_CHANNEL); // default channel
  assert.equal(argv[4], "0"); // count
  assert.equal(argv.length, 5); // no trailing triples
});

test("parseModerateResult reads [applied, lastSeq]", () => {
  assert.deepEqual(parseModerateResult([5, 42]), { applied: 5, lastSeq: 42 });
  // Redis may return numerics as strings depending on the client.
  assert.deepEqual(parseModerateResult(["3", "9"]), { applied: 3, lastSeq: 9 });
});

test("placeArgs exposes the frozen flag as KEYS[4] for the F8.4 freeze check", () => {
  const { keys } = placeArgs({
    x: 0, y: 0, width: 16, height: 16, color: 5, paletteSize: 32,
    nowMs: 1_000, gauge: DEFAULT_GAUGE, userId: "u1",
  });
  assert.equal(keys.length, 4);
  assert.equal(keys[3], CANVAS_FROZEN_KEY);
});
