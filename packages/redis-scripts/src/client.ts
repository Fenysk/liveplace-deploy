/**
 * ioredis-coupled Redis contracts shared by the gateway and the persistence
 * worker. These used to live in two near-identical copies (`apps/gateway/src/
 * redis.ts`, `apps/worker/src/redis.ts`) — a producer/consumer contract on the
 * SAME `canvasKeys(slug)` that could drift silently between the two services
 * (audit findings 1b/1c/1d). They belong here, next to the key schema both
 * services already share.
 *
 * This module is the one place in @canvas/redis-scripts that depends on ioredis;
 * the rest is pure key-schema + Lua loaders. The package is already node-only
 * (index.ts reads the Lua files off disk), so the coupling adds no browser risk.
 */
import Redis from "ioredis";
import { canvasKeys } from "./index";

/**
 * Build an ioredis client with the project's standard reconnect policy: stay
 * alive through a Redis blip (`retryStrategy` backs off to a 2s cap) and never
 * give up on an individual command (`maxRetriesPerRequest: null`), so the hot
 * path and the drain loop both survive a transient outage. This single policy
 * was copy-pasted into three call sites; change it here and every service moves
 * together.
 */
export function createRedisClient(url: string): Redis {
  return new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
    retryStrategy: (times: number) => Math.min(times * 200, 2_000),
  });
}

// ── Presence (FEN-33) ────────────────────────────────────────────────────────
// Each gateway instance SETs `presence:inst:{id}` to its local viewer count with
// a TTL (so a crashed instance self-heals); the worker SCANs + sums them off the
// hot path to flush the gallery `viewerCount`. Producer (gateway) and consumer
// (worker) MUST agree on this prefix — hence it lives here, not in either app.

/** Prefix (and SCAN glob root) for per-instance presence keys. */
export const PRESENCE_KEY_PREFIX = "presence:inst:";

/** Per-instance presence key holding that instance's local viewer count. */
export function presenceInstanceKey(instanceId: string): string {
  return `${PRESENCE_KEY_PREFIX}${instanceId}`;
}

// ── Canvas snapshot ──────────────────────────────────────────────────────────

export interface CanvasSnapshot {
  /** Global write sequence the pixels reflect (== the `meta` counter). */
  seq: number;
  /** Palette-indexed canvas, width*height bytes (zero-filled if shorter/absent). */
  pixels: Uint8Array;
}

/**
 * Read the live canvas bitmap + its version atomically (MULTI), so the returned
 * `seq` matches the pixels exactly — no write can interleave between the two
 * reads. A client that applies this snapshot and then every delta with
 * `seq > snapshot.seq` is guaranteed consistent. This is the snapshot source for
 * both the gateway (initial client sync) and the worker (durable snapshots).
 */
export async function readCanvasSnapshot(
  redis: Redis,
  canvasId: string,
  width: number,
  height: number,
): Promise<CanvasSnapshot> {
  const keys = canvasKeys(canvasId);
  const expected = width * height;
  const res = await redis.multi().get(keys.meta).getBuffer(keys.pixels).exec();
  if (!res) throw new Error("MULTI for snapshot read returned null (aborted)");

  const [metaErr, metaRaw] = res[0]!;
  const [pixelsErr, pixelsRaw] = res[1]!;
  if (metaErr) throw metaErr;
  if (pixelsErr) throw pixelsErr;

  const seq = metaRaw ? Number(metaRaw) : 0;
  const pixels = new Uint8Array(expected);
  if (pixelsRaw instanceof Buffer && pixelsRaw.length > 0) {
    // Copy up to `expected`; a shorter bitmap leaves the tail as index 0 (white).
    pixels.set(pixelsRaw.subarray(0, expected));
  }
  return { seq, pixels };
}
