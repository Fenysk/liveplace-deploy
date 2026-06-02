/**
 * Pure unit tests for the moderation hot-path arg builders / parsers
 * (../src/index.ts), the F8 counterpart to gauge.test.ts. No Redis: these
 * validate the EVAL argument layout that moderate.lua / place.lua depend on, so
 * a header/order drift is caught in the default dependency-free `node --test`.
 *
 * Coverage:
 *   - canvasKeys derives the per-canvas key namespace (ADR-0003)
 *   - moderateArgs flattens cells into [w,h,palette,chan,N, x,y,c …] in order
 *   - parseModerateResult reads [applied, lastSeq]
 *   - placeArgs lays out the per-canvas KEYS (pixels/gauge/meta/frozen/stream)
 *     and threads userId into ARGV for the durable stream record (FEN-54)
 *   - parseStreamRecord round-trips the XADD field order
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  moderateArgs,
  parseModerateResult,
  placeArgs,
  canvasKeys,
  userGaugeKey,
  parseStreamRecord,
  DELTA_CHANNEL,
  DEFAULT_GAUGE,
} from "../src/index.ts";

const CID = "c1";
const K = canvasKeys(CID);

test("canvasKeys derives the per-canvas key namespace (ADR-0003)", () => {
  assert.deepEqual(canvasKeys("my-slug"), {
    pixels: "canvas:my-slug:pixels",
    meta: "canvas:my-slug:meta",
    stream: "canvas:my-slug:stream",
    frozen: "canvas:my-slug:frozen",
  });
});

test("moderateArgs lays out KEYS + ARGV in the order moderate.lua expects", () => {
  const cells = [
    { x: 1, y: 2, color: 0 }, // wipe to white
    { x: 3, y: 4, color: 7 }, // restore previous colour
  ];
  const { keys, argv } = moderateArgs({
    width: 512,
    height: 512,
    paletteSize: 32,
    canvasId: CID,
    cells,
    deltaChannel: DELTA_CHANNEL,
  });

  assert.deepEqual(keys, [K.pixels, K.meta]);
  // [width, height, paletteSize, deltaChannel, count, then x,y,color * N]
  assert.deepEqual(argv, [
    "512", "512", "32", DELTA_CHANNEL, "2",
    "1", "2", "0",
    "3", "4", "7",
  ]);
});

test("moderateArgs defaults the channel and handles an empty batch", () => {
  const { argv } = moderateArgs({ width: 16, height: 16, paletteSize: 32, canvasId: CID, cells: [] });
  assert.equal(argv[3], DELTA_CHANNEL); // default channel
  assert.equal(argv[4], "0"); // count
  assert.equal(argv.length, 5); // no trailing triples
});

test("parseModerateResult reads [applied, lastSeq]", () => {
  assert.deepEqual(parseModerateResult([5, 42]), { applied: 5, lastSeq: 42 });
  // Redis may return numerics as strings depending on the client.
  assert.deepEqual(parseModerateResult(["3", "9"]), { applied: 3, lastSeq: 9 });
});

test("placeArgs lays out the per-canvas KEYS and threads userId into ARGV (FEN-54)", () => {
  const { keys, argv } = placeArgs({
    x: 0, y: 0, width: 16, height: 16, color: 5, paletteSize: 32,
    nowMs: 1_000, gauge: DEFAULT_GAUGE, userId: "u1", canvasId: CID,
  });
  // KEYS = [pixels, userGauge, meta, frozen, stream]
  assert.deepEqual(keys, [K.pixels, userGaugeKey("u1"), K.meta, K.frozen, K.stream]);
  assert.equal(keys.length, 5);
  // userId is the last ARGV element (ARGV[13]), carried onto the stream record.
  assert.equal(argv[argv.length - 1], "u1");
  assert.equal(argv[11], DELTA_CHANNEL); // ARGV[12] = deltaChannel, unchanged
});

test("parseStreamRecord round-trips the XADD field order", () => {
  // The flat [field, value, …] array ioredis yields for an XRANGE/XREAD entry.
  const fields = ["x", "3", "y", "4", "color", "7", "version", "12", "userId", "u1", "ts", "1700000000000"];
  assert.deepEqual(parseStreamRecord(fields), {
    x: 3, y: 4, color: 7, version: 12, userId: "u1", ts: 1_700_000_000_000,
  });
  // Missing userId defaults to "" (defensive; anonymous never places).
  assert.equal(parseStreamRecord(["x", "1", "y", "1", "color", "0", "version", "1", "ts", "5"]).userId, "");
});
