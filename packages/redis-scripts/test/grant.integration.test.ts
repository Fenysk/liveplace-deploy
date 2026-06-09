/**
 * Redis-backed integration test for grant.lua (tier claim, Lot D / FEN-130).
 * Proves the Lua grant behaves identically to the unit-tested TS reference
 * (../src/gauge.ts grantCharges) against a real Redis: refill-then-add, clamp to
 * the (raised) effective max, HSET persistence, and the post-grant snapshot the
 * gateway pushes as a `gauge` frame.
 *
 * Skipped unless REDIS_URL is set, so the default `node --test` stays
 * dependency-free and green (ioredis + the script module graph are imported
 * lazily inside the test). On the NAS / CI:
 *   REDIS_URL=redis://localhost:6379 pnpm --filter @canvas/redis-scripts exec \
 *     tsx --test test/grant.integration.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

const REDIS_URL = process.env.REDIS_URL;

test("grant.lua against live Redis", { skip: !REDIS_URL }, async (t) => {
  const {
    GRANT_LUA, PLACE_LUA, grantArgs, placeArgs,
    parsePeekResult, parsePlaceResult, canvasKeys, userGaugeKey, DEFAULT_GAUGE, grantCharges,
  } = await import("../src/index.ts");
  const { default: Redis } = await import("ioredis");

  const redis = new Redis(REDIS_URL!);
  const userId = `grant-${process.pid}`;
  const canvasId = `itg-${process.pid}`;
  const K = canvasKeys(canvasId);
  const gaugeKey = userGaugeKey(userId);
  // Effective max the gateway passes (base + bonus). Start at base 5.
  const P = { ...DEFAULT_GAUGE, refillIntervalMs: 1000, gaugeMax: 5 };
  const keysToClear = [K.pixels, K.meta, K.stream, gaugeKey];

  t.after(async () => {
    await redis.del(...keysToClear);
    redis.disconnect();
  });
  await redis.del(...keysToClear);

  const t0 = 1_000_000_000_000;
  const grant = async (n: number, nowMs: number, gauge = P) => {
    const { keys, argv } = grantArgs({ nowMs, gauge, userId, grant: n });
    return parsePeekResult(await redis.eval(GRANT_LUA, keys.length, ...keys, ...argv));
  };
  const place = async (nowMs: number) => {
    const { keys, argv } = placeArgs({
      x: 0, y: 0, width: 8, height: 8, color: 1, paletteSize: 32, nowMs,
      gauge: P, userId, canvasId, deltaChannel: "",
    });
    return parsePlaceResult(await redis.eval(PLACE_LUA, keys.length, ...keys, ...argv));
  };

  // Seed a partial gauge via one placement (arrive full at 5, consume 1 → 4).
  let r = await place(t0);
  assert.equal(r.status, "ok");
  assert.equal(r.charges, 4);

  // Grant +1 immediately: 4 → 5 (full), clamped, clock pinned. Matches TS mirror.
  const g = await grant(1, t0);
  const ref = grantCharges({ charges: 4, ts: t0 }, t0, 1, P);
  assert.equal(g.charges, ref.charges);
  assert.equal(g.charges, 5);
  assert.equal(g.max, 5);
  assert.equal(g.cooldownUntil, 0); // full
  // Persisted to the hash.
  assert.equal(Number(await redis.hget(gaugeKey, "c")), 5);

  // A claim that lifts the ceiling to 6 and grants 1 makes room past the old full.
  const g2 = await grant(1, t0, { ...P, gaugeMax: 6 });
  assert.equal(g2.charges, 6);
  assert.equal(g2.max, 6);
  assert.equal(Number(await redis.hget(gaugeKey, "c")), 6);
});
