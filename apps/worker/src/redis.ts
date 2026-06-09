/**
 * Redis wiring + low-level access for the persistence worker. All per-canvas
 * keys come from `canvasKeys(slug)` in `@canvas/redis-scripts` — the single key
 * schema the hot path (place.lua) and the worker share (ADR-0003).
 */
import Redis from "ioredis";
import { canvasKeys, PRESENCE_KEY_PREFIX } from "@canvas/redis-scripts";
import type { RawEntry } from "./stream.js";

// The ioredis client factory and the atomic canvas-snapshot reader now live in
// @canvas/redis-scripts (shared with the gateway, audit 1c/1d). Re-exported here
// under the worker's historical names so existing `./redis.js` imports keep
// working from one source. PRESENCE_KEY_PREFIX (audit 1b) is likewise owned by
// the shared package: the gateway WRITES `presence:inst:{id}`, the worker only
// READS it (FEN-33), so the prefix must agree from one definition.
export {
  createRedisClient as createRedis,
  readCanvasSnapshot,
  type CanvasSnapshot,
} from "@canvas/redis-scripts";

/**
 * Sum the live per-instance presence keys into a single global viewer count
 * (FEN-33). MVP is single-canvas (canvasId == slug), so the global presence sum
 * is that canvas's viewer count; per-canvas presence is a future extension when
 * the gateway namespaces presence by canvas. Stale instances simply expire, so
 * the sum self-corrects. Missing / non-numeric values count as 0. Returns 0 when
 * no instance is live.
 */
export async function readGlobalViewerCount(redis: Redis): Promise<number> {
  const presenceKeys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(
      cursor,
      "MATCH",
      `${PRESENCE_KEY_PREFIX}*`,
      "COUNT",
      100,
    );
    cursor = next;
    presenceKeys.push(...batch);
  } while (cursor !== "0");

  if (presenceKeys.length === 0) return 0;
  const values = await redis.mget(presenceKeys);
  return values.reduce((sum: number, v) => sum + (v ? Number(v) || 0 : 0), 0);
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
