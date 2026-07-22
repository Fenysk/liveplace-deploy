/**
 * Redis wiring + low-level access for the persistence worker. All per-canvas
 * keys come from `canvasKeys(slug)` in `@canvas/redis-scripts` — the single key
 * schema the hot path (place.lua) and the worker share (ADR-0003).
 */
import Redis from "ioredis";
import { canvasKeys } from "@canvas/redis-scripts";
import type { RawEntry } from "./stream.js";

// The ioredis client factory, atomic canvas-snapshot reader, and global
// viewer-count reader now live in @canvas/redis-scripts (shared with the
// gateway, audit 1b/1c/1d). Re-exported here under the worker's historical
// names so existing `./redis.js` imports keep working from one source.
export {
  createRedisClient as createRedis,
  readCanvasSnapshot,
  readGlobalViewerCount,
} from "@canvas/redis-scripts";

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

// UNCONDITIONAL grid overwrite for the FEN-1576 hard rebuild — unlike RESTORE_LUA
// this clobbers the live (comingled) canvas on purpose. The `meta` version is
// advanced MONOTONICALLY: max(existing, requested). Regressing the counter below
// the live head would let a future place.lua INCR re-mint a version already used
// by an earlier (now-corrected) placement, colliding with Convex's version-keyed
// idempotency — so we never lower it. The reconstructed PIXELS are still exactly
// the v0 replay; only the counter is clamped up. Returns the effective version.
const OVERWRITE_LUA = `
local cur = tonumber(redis.call("GET", KEYS[1]) or "0")
local v = tonumber(ARGV[1])
if cur > v then v = cur end
redis.call("SET", KEYS[1], tostring(v))
redis.call("SET", KEYS[2], ARGV[2])
return v
`;

/**
 * Overwrite the Redis canvas grid from a recomputed bitmap, unconditionally
 * (FEN-1576 hard rebuild). Used to replace a comingled/incorrect live grid with
 * one replayed from the corrected durable placements. The version counter only
 * ever moves UP (see OVERWRITE_LUA). Returns the effective version written.
 */
export async function overwriteCanvas(
  redis: Redis,
  slug: string,
  pixels: Uint8Array,
  version: number,
): Promise<number> {
  const keys = canvasKeys(slug);
  const effective = (await redis.eval(
    OVERWRITE_LUA,
    2,
    keys.meta,
    keys.pixels,
    String(version),
    Buffer.from(pixels),
  )) as number;
  return Number(effective);
}

/**
 * FEN-1598 anti-wipe guard — count the PAINTED cells currently in the LIVE Redis
 * grid, so `hardRebuildFromPlacements` can refuse to clobber a populated canvas
 * with an empty replay. Reads the raw pixels buffer (one palette-index byte per
 * cell; 0 == unpainted) and counts non-zero bytes, so it is geometry-agnostic —
 * it needs no width/height and works whatever the grid was seeded at.
 *
 * Returns `{ exists: false, nonEmpty: 0 }` when the pixels key is absent (no live
 * grid to protect — a wipe there loses nothing).
 */
export async function readLiveGridNonEmpty(
  redis: Redis,
  slug: string,
): Promise<{ exists: boolean; nonEmpty: number }> {
  const { pixels } = canvasKeys(slug);
  const buf = await redis.getBuffer(pixels);
  if (!buf) return { exists: false, nonEmpty: 0 };
  let nonEmpty = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) nonEmpty++;
  return { exists: true, nonEmpty };
}

/**
 * Read the FEN-1598 one-shot rebuild marker for a canvas. The key is scoped to
 * the canvas `_id` (via `canvasKeys(canvasId).rebuiltAt`) so it lives in the
 * same `canvas:{id}:*` namespace as the hot-path keys — not under the slug.
 * Returns the stored epoch-ms string or null when no rebuild has run.
 */
export async function readRebuildMarker(redis: Redis, canvasId: string): Promise<string | null> {
  return redis.get(canvasKeys(canvasId).rebuiltAt);
}

/** Stamp the one-shot rebuild marker after a SUCCESSFUL rebuild (idempotent SET). */
export async function writeRebuildMarker(redis: Redis, canvasId: string, at: number): Promise<void> {
  await redis.set(canvasKeys(canvasId).rebuiltAt, String(at));
}
