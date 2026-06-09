/**
 * Redis wiring for the gateway: a command connection and a dedicated
 * subscriber (ioredis requires a separate connection once it enters subscribe
 * mode), plus the snapshot read and presence helpers.
 */
import Redis from "ioredis";
import { createRedisClient, PRESENCE_KEY_PREFIX, presenceInstanceKey } from "@canvas/redis-scripts";

// The atomic canvas-snapshot reader is shared with the worker, owned by
// @canvas/redis-scripts (audit 1c). Re-exported so existing `./redis` imports
// (gateway.ts) keep resolving from one source.
export { readCanvasSnapshot, type CanvasSnapshot } from "@canvas/redis-scripts";

export interface RedisPair {
  cmd: Redis;
  sub: Redis;
}

export function createRedisPair(url: string): RedisPair {
  // Two connections from the shared factory (ioredis needs a dedicated socket
  // once it enters subscribe mode); the factory carries the standard reconnect
  // policy so a Redis blip is survived identically across services (audit 1d).
  return { cmd: createRedisClient(url), sub: createRedisClient(url) };
}

/** Publish this instance's local viewer count with a TTL so a crash self-heals. */
export async function writePresence(
  cmd: Redis,
  instanceId: string,
  localCount: number,
  ttlMs: number,
): Promise<void> {
  await cmd.set(presenceInstanceKey(instanceId), String(localCount), "PX", ttlMs);
}

export async function clearPresence(cmd: Redis, instanceId: string): Promise<void> {
  await cmd.del(presenceInstanceKey(instanceId));
}

/** Sum all live per-instance presence keys to get the global viewer count. */
export async function readGlobalViewerCount(cmd: Redis): Promise<number> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await cmd.scan(cursor, "MATCH", `${PRESENCE_KEY_PREFIX}*`, "COUNT", 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");

  if (keys.length === 0) return 0;
  const values = await cmd.mget(keys);
  return values.reduce((sum, v) => sum + (v ? Number(v) || 0 : 0), 0);
}
