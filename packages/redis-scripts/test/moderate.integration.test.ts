/**
 * Redis-backed integration test for moderate.lua + the place.lua freeze check
 * (F8.1/F8.2/F8.3 bulk overwrite & fan-out, F8.4 emergency freeze).
 *
 * Skipped unless REDIS_URL is set, so the default `node --test` stays
 * dependency-free and green. Run on the NAS / CI with:
 *   REDIS_URL=redis://localhost:6379 pnpm --filter @canvas/redis-scripts exec \
 *     tsx --test test/moderate.integration.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

const REDIS_URL = process.env.REDIS_URL;

test("moderate.lua bulk overwrite + fan-out (F8.1–F8.3)", { skip: !REDIS_URL }, async (t) => {
  const {
    MODERATE_LUA, moderateArgs, parseModerateResult, parseStreamRecord,
    canvasKeys, canvasDeltaChannel,
  } = await import("../src/index.ts");
  const { default: Redis } = await import("ioredis");

  const redis = new Redis(REDIS_URL!);
  const sub = new Redis(REDIS_URL!);
  const W = 16, H = 16;
  const canvasId = `mod-${process.pid}`;
  const K = canvasKeys(canvasId);
  const keysToClear = [K.pixels, K.meta, K.stream];

  t.after(async () => {
    await redis.del(...keysToClear);
    redis.disconnect();
    sub.disconnect();
  });
  await redis.del(...keysToClear);

  // Capture fanned-out deltas so we can prove the gateway would broadcast them.
  const published: string[] = [];
  sub.on("message", (_chan, payload) => published.push(payload));
  await sub.subscribe(canvasDeltaChannel(canvasId));

  // Seed two coloured cells via raw SETRANGE (stand-in for prior placements).
  await redis.setrange(K.pixels, 2 * W + 1, String.fromCharCode(5));
  await redis.setrange(K.pixels, 4 * W + 3, String.fromCharCode(9));

  // Ban+wipe: overwrite both to white (0). One atomic call → two fanned writes.
  const cells = [
    { x: 1, y: 2, color: 0 },
    { x: 3, y: 4, color: 0 },
  ];
  const { keys, argv } = moderateArgs({
    width: W, height: H, paletteSize: 32, canvasId, cells, deltaChannel: canvasDeltaChannel(canvasId),
    actorUserId: "", nowMs: 1_700_000_000_000,
  });
  const res = parseModerateResult(await redis.eval(MODERATE_LUA, keys.length, ...keys, ...argv));

  assert.equal(res.applied, 2);

  // Bitmap reflects the wipe.
  const bitmap = (await redis.getBuffer(K.pixels))!;
  assert.equal(bitmap[2 * W + 1], 0);
  assert.equal(bitmap[4 * W + 3], 0);

  // Version counter advanced once per cell; lastSeq matches it.
  const counter = Number(await redis.get(K.meta));
  assert.equal(counter, 2);
  assert.equal(res.lastSeq, 2);

  // DURABILITY (binding invariant): each overwritten cell was XADDed to the
  // per-canvas stream with the bumped version + the same shape place.lua uses,
  // so the worker drains a moderation wipe into `placements` like any placement.
  const entries = (await redis.xrange(K.stream, "-", "+")) as [string, string[]][];
  assert.equal(entries.length, 2);
  const rec0 = parseStreamRecord(entries[0]![1]);
  assert.deepEqual(
    { x: rec0.x, y: rec0.y, color: rec0.color, version: rec0.version, ts: rec0.ts },
    { x: 1, y: 2, color: 0, version: 1, ts: 1_700_000_000_000 },
  );
  assert.equal(rec0.userId, ""); // system / moderation overwrite

  // Both writes were published on the per-canvas delta channel as "seq,x,y,color" → the gateway
  // coalesces them into a single bulkDelta frame (CA1).
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(published.length, 2);
  assert.equal(published[0], "1,1,2,0");
  assert.equal(published[1], "2,3,4,0");

  // Restore (F8.3) is the same engine with the previous colours: put cell (1,2)
  // back to 5. applied counts it; the wipe of an out-of-bounds cell is skipped.
  // streamKey:false → this restore is realtime-only (no durable record) to prove
  // the toggle; production restores keep the stream on.
  const restore = moderateArgs({
    width: W, height: H, paletteSize: 32, canvasId, deltaChannel: "",
    cells: [{ x: 1, y: 2, color: 5 }, { x: 999, y: 999, color: 1 }],
    actorUserId: "", nowMs: 1_700_000_000_001, streamKey: false,
  });
  const r2 = parseModerateResult(await redis.eval(MODERATE_LUA, restore.keys.length, ...restore.keys, ...restore.argv));
  assert.equal(r2.applied, 1); // out-of-bounds cell skipped
  const bitmap2 = (await redis.getBuffer(K.pixels))!;
  assert.equal(bitmap2[2 * W + 1], 5);
});

test("place.lua honours the emergency freeze flag (F8.4 / CA4)", { skip: !REDIS_URL }, async (t) => {
  const {
    PLACE_LUA, placeArgs, parsePlaceResult,
    canvasKeys, gaugeKey, DEFAULT_GAUGE,
  } = await import("../src/index.ts");
  const { default: Redis } = await import("ioredis");

  const redis = new Redis(REDIS_URL!);
  const userId = `freeze-${process.pid}`;
  const canvasId = `frz-${process.pid}`;
  const K = canvasKeys(canvasId);
  const W = 16, H = 16;
  const P = { ...DEFAULT_GAUGE, refillIntervalMs: 1000, gaugeMax: 3 };
  const keysToClear = [K.pixels, K.meta, K.stream, K.frozen, gaugeKey(canvasId, userId)];

  t.after(async () => {
    await redis.del(...keysToClear);
    redis.disconnect();
  });
  await redis.del(...keysToClear);

  const place = async () => {
    const { keys, argv } = placeArgs({
      x: 0, y: 0, width: W, height: H, color: 5, paletteSize: 32, nowMs: 1_000,
      gauge: P, userId, canvasId, deltaChannel: "",
    });
    return parsePlaceResult(await redis.eval(PLACE_LUA, keys.length, ...keys, ...argv));
  };

  // Open canvas: a placement succeeds.
  assert.equal((await place()).status, "ok");

  // Freeze (one SET) → next placement is rejected instantly, no charge touched.
  await redis.set(K.frozen, "1");
  const frozen = await place();
  assert.equal(frozen.status, "frozen");
  // The version counter did not advance for the frozen attempt (only the first ok).
  assert.equal(Number(await redis.get(K.meta)), 1);

  // Unfreeze (one DEL) → placement reopens instantly.
  await redis.del(K.frozen);
  assert.equal((await place()).status, "ok");
});
