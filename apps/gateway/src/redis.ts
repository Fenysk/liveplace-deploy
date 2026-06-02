/**
 * Redis wiring for the gateway: a command connection and a dedicated
 * subscriber (ioredis requires a separate connection once it enters subscribe
 * mode), plus the snapshot read and presence helpers.
 */
import Redis from "ioredis";
import { canvasKeys } from "@canvas/redis-scripts";
import { PRESENCE_KEY_PREFIX, presenceInstanceKey } from "./schema";

export interface RedisPair {
  cmd: Redis;
  sub: Redis;
}

export function createRedisPair(url: string): RedisPair {
  // retryStrategy keeps the gateway alive through a Redis blip; the subscriber
  // resubscribes and the ring buffer is reset on reconnect (see gateway.ts).
  const opts = {
    lazyConnect: false,
    maxRetriesPerRequest: null as null,
    retryStrategy: (times: number) => Math.min(times * 200, 2_000),
  };
  return { cmd: new Redis(url, opts), sub: new Redis(url, opts) };
}

export interface CanvasSnapshot {
  /** Global write sequence the pixels reflect. */
  seq: number;
  /** Palette-indexed canvas, width*height bytes (zero-filled if absent). */
  pixels: Uint8Array;
}

/**
 * Read the canvas and its sequence atomically (MULTI), so the returned `seq`
 * matches the returned pixels exactly — no write can interleave between the two
 * reads. A client that applies this snapshot and then every delta with
 * seq > snapshot.seq is guaranteed consistent.
 */
export async function readCanvasSnapshot(
  cmd: Redis,
  canvasId: string,
  width: number,
  height: number,
): Promise<CanvasSnapshot> {
  const keys = canvasKeys(canvasId);
  const expected = width * height;
  const res = await cmd
    .multi()
    .get(keys.meta)
    .getBuffer(keys.pixels)
    .exec();
  if (!res) throw new Error("MULTI for snapshot read returned null (aborted)");

  const [counterErr, counterRaw] = res[0]!;
  const [bitmapErr, bitmapRaw] = res[1]!;
  if (counterErr) throw counterErr;
  if (bitmapErr) throw bitmapErr;

  const seq = counterRaw ? Number(counterRaw) : 0;

  const pixels = new Uint8Array(expected);
  if (bitmapRaw instanceof Buffer && bitmapRaw.length > 0) {
    // Copy up to `expected`; a shorter bitmap leaves the tail as index 0 (white).
    pixels.set(bitmapRaw.subarray(0, expected));
  }
  return { seq, pixels };
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
