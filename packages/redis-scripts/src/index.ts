/**
 * @canvas/redis-scripts — the Redis key schema, channel names, and loaders for
 * the atomic hot-path Lua scripts. Frozen in Phase 1 to unblock the Backend
 * hire. See docs/contracts/redis-keys.md for the full schema.
 *
 * The pixel gauge (token bucket) follows decision D1; the refill arithmetic
 * lives in ./gauge.ts (the unit-tested source of truth) and is mirrored by the
 * Lua scripts loaded below.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GaugeParams } from "./gauge";

export {
  type GaugeParams,
  type GaugeState,
  type StoredGauge,
  DEFAULT_GAUGE,
  refillGauge,
  grantCharges,
  nextRefillAt,
} from "./gauge";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadScript(name: string): string {
  return readFileSync(join(__dirname, "scripts", name), "utf8");
}

/** Atomic placement + gauge consume. Load once, then EVALSHA. */
export const PLACE_LUA: string = loadScript("place.lua");

/** Read-only gauge snapshot for display (current/max/countdown). */
export const REFILL_PEEK_LUA: string = loadScript("refill-peek.lua");

/**
 * Atomic grant of N charges to a user's gauge (tier claim, Lot D / FEN-130).
 * Refills to `now`, adds `grant` charges clamped to the effective max, persists.
 * Used by the gateway's `/internal/gauge/claim` seam after Convex confirms a
 * tier claim — the celebration's +1 usable charge. Load once, then EVALSHA.
 */
export const GRANT_LUA: string = loadScript("grant.lua");

/**
 * Atomic bulk overwrite + fan-out for the moderation suite (F8.1/F8.2/F8.3:
 * ban+wipe, delete, restore). Single critical section; rides the same
 * DELTA_CHANNEL + coalescer as place.lua so a wipe reaches clients as one
 * bulkDelta. Load once, then EVALSHA.
 */
export const MODERATE_LUA: string = loadScript("moderate.lua");

// ─────────────────────────────────────────────────────────────────────────────
// Key schema. Keep all key construction here so every service agrees.
//
// Per-canvas keys are derived from the canvas id (ADR-0003). The canvas id is the
// gateway's GATEWAY_CANVAS_ID, fixed equal to the F2 `slug` (ADR-0001) — the same
// value the persistence worker addresses Convex by — so the hot-path keys and the
// durable side agree without a translation table. `canvasKeys(id)` is the single
// source of truth, ported from the worker (FEN-17) lineage; every service builds
// its keys here.
// ─────────────────────────────────────────────────────────────────────────────

/** Default canvas id when GATEWAY_CANVAS_ID is unset (local smoke / single canvas). */
export const DEFAULT_CANVAS_ID = "default";

/** The per-canvas Redis keys the hot path and the worker share. */
export interface CanvasKeys {
  /** The canvas bitmap: one Redis string, 1 byte/pixel, row-major (offset = y*W + x). */
  pixels: string;
  /**
   * Monotonic write counter == the canvas version / global delta sequence.
   * place.lua / moderate.lua INCR it per write and stamp each delta + stream
   * record with the result, so its value is "the version of the most recent
   * write". The gateway reads it next to the bitmap to label a snapshot for
   * resync (F7/FEN-13); the worker reads it as the canvas head version. (A plain
   * integer string today; the "meta" name leaves room to grow it into a hash
   * without moving the key.)
   */
  meta: string;
  /**
   * Durable per-canvas placement stream (R2). place.lua XADDs one entry per
   * accepted placement carrying the FULL record {x,y,color,version,userId,ts};
   * the persistence worker (FEN-17) drains it to Convex in idempotent batches
   * keyed on `version`. This is the DURABILITY path — distinct from the
   * ephemeral DELTA_CHANNEL pub/sub, which stays the realtime fan-out path.
   */
  stream: string;
  /**
   * Emergency-freeze flag (F8.4). `"1"` = placement is closed for everyone;
   * absent/falsey = open. place.lua reads it before touching the gauge so a
   * moderator's freeze/unfreeze takes effect on the very next placement (CA4).
   * A single SET/DEL on this key is the whole freeze action.
   */
  frozen: string;
  /**
   * Per-canvas ban set (F4 CA6) — a Redis SET of banned `userId`s. `place.lua`
   * `SISMEMBER`s the placer against it before touching the gauge, so a banned
   * viewer's placement is rejected (`banned`) atomically on the very next write,
   * across every gateway instance. This is the hot-path ENFORCEMENT side; the
   * durable source of truth is the Convex `bans` table and the set is POPULATED
   * (SADD on ban, SREM on unban) by the moderation ban-push gateway endpoint
   * (FEN-19). Absent/empty set = nobody banned.
   */
  bans: string;
}

/**
 * Build every per-canvas Redis key from the canvas id (= GATEWAY_CANVAS_ID = F2
 * `slug`, ADR-0001/ADR-0003). Ported from the worker lineage so the gateway hot
 * path and the worker drain agree on the exact key namespace.
 */
export function canvasKeys(canvasId: string): CanvasKeys {
  return {
    pixels: `canvas:${canvasId}:pixels`,
    meta: `canvas:${canvasId}:meta`,
    stream: `canvas:${canvasId}:stream`,
    frozen: `canvas:${canvasId}:frozen`,
    bans: `canvas:${canvasId}:bans`,
  };
}

/**
 * Per-(canvas, user, op) idempotency key (F4 CA5). `place.lua` claims it with
 * `SET … NX` the instant before it commits a placement; a replay of the SAME
 * client op (e.g. an optimistic client resending an un-acked placement after a
 * reconnect) finds the key already set and is answered with the prior `ok`
 * WITHOUT consuming a second charge or fanning out a second delta — so one
 * client op places exactly once. The `opId` is the client-supplied opaque `cid`
 * (FEN-63: a UUID or `${sessionId}:${n}`, gateway-mapped from `place.cid`; only
 * used as an idempotency key when present and non-empty — a naive client that
 * omits it keeps placing normally). `opId` is treated as an opaque string here,
 * so this layer is agnostic to whether it is a `cid` or any other op token.
 * Short-TTL'd: it only needs to outlive the client's retry window, not be permanent.
 */
export function userOpKey(canvasId: string, userId: string, opId: string): string {
  return `canvas:${canvasId}:op:${userId}:${opId}`;
}

/**
 * Per-user gauge hash: { c = charges, ts = refill clock epoch ms }. The upgrade
 * bonus is NOT stored here — it lives in Convex (F6) and the gateway folds it
 * into the effective max passed to the scripts. The gauge is per-user (not
 * per-canvas) in the single-canvas MVP, so it keeps its own flat key.
 */
export function userGaugeKey(userId: string): string {
  return `gauge:${userId}`;
}

/**
 * Pub/sub channel carrying individual pixel writes ("seq,x,y,color") for the
 * realtime fan-out (F7/FEN-13). Kept global and ephemeral by design (FEN-54 #3):
 * the durable, per-canvas record lives on the `stream` key instead, so this
 * channel never has to grow `userId`/`ts` or become per-canvas.
 */
export const DELTA_CHANNEL = "canvas:deltas";

/**
 * Per-canvas pub/sub channel the gateway nudges the persistence worker on before
 * a mass moderation action (F8 / FEN-19). The moderation seam publishes a
 * best-effort message here (ModerationService.requestFlush); the worker (FEN-71)
 * subscribes on a dedicated connection and drains `canvas:{id}:stream` → Convex
 * immediately instead of waiting for its poll tick, narrowing the freshness
 * window for Convex's "what was underneath" derivation. Per-canvas (unlike the
 * global DELTA_CHANNEL) so a nudge only wakes the drain for the affected canvas.
 * Correctness never depends on it — moderate.lua streams overwrites durably and
 * in version order, so the worker persists everything eventually regardless; the
 * nudge only reduces latency. Shared here so gateway and worker agree on the name.
 */
export function flushRequestChannel(canvasId: string): string {
  return `canvas:${canvasId}:flush:request`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Durable placement stream record (R2). The shape place.lua XADDs and the
// persistence worker drains. Field order here MUST match the XADD in place.lua.
// ─────────────────────────────────────────────────────────────────────────────

/** Field names of a placement stream entry, in XADD order. */
export const STREAM_FIELDS = ["x", "y", "color", "version", "userId", "ts"] as const;

/** One durable placement, as carried by a `canvas:{id}:stream` entry. */
export interface PlacementStreamRecord {
  x: number;
  y: number;
  color: number;
  /** Global monotonic write sequence (== the `meta` counter at write time). */
  version: number;
  /** Authenticated placer; "" if none was threaded (anonymous never places). */
  userId: string;
  /** Epoch ms the placement was accepted (place.lua's nowMs). */
  ts: number;
}

/**
 * Parse the flat [field, value, field, value, …] array ioredis returns for a
 * stream entry's fields (the second element of each XRANGE/XREAD tuple) into a
 * PlacementStreamRecord. Unknown/extra fields are ignored; missing numerics
 * become NaN so a malformed entry is detectable rather than silently 0.
 */
export function parseStreamRecord(fields: ReadonlyArray<string>): PlacementStreamRecord {
  const m = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) m.set(fields[i]!, fields[i + 1]!);
  return {
    x: Number(m.get("x")),
    y: Number(m.get("y")),
    color: Number(m.get("color")),
    version: Number(m.get("version")),
    userId: m.get("userId") ?? "",
    ts: Number(m.get("ts")),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed wrappers for the script results.
// ─────────────────────────────────────────────────────────────────────────────

export type PlaceStatus =
  | "ok"
  | "cooldown"
  | "out_of_bounds"
  | "invalid_color"
  | "frozen"
  | "banned";

export interface PlaceResult {
  status: PlaceStatus;
  /** Charges remaining after the call. */
  charges: number;
  /** Effective max (base + bonus) in force this call. */
  max: number;
  /** Epoch ms the next charge lands (0 = full). On reject, when placement reopens. */
  cooldownUntil: number;
}

/** Parse the raw [status, charges, max, cooldownUntil] array from place.lua. */
export function parsePlaceResult(raw: unknown): PlaceResult {
  const arr = raw as [string, number | string, number | string, number | string];
  return {
    status: arr[0] as PlaceStatus,
    charges: Number(arr[1]),
    max: Number(arr[2]),
    cooldownUntil: Number(arr[3]),
  };
}

export interface PeekResult {
  /** Current charges after a virtual refill. */
  charges: number;
  /** Effective max (base + bonus). */
  max: number;
  /** Epoch ms the next charge lands (0 = full). */
  cooldownUntil: number;
}

/** Parse the raw [charges, max, cooldownUntil] array from refill-peek.lua. */
export function parsePeekResult(raw: unknown): PeekResult {
  const arr = raw as [number | string, number | string, number | string];
  return {
    charges: Number(arr[0]),
    max: Number(arr[1]),
    cooldownUntil: Number(arr[2]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EVAL/EVALSHA argument builders. KEYS/ARGV order must match the Lua headers.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build args for place.lua.
 * KEYS = [pixels, userGaugeKey, meta, frozen, stream, bans, op]; ARGV as
 * documented in the script. `meta` feeds the monotonic per-write version used
 * for reconnect/resync (FEN-13) AND stamped onto each durable stream record
 * (R2); the frozen flag (F8.4) lets a moderator close placement for everyone
 * with a single SET; the `bans` set (F4 CA6) is `SISMEMBER`-checked to reject a
 * banned placer; the `op` key (F4 CA5) is `SET … NX`-claimed for exactly-once
 * placement. The authenticated `userId` is threaded into the gauge key, the ban
 * check and the stream record (ARGV) so the worker's placement log carries the
 * placer (FEN-54 #2).
 *
 * `canvasId` defaults to DEFAULT_CANVAS_ID for single-canvas/local use; a caller
 * serving a specific canvas (GATEWAY_CANVAS_ID set) MUST pass it so placements
 * land on the SAME per-canvas keys the gateway's snapshot read uses.
 *
 * `opId` is the client's opaque `cid` correlation (F4 CA5, FEN-63). Pass it ONLY
 * when it is a stable per-placement id (a non-empty opaque string); omit/leave
 * empty for a naive client and idempotency is simply not engaged. When empty the
 * op KEYS slot is `""` and the script skips the claim. `opTtlMs` bounds how long a
 * claim is remembered (the client's retry window); 0 = no expiry.
 */
export function placeArgs(opts: {
  x: number;
  y: number;
  width: number;
  height: number;
  color: number;
  paletteSize: number;
  nowMs: number;
  gauge: GaugeParams;
  userId: string;
  canvasId?: string;
  deltaChannel?: string;
  opId?: string;
  opTtlMs?: number;
}): { keys: [string, string, string, string, string, string, string]; argv: string[] } {
  const canvasId = opts.canvasId ?? DEFAULT_CANVAS_ID;
  const k = canvasKeys(canvasId);
  const opId = opts.opId ?? "";
  // Empty op slot ("") when no idempotency id is supplied; the script guards on
  // it so the slot stays positional without ever being touched.
  const opKey = opId === "" ? "" : userOpKey(canvasId, opts.userId, opId);
  return {
    keys: [k.pixels, userGaugeKey(opts.userId), k.meta, k.frozen, k.stream, k.bans, opKey],
    argv: [
      String(opts.x),
      String(opts.y),
      String(opts.width),
      String(opts.height),
      String(opts.color),
      String(opts.paletteSize),
      String(opts.nowMs),
      String(opts.gauge.refillIntervalMs),
      String(opts.gauge.refillAmount),
      String(opts.gauge.gaugeMax),
      String(opts.gauge.gaugeTtlMs),
      opts.deltaChannel ?? DELTA_CHANNEL,
      opts.userId,
      opId,
      String(opts.opTtlMs ?? 0),
    ],
  };
}

/**
 * Build args for refill-peek.lua.
 * KEYS = [userGaugeKey]; ARGV as documented in the script.
 */
export function peekArgs(opts: {
  nowMs: number;
  gauge: GaugeParams;
  userId: string;
}): { keys: [string]; argv: string[] } {
  return {
    keys: [userGaugeKey(opts.userId)],
    argv: [
      String(opts.nowMs),
      String(opts.gauge.refillIntervalMs),
      String(opts.gauge.refillAmount),
      String(opts.gauge.gaugeMax),
    ],
  };
}

/**
 * Build args for grant.lua (tier claim, FEN-130).
 * KEYS = [userGaugeKey]; ARGV = [now, interval, amount, gaugeMax, grant, ttl].
 * `gauge.gaugeMax` MUST be the effective max (base + the just-raised bonus) the
 * gateway resolves after the claim; the script clamps the grant to it. `grant`
 * is the number of charges to add (the claim's `granted` delta, board default 1).
 * The reply is the same `[charges, max, cooldownUntil]` shape as refill-peek
 * (parse with `parsePeekResult`) — a post-grant gauge snapshot to push to the client.
 */
export function grantArgs(opts: {
  nowMs: number;
  gauge: GaugeParams;
  userId: string;
  grant: number;
}): { keys: [string]; argv: string[] } {
  return {
    keys: [userGaugeKey(opts.userId)],
    argv: [
      String(opts.nowMs),
      String(opts.gauge.refillIntervalMs),
      String(opts.gauge.refillAmount),
      String(opts.gauge.gaugeMax),
      String(opts.grant),
      String(opts.gauge.gaugeTtlMs),
    ],
  };
}

/** A single cell a moderation action overwrites: position + the colour to write. */
export interface ModerationCell {
  x: number;
  y: number;
  /** Palette index to write: 0/white to wipe, or the previous colour to restore. */
  color: number;
}

export interface ModerateResult {
  /** Cells actually written. `applied < cells.length` signals a malformed batch. */
  applied: number;
  /** Write sequence of the last applied cell (0 if none applied). */
  lastSeq: number;
}

/**
 * Build args for moderate.lua — the atomic bulk overwrite behind ban+wipe,
 * delete and restore (F8.1–F8.3). KEYS = [pixels, meta, stream]; ARGV = [width,
 * height, paletteSize, deltaChannel, userId, ts, count, x,y,color, …]. The caller
 * (gateway, on a Convex-authorised moderation action) supplies the cells and the
 * colours to write; the script applies them to the same per-canvas bitmap/version
 * as place.lua, XADDs each to the durable `stream` and fans them out atomically on
 * the shared DELTA_CHANNEL.
 *
 * Durability (binding invariant, docs/contracts/moderation-internal.md): every
 * overwritten cell is XADDed to the per-canvas `stream` with the same
 * {x,y,color,version,userId,ts} shape place.lua uses, so the persistence worker
 * drains moderation overwrites into `placements` just like placements — keeping
 * resync and "what was underneath" consistent. `actorUserId` stamps the stream
 * record; it defaults to "" (system / moderation overwrite — the moderation HTTP
 * seam carries no per-moderator id, and the real actor is in the Convex auditLog).
 * Pass `streamKey: false` to skip the durable write (unit harnesses).
 */
export function moderateArgs(opts: {
  width: number;
  height: number;
  paletteSize: number;
  canvasId?: string;
  cells: ReadonlyArray<ModerationCell>;
  deltaChannel?: string;
  actorUserId?: string;
  nowMs: number;
  /** Set false to omit the durable stream KEYS slot (no XADD). Defaults to true. */
  streamKey?: boolean;
}): { keys: [string, string, string]; argv: string[] } {
  const k = canvasKeys(opts.canvasId ?? DEFAULT_CANVAS_ID);
  const argv: string[] = [
    String(opts.width),
    String(opts.height),
    String(opts.paletteSize),
    opts.deltaChannel ?? DELTA_CHANNEL,
    opts.actorUserId ?? "",
    String(opts.nowMs),
    String(opts.cells.length),
  ];
  for (const c of opts.cells) {
    argv.push(String(c.x), String(c.y), String(c.color));
  }
  const stream = opts.streamKey === false ? "" : k.stream;
  return { keys: [k.pixels, k.meta, stream], argv };
}

/** Parse the raw [applied, lastSeq] array from moderate.lua. */
export function parseModerateResult(raw: unknown): ModerateResult {
  const arr = raw as [number | string, number | string];
  return { applied: Number(arr[0]), lastSeq: Number(arr[1]) };
}
