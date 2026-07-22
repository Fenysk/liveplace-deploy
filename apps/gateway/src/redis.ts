/**
 * Redis wiring for the gateway: a command connection and a dedicated
 * subscriber (ioredis requires a separate connection once it enters subscribe
 * mode), plus the snapshot read and presence helpers.
 */
import Redis from "ioredis";
import { createRedisClient, presenceInstanceKey } from "@canvas/redis-scripts";

// The atomic canvas-snapshot reader and global viewer-count reader are shared
// with the worker, owned by @canvas/redis-scripts (audit 1c/1d). Re-exported so
// existing `./redis` imports (gateway.ts) keep resolving from one source.
export { readCanvasSnapshot, readGlobalViewerCount } from "@canvas/redis-scripts";

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

