/**
 * Unit tests for CanvasDimsCache (canvasDims.ts).
 *
 * All async behaviour is exercised without a real Convex client: we inject a
 * controllable stub so we can assert on fetch counts, TTL expiry, and the
 * invalidate() eviction path added in FEN-1790.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CanvasDimsCache } from "../canvasDims";

const FALLBACK = { width: 512, height: 512 };
const CANVAS_ID = "abc123";

function makeClient(result: unknown) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async query(_name: string, _args: Record<string, unknown>) {
      calls++;
      return result;
    },
  };
}

test("returns fresh dims from Convex on first resolve", async () => {
  const client = makeClient({ width: 20, height: 20 });
  const cache = new CanvasDimsCache(client, FALLBACK, 30_000, () => 0);
  const dims = await cache.resolve(CANVAS_ID);
  assert.deepEqual(dims, { width: 20, height: 20 });
  assert.equal(client.calls, 1);
});

test("returns cached dims within TTL without re-fetching", async () => {
  let now = 0;
  const client = makeClient({ width: 20, height: 20 });
  const cache = new CanvasDimsCache(client, FALLBACK, 30_000, () => now);
  await cache.resolve(CANVAS_ID);
  now = 15_000; // still within 30s TTL
  await cache.resolve(CANVAS_ID);
  assert.equal(client.calls, 1, "should not re-fetch within TTL");
});

test("re-fetches after TTL expires", async () => {
  let now = 0;
  const client = makeClient({ width: 20, height: 20 });
  const cache = new CanvasDimsCache(client, FALLBACK, 30_000, () => now);
  await cache.resolve(CANVAS_ID);
  now = 31_000; // past 30s TTL
  await cache.resolve(CANVAS_ID);
  assert.equal(client.calls, 2, "should re-fetch after TTL");
});

test("invalidate() evicts cache so next resolve fetches fresh dims", async () => {
  let now = 0;
  const client = makeClient({ width: 20, height: 20 });
  const cache = new CanvasDimsCache(client, FALLBACK, 30_000, () => now);
  await cache.resolve(CANVAS_ID); // populate cache
  assert.equal(client.calls, 1);

  cache.invalidate(CANVAS_ID); // evict

  now = 1_000; // still within TTL, but cache was evicted
  await cache.resolve(CANVAS_ID); // must re-fetch
  assert.equal(client.calls, 2, "should re-fetch after invalidate");
});

test("invalidate() on unknown canvasId is a no-op", () => {
  const cache = new CanvasDimsCache(null, FALLBACK);
  assert.doesNotThrow(() => cache.invalidate("unknown-canvas"));
});

test("falls back to env dims when Convex client is null", async () => {
  const cache = new CanvasDimsCache(null, FALLBACK);
  const dims = await cache.resolve(CANVAS_ID);
  assert.deepEqual(dims, FALLBACK);
});

test("getDimsOrFallback returns fallback before any resolve", () => {
  const cache = new CanvasDimsCache(null, FALLBACK);
  assert.deepEqual(cache.getDimsOrFallback(CANVAS_ID), FALLBACK);
});

test("getDimsOrFallback returns cached dims after resolve", async () => {
  const client = makeClient({ width: 50, height: 50 });
  const cache = new CanvasDimsCache(client, FALLBACK, 30_000, () => 0);
  await cache.resolve(CANVAS_ID);
  assert.deepEqual(cache.getDimsOrFallback(CANVAS_ID), { width: 50, height: 50 });
});

test("getDimsOrFallback returns fallback after invalidate (sync)", async () => {
  const client = makeClient({ width: 50, height: 50 });
  const cache = new CanvasDimsCache(client, FALLBACK, 30_000, () => 0);
  await cache.resolve(CANVAS_ID);
  cache.invalidate(CANVAS_ID);
  assert.deepEqual(cache.getDimsOrFallback(CANVAS_ID), FALLBACK, "evicted → fallback until next resolve");
});

// ── FEN-1795: getDimsIfReady — fail-closed path ────────────────────────────

test("FEN-1795: getDimsIfReady returns null before any resolve (cache empty)", () => {
  const cache = new CanvasDimsCache(null, FALLBACK);
  assert.equal(cache.getDimsIfReady(CANVAS_ID), null, "no cache entry → null, not the fallback");
});

test("FEN-1795: getDimsIfReady returns resolved dims after a successful resolve", async () => {
  const client = makeClient({ width: 20, height: 20 });
  const cache = new CanvasDimsCache(client, FALLBACK, 30_000, () => 0);
  await cache.resolve(CANVAS_ID);
  assert.deepEqual(cache.getDimsIfReady(CANVAS_ID), { width: 20, height: 20 });
});

test("FEN-1795: getDimsIfReady returns null after invalidate (fail-closed during re-resolve)", async () => {
  const client = makeClient({ width: 20, height: 20 });
  const cache = new CanvasDimsCache(client, FALLBACK, 30_000, () => 0);
  await cache.resolve(CANVAS_ID);
  cache.invalidate(CANVAS_ID);
  assert.equal(cache.getDimsIfReady(CANVAS_ID), null, "evicted entry → null until next successful resolve");
});

// ── FEN-1813: set() — authoritative update without null window ────────────

test("FEN-1813: set() makes getDimsIfReady return new dims immediately (no null window)", () => {
  const cache = new CanvasDimsCache(null, FALLBACK, 30_000, () => 0);
  cache.set(CANVAS_ID, { width: 20, height: 20 });
  assert.deepEqual(
    cache.getDimsIfReady(CANVAS_ID),
    { width: 20, height: 20 },
    "set() should populate cache so getDimsIfReady is non-null immediately",
  );
});

test("FEN-1813: set() replaces existing entry without null window", async () => {
  const client = makeClient({ width: 10, height: 10 });
  const cache = new CanvasDimsCache(client, FALLBACK, 30_000, () => 0);
  await cache.resolve(CANVAS_ID); // populate with 10×10
  cache.set(CANVAS_ID, { width: 20, height: 20 }); // authoritative resize to 20×20
  assert.deepEqual(
    cache.getDimsIfReady(CANVAS_ID),
    { width: 20, height: 20 },
    "set() must replace the old entry, not leave a null gap",
  );
});

test("FEN-1813: set() refreshes TTL (entry survives a natural expiry of the old value)", () => {
  let now = 0;
  const cache = new CanvasDimsCache(null, FALLBACK, 30_000, () => now);
  cache.set(CANVAS_ID, { width: 20, height: 20 });
  now = 25_000; // within the 30 s TTL set by set()
  assert.deepEqual(cache.getDimsIfReady(CANVAS_ID), { width: 20, height: 20 });
});

test("FEN-1795: getDimsIfReady returns stale dims after TTL expiry (avoid dropping in-flight clients)", async () => {
  let now = 0;
  const client = makeClient({ width: 20, height: 20 });
  const cache = new CanvasDimsCache(client, FALLBACK, 30_000, () => now);
  await cache.resolve(CANVAS_ID);
  now = 60_000; // well past TTL — entry stale but still in map
  assert.deepEqual(
    cache.getDimsIfReady(CANVAS_ID),
    { width: 20, height: 20 },
    "stale entry is still present in map → return it (not null); canvas resize propagates via invalidate",
  );
});

// ── FEN-1813 (round 3): forceResolve() bypasses TTL to self-heal stale dims ─

test("FEN-1813/gap: forceResolve() bypasses TTL and returns fresh Convex dims", async () => {
  // Simulates the scheduling gap: Convex mutation commits (canvas now 20×20),
  // but the gateway cache still holds 10×10 within the TTL. forceResolve()
  // must go to Convex unconditionally and return the new dims.
  let now = 0;
  let queryCount = 0;
  const client = {
    query(_name: string, _args: Record<string, unknown>): Promise<unknown> {
      queryCount++;
      return Promise.resolve({ width: 20, height: 20 }); // Convex has new dims
    },
  };
  const TTL = 30_000;
  const cache = new CanvasDimsCache(client, FALLBACK, TTL, () => now);

  // Seed with stale 10×10 (set at T=0, still within TTL at T=5s)
  cache.set(CANVAS_ID, { width: 10, height: 10 });
  now = 5_000; // TTL not expired yet
  assert.deepEqual(cache.getDimsIfReady(CANVAS_ID), { width: 10, height: 10 }, "cached 10×10 before forceResolve");
  assert.equal(queryCount, 0, "no Convex call yet (set() wrote directly)");

  // forceResolve() must bypass the fresh TTL and go to Convex
  const dims = await cache.forceResolve(CANVAS_ID);
  assert.deepEqual(dims, { width: 20, height: 20 }, "forceResolve returns Convex dims 20×20");
  assert.equal(queryCount, 1, "exactly one Convex query fired");
  assert.deepEqual(cache.getDimsIfReady(CANVAS_ID), { width: 20, height: 20 }, "cache updated by forceResolve");
});

test("FEN-1813/gap: forceResolve() deduplicates concurrent calls (shares single inflight)", async () => {
  let queryCount = 0;
  let resolveQuery!: () => void;
  const client = {
    query(_name: string, _args: Record<string, unknown>): Promise<unknown> {
      queryCount++;
      return new Promise<unknown>((res) => {
        resolveQuery = () => res({ width: 20, height: 20 });
      });
    },
  };
  const cache = new CanvasDimsCache(client, FALLBACK);

  // Two concurrent forceResolve() calls — must share one inflight
  const p1 = cache.forceResolve(CANVAS_ID);
  const p2 = cache.forceResolve(CANVAS_ID);
  resolveQuery();
  const [d1, d2] = await Promise.all([p1, p2]);
  assert.deepEqual(d1, { width: 20, height: 20 });
  assert.deepEqual(d2, { width: 20, height: 20 });
  assert.equal(queryCount, 1, "concurrent forceResolve() must share one Convex fetch");
});

// ── FEN-1813 (round 2): _fetch() must not overwrite a concurrent set() ────

test("FEN-1813/race: stale _fetch() completion must not overwrite a set() that fired mid-flight", async () => {
  // Simulate the race: _fetch() starts (T=0), set() runs during the flight (T=1),
  // _fetch() resolves later with old Convex data (T=2) — the cache must keep
  // the set() value, not the stale Convex result.
  let now = 0;
  let resolveQuery!: () => void;
  const slowClient = {
    query(_name: string, _args: Record<string, unknown>): Promise<unknown> {
      // Convex query starts at T=0 but returns old dims 10×10 (before resize committed)
      return new Promise<unknown>((res) => {
        resolveQuery = () => res({ width: 10, height: 10 });
      });
    },
  };
  const TTL = 30_000;
  const cache = new CanvasDimsCache(slowClient, FALLBACK, TTL, () => now);

  // T=0: new WS connection → resolve() → _fetch() inflight
  const resolvePromise = cache.resolve(CANVAS_ID);

  // T=1: handleGridResize fires set() with authoritative new dims
  now = 1_000;
  cache.set(CANVAS_ID, { width: 20, height: 20 });
  assert.deepEqual(cache.getDimsIfReady(CANVAS_ID), { width: 20, height: 20 }, "set() immediately visible");

  // T=2: stale Convex query completes with old data (10×10, before resize)
  now = 2_000;
  resolveQuery();
  await resolvePromise;

  // Cache must retain the set() value, NOT be overwritten with the stale 10×10
  assert.deepEqual(
    cache.getDimsIfReady(CANVAS_ID),
    { width: 20, height: 20 },
    "_fetch() with stale data must not overwrite a set() that happened after fetch started",
  );
});
