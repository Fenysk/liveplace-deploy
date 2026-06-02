/**
 * Redis-backed integration test for place.lua / refill-peek.lua. Validates that
 * the Lua scripts behave identically to the unit-tested TS reference against a
 * real Redis (SETRANGE write, write-counter INCR, HSET persistence, refill,
 * consume, cooldown).
 *
 * Skipped unless REDIS_URL is set, so the default `node --test` stays
 * dependency-free and green. The module graph it needs (../src/index.ts) and
 * ioredis are imported lazily *inside* the test, so an unset REDIS_URL never
 * touches them. On the NAS / CI run it through the repo's tsx runtime, which
 * resolves the workspace's extensionless imports:
 *   REDIS_URL=redis://localhost:6379 pnpm --filter @canvas/redis-scripts exec \
 *     tsx --test test/place.integration.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

const REDIS_URL = process.env.REDIS_URL;

test("place.lua + refill-peek.lua against live Redis", { skip: !REDIS_URL }, async (t) => {
  const {
    PLACE_LUA, REFILL_PEEK_LUA, placeArgs, peekArgs,
    parsePlaceResult, parsePeekResult, parseStreamRecord,
    canvasKeys, userGaugeKey, DEFAULT_GAUGE,
  } = await import("../src/index.ts");
  const { default: Redis } = await import("ioredis");

  const redis = new Redis(REDIS_URL!);
  const userId = `test-${process.pid}`;
  const canvasId = `it-${process.pid}`;
  const K = canvasKeys(canvasId);
  const W = 16, H = 16;
  // gaugeMax here is the EFFECTIVE max the gateway passes (base + bonus). This
  // user has no bonus, so it is the base (3).
  const P = { ...DEFAULT_GAUGE, refillIntervalMs: 1000, gaugeMax: 3 };
  const keysToClear = [K.pixels, K.meta, K.stream, userGaugeKey(userId)];

  t.after(async () => {
    await redis.del(...keysToClear);
    redis.disconnect();
  });
  await redis.del(...keysToClear);

  const place = async (x: number, y: number, color: number, nowMs: number) => {
    const { keys, argv } = placeArgs({
      x, y, width: W, height: H, color, paletteSize: 32, nowMs,
      gauge: P, userId, canvasId, deltaChannel: "",
    });
    return parsePlaceResult(await redis.eval(PLACE_LUA, keys.length, ...keys, ...argv));
  };
  const peek = async (nowMs: number) => {
    const { keys, argv } = peekArgs({ nowMs, gauge: P, userId });
    return parsePeekResult(await redis.eval(REFILL_PEEK_LUA, keys.length, ...keys, ...argv));
  };

  const t0 = 1_000_000_000_000;

  // First placement: arrive full at base (3), consume 1 → 2 left.
  let r = await place(1, 2, 5, t0);
  assert.equal(r.status, "ok");
  assert.equal(r.charges, 2);
  assert.equal(r.max, 3);

  // Pixel actually written at the row-major offset; version (meta) incremented.
  const bitmap = (await redis.getBuffer(K.pixels))!;
  assert.equal(bitmap[2 * W + 1], 5);
  assert.equal(Number(await redis.get(K.meta)), 1);

  // R2 (FEN-54): the accepted placement is XADDed to the durable stream as a full
  // {x,y,color,version,userId,ts} record — what the persistence worker drains.
  const entries = (await redis.xrange(K.stream, "-", "+")) as [string, string[]][];
  assert.equal(entries.length, 1);
  assert.deepEqual(parseStreamRecord(entries[0]![1]), {
    x: 1, y: 2, color: 5, version: 1, userId, ts: t0,
  });

  // Drain the gauge.
  assert.equal((await place(0, 0, 5, t0)).charges, 1);
  r = await place(0, 0, 5, t0);
  assert.equal(r.charges, 0);

  // Empty → reject with cooldown one interval out.
  r = await place(0, 0, 5, t0);
  assert.equal(r.status, "cooldown");
  assert.equal(r.charges, 0);
  assert.equal(r.cooldownUntil, t0 + 1000);

  // Peek is read-only and reports the same.
  const pk = await peek(t0);
  assert.equal(pk.charges, 0);
  assert.equal(pk.max, 3);
  assert.equal(pk.cooldownUntil, t0 + 1000);

  // One interval later, exactly one charge returns (CA1), and placement reopens.
  r = await place(0, 0, 5, t0 + 1000);
  assert.equal(r.status, "ok");
  assert.equal(r.charges, 0); // refilled 1, consumed 1

  // CA2 / FEN-27: the gateway folds the F6 bonus into the EFFECTIVE max it passes
  // as `gaugeMax` (= base + bonus); no bonus is ever stored in Redis. A user who
  // bought N=2 upgrades is budgeted at base+2 = 5 and can actually store 5 charges.
  const upgraded = `test-upg-${process.pid}`;
  keysToClear.push(userGaugeKey(upgraded));
  const withBonus = { ...P, gaugeMax: 5 }; // effectiveGaugeMax(base 3, bonus 2)
  const placeUpgraded = async (nowMs: number) => {
    const { keys, argv } = placeArgs({
      x: 0, y: 0, width: W, height: H, color: 5, paletteSize: 32, nowMs,
      gauge: withBonus, userId: upgraded, canvasId, deltaChannel: "",
    });
    return parsePlaceResult(await redis.eval(PLACE_LUA, keys.length, ...keys, ...argv));
  };
  const up = await placeUpgraded(t0);
  assert.equal(up.status, "ok");
  assert.equal(up.max, 5); // effective ceiling = base 3 + bonus 2
  assert.equal(up.charges, 4); // arrived full at 5, consumed 1 → proves it stores 5
});

test("place.lua F4: ban enforcement (CA6) + idempotency (CA5) against live Redis", { skip: !REDIS_URL }, async (t) => {
  const { PLACE_LUA, placeArgs, parsePlaceResult, canvasKeys, userGaugeKey, DEFAULT_GAUGE } =
    await import("../src/index.ts");
  const { default: Redis } = await import("ioredis");

  const redis = new Redis(REDIS_URL!);
  const canvasId = `f4-${process.pid}`;
  const K = canvasKeys(canvasId);
  const banned = `banned-${process.pid}`;
  const op = `op-${process.pid}`;
  const W = 16, H = 16;
  const P = { ...DEFAULT_GAUGE, refillIntervalMs: 1000, gaugeMax: 5 };
  const keysToClear = [
    K.pixels, K.meta, K.stream, K.bans,
    userGaugeKey(banned), userGaugeKey(op),
    `canvas:${canvasId}:op:${op}:7`, `canvas:${canvasId}:op:${op}:8`,
  ];

  t.after(async () => {
    await redis.del(...keysToClear);
    redis.disconnect();
  });
  await redis.del(...keysToClear);

  const base = { width: W, height: H, paletteSize: 32, gauge: P, canvasId, deltaChannel: "" } as const;
  const place = async (opts: Omit<Parameters<typeof placeArgs>[0], keyof typeof base>) => {
    const { keys, argv } = placeArgs({ ...base, ...opts });
    return parsePlaceResult(await redis.eval(PLACE_LUA, keys.length, ...keys, ...argv));
  };

  const t0 = 1_000_000_000_000;

  // CA6: a userId in the ban set is rejected with "banned"; no charge consumed,
  // no pixel written. Lifting the ban (SREM) lets the next placement through.
  await redis.sadd(K.bans, banned);
  let r = await place({ x: 0, y: 0, color: 5, nowMs: t0, userId: banned });
  assert.equal(r.status, "banned");
  assert.equal(Number(await redis.exists(userGaugeKey(banned))), 0, "banned placement touches no gauge");
  assert.equal(Number((await redis.get(K.meta)) ?? 0), 0, "banned placement writes no version");

  await redis.srem(K.bans, banned);
  r = await place({ x: 0, y: 0, color: 5, nowMs: t0, userId: banned });
  assert.equal(r.status, "ok", "unbanned user places again");

  // CA5: same opId places exactly once — a replay returns ok WITHOUT consuming a
  // second charge or incrementing the version a second time.
  const first = await place({ x: 1, y: 1, color: 5, nowMs: t0, userId: op, opId: "7", opTtlMs: 60_000 });
  assert.equal(first.status, "ok");
  assert.equal(first.charges, 4, "arrived full at 5, consumed 1");
  const versionAfterFirst = Number(await redis.get(K.meta));

  const replay = await place({ x: 1, y: 1, color: 5, nowMs: t0, userId: op, opId: "7", opTtlMs: 60_000 });
  assert.equal(replay.status, "ok", "replay still acks ok");
  assert.equal(Number(await redis.hget(userGaugeKey(op), "c")), 4, "replay does NOT consume a second charge");
  assert.equal(Number(await redis.get(K.meta)), versionAfterFirst, "replay does NOT advance the version");

  // A DIFFERENT opId from the same user is a fresh placement and does consume.
  const second = await place({ x: 2, y: 2, color: 5, nowMs: t0, userId: op, opId: "8", opTtlMs: 60_000 });
  assert.equal(second.status, "ok");
  assert.equal(second.charges, 3, "distinct op consumes another charge");
});
