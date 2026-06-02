import type Redis from "ioredis";

/**
 * Best-effort distributed lock so two worker instances never drain or snapshot
 * the same canvas concurrently (G-Perf4). Correctness does not depend on it —
 * the resume cursor lives durably in Convex and `applyFlush` is idempotent on
 * `(canvasId, version)`, so a double-drain is safe — but the lock avoids wasted
 * work and snapshot races.
 *
 * `SET key token NX PX ttl` acquires; release is a check-and-del so a worker
 * only frees its own lock. The TTL bounds the blast radius if a holder dies
 * mid-cycle.
 */
const RELEASE_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export function flushLockKey(slug: string): string {
  return `lock:flush:${slug}`;
}

export async function withLock<T>(
  redis: Redis,
  key: string,
  token: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const ok = await redis.set(key, token, "PX", ttlMs, "NX");
  if (ok !== "OK") return null; // someone else holds it — skip this tick
  try {
    return await fn();
  } finally {
    await redis.eval(RELEASE_LUA, 1, key, token);
  }
}
