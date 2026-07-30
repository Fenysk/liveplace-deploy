/**
 * Pure unit tests for the key schema + EVAL arg builders (../src/index.ts) — no
 * Redis required. The script BEHAVIOUR is proven by place.integration.test.ts;
 * here we lock the KEYS/ARGV shape the F4 ban (CA6) + idempotency (CA5) features
 * depend on, so a positional drift breaks a fast test rather than the hot path.
 *
 * Run through the repo's tsx runtime (this package declares no test script, by
 * convention — see place.integration.test.ts):
 *   node --import tsx --test packages/redis-scripts/test/index.unit.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  canvasKeys,
  userOpKey,
  gaugeKey,
  placeArgs,
  parsePlaceResult,
  canvasDeltaChannel,
  DEFAULT_GAUGE,
} from "../src/index.ts";

test("canvasKeys includes the per-canvas ban set (CA6)", () => {
  const k = canvasKeys("liveplace");
  assert.equal(k.pixels, "canvas:liveplace:pixels");
  assert.equal(k.frozen, "canvas:liveplace:frozen");
  assert.equal(k.stream, "canvas:liveplace:stream");
  assert.equal(k.bans, "canvas:liveplace:bans");
});

test("userOpKey is namespaced by canvas, user and op (CA5)", () => {
  assert.equal(userOpKey("liveplace", "user-7", "42"), "canvas:liveplace:op:user-7:42");
});

test("gaugeKey is namespaced by canvas AND user (FEN-1616 — per-canvas réserve)", () => {
  // Two canvases → two independent buckets for the same user, so placing on one
  // canvas can never drain the gauge shown on another.
  assert.equal(gaugeKey("liveplace", "user-7"), "canvas:liveplace:gauge:user-7");
  assert.equal(gaugeKey("other", "user-7"), "canvas:other:gauge:user-7");
  assert.notEqual(gaugeKey("liveplace", "user-7"), gaugeKey("other", "user-7"));
});

test("placeArgs: KEYS order is [pixels, gauge, meta, frozen, stream, bans, op]", () => {
  const { keys } = placeArgs({
    x: 1, y: 2, width: 4, height: 4, color: 3, paletteSize: 32,
    nowMs: 1000, gauge: DEFAULT_GAUGE, userId: "user-7",
    canvasId: "liveplace", opId: "42",
  });
  assert.deepEqual(keys, [
    "canvas:liveplace:pixels",
    gaugeKey("liveplace", "user-7"),
    "canvas:liveplace:meta",
    "canvas:liveplace:frozen",
    "canvas:liveplace:stream",
    "canvas:liveplace:bans",
    "canvas:liveplace:op:user-7:42",
  ]);
});

test("placeArgs: empty op slot when no opId — idempotency disabled, slot stays positional", () => {
  const { keys, argv } = placeArgs({
    x: 0, y: 0, width: 4, height: 4, color: 0, paletteSize: 32,
    nowMs: 1000, gauge: DEFAULT_GAUGE, userId: "u",
  });
  assert.equal(keys.length, 7, "always 7 KEYS so the script indexes stay fixed");
  assert.equal(keys[6], "", "op key is empty when no opId is supplied");
  assert.equal(argv[13], "", "opId ARGV empty");
  assert.equal(argv[14], "0", "default op TTL is 0 (no expiry) when unset");
  assert.equal(argv[15], "0", "streamMaxLen defaults to 0 (no XADD cap) when unset");
});

test("placeArgs: ARGV order is stable — gaugeMax at 9, userId/opId/opTtl appended", () => {
  const { argv } = placeArgs({
    x: 1, y: 2, width: 16, height: 16, color: 5, paletteSize: 32,
    nowMs: 7, gauge: { ...DEFAULT_GAUGE, gaugeMax: 25 }, userId: "user-9",
    deltaChannel: canvasDeltaChannel("liveplace"), opId: "100", opTtlMs: 60_000, streamMaxLen: 500_000,
  });
  // x,y,w,h,color,palette,now,interval,amount,gaugeMax,ttl,chan,userId,opId,opTtl,streamMaxLen
  assert.equal(argv[9], "25", "effective gaugeMax stays at ARGV index 9 (FEN-27 seam)");
  assert.equal(argv[12], "user-9", "userId at index 12");
  assert.equal(argv[13], "100", "opId at index 13");
  assert.equal(argv[14], "60000", "opTtlMs at index 14");
  assert.equal(argv[15], "500000", "streamMaxLen appended at index 15 (FEN-651/A8 backstop)");
});

test("parsePlaceResult passes the banned status through", () => {
  assert.equal(parsePlaceResult(["banned", 0, 20, 0]).status, "banned");
});
