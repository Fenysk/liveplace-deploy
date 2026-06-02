/**
 * Redis wiring + low-level access for the persistence worker. All per-canvas
 * keys come from `canvasKeys(slug)` in `@canvas/redis-scripts` — the single key
 * schema the hot path (place.lua) and the worker share (ADR-0003).
 */
import Redis from "ioredis";
import { canvasKeys } from "@canvas/redis-scripts";
import type { RawEntry } from "./stream.js";

export function createRedis(url: string): Redis {
  return new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
    retryStrategy: (times: number) => Math.min(times * 200, 2_000),
  });
}

/**
 * Read up to `count` brand-new stream entries strictly after `cursor` (XREAD is
 * exclusive of the given id by design — no off-by-one and no Redis-6.2 exclusive
 * range syntax needed). `cursor` is `flushState.lastStreamId`, or "0" to start
 * from the very beginning. Returns [] when the stream has nothing past `cursor`.
 */
export async function readNew(
  redis: Redis,
  slug: string,
  cursor: string,
  count: number,
): Promise<RawEntry[]> {
  const { stream } = canvasKeys(slug);
  const res = (await redis.xread("COUNT", count, "STREAMS", stream, cursor)) as
    | Array<[key: string, entries: Array<[id: string, fields: string[]]>]>
    | null;
  if (!res || res.length === 0) return [];
  const entries = res[0]?.[1] ?? [];
  return entries.map(([id, fields]) => [id, fields] as RawEntry);
}

/**
 * Trim the durable stream tail AFTER a confirmed Convex flush (R2: never trim
 * undrained entries — place.lua itself never trims). MINID evicts entries with
 * id < `minId`, keeping `minId` as the resume marker; the next XREAD from it is
 * exclusive, so the marker is read once at most and harmlessly skipped.
 */
export async function trimStream(redis: Redis, slug: string, minId: string): Promise<void> {
  const { stream } = canvasKeys(slug);
  await redis.xtrim(stream, "MINID", minId);
}

export interface CanvasSnapshot {
  /** Global write sequence the pixels reflect (== the `meta` counter). */
  seq: number;
  /** Palette-indexed canvas, width*height bytes (zero-filled if shorter). */
  pixels: Uint8Array;
}

/**
 * Read the live canvas bitmap + its version atomically (MULTI), so the returned
 * `seq` matches the pixels exactly — no placement can interleave between the two
 * reads. This is the snapshot source.
 */
export async function readCanvasSnapshot(
  redis: Redis,
  slug: string,
  width: number,
  height: number,
): Promise<CanvasSnapshot> {
  const keys = canvasKeys(slug);
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
    pixels.set(pixelsRaw.subarray(0, expected));
  }
  return { seq, pixels };
}

/** True if the canvas has a live version counter (i.e. Redis holds the canvas). */
export async function metaExists(redis: Redis, slug: string): Promise<boolean> {
  const { meta } = canvasKeys(slug);
  return (await redis.exists(meta)) === 1;
}

// Seed pixels + meta atomically, but ONLY if meta is still absent. Bundling the
// guard and both writes in one Lua section means we can never clobber a canvas
// the gateway revived between our metaExists check and this write — Redis is
// authoritative on the hot path.
const RESTORE_LUA = `
if redis.call("EXISTS", KEYS[1]) == 1 then
  return 0
end
redis.call("SET", KEYS[2], ARGV[1])
redis.call("SET", KEYS[1], ARGV[2])
return 1
`;

/**
 * Seed Redis with a restored bitmap + version on cold start, atomically and only
 * while the canvas is still absent (`meta` missing). Returns true if it wrote.
 */
export async function writeRestoredCanvas(
  redis: Redis,
  slug: string,
  pixels: Uint8Array,
  version: number,
): Promise<boolean> {
  const keys = canvasKeys(slug);
  const wrote = (await redis.eval(
    RESTORE_LUA,
    2,
    keys.meta,
    keys.pixels,
    Buffer.from(pixels),
    String(version),
  )) as number;
  return wrote === 1;
}
