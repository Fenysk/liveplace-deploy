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

// Shared env parsers (pure) and the ioredis-coupled cross-service contracts
// (client factory, presence keys, canvas snapshot) — promoted out of the
// per-app `redis.ts`/`config.ts` copies so producer and consumer share one
// definition (audit findings 1b/1c/1d).
export { num, bool } from "./env";
export {
  createRedisClient,
  PRESENCE_KEY_PREFIX,
  presenceInstanceKey,
  readGlobalViewerCount,
  type CanvasSnapshot,
  readCanvasSnapshot,
} from "./client";

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
 * canvasDeltaChannel + coalescer as place.lua so a wipe reaches clients as one
 * bulkDelta. Load once, then EVALSHA.
 */
export const MODERATE_LUA: string = loadScript("moderate.lua");

/**
 * Atomic row-wise relayout of the canvas pixel buffer on resize (FEN-1806).
 * Reads old[y*oldW+x] → new[y*newW+x] for x < min(oldW,newW), y < min(oldH,newH);
 * crops (shrink) or zero-fills (enlarge) the remainder. Runs as a single atomic
 * GET + rewrite + SET so no concurrent placement can land on the wrong stride
 * between the two operations (R2). Load once, then EVALSHA.
 */
export const GRID_RESIZE_LUA: string = loadScript("grid-resize.lua");

// ─────────────────────────────────────────────────────────────────────────────
// Key schema. Keep all key construction here so every service agrees.
//
// Per-canvas keys are derived from the canvas id (ADR-0003). Since FEN-1564/1613
// the canvas id is the canvas Convex `_id` (NOT the human `slug`; ADR-0001's
// "canvasId == slug" is historical). The gateway's GATEWAY_CANVAS_ID seeds the
// default/single-canvas namespace; in multi-canvas serving each connection's id
// is resolved per-canvas. `canvasKeys(id)` is the single source of truth, ported
// from the worker (FEN-17) lineage; every service builds its keys here.
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
   * ephemeral canvasDeltaChannel pub/sub, which stays the realtime fan-out path.
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
  /**
   * FEN-1598 one-shot rebuild marker — a plain string holding the epoch-ms of
   * the last successful hard rebuild (`hardRebuildFromPlacements`). Scoped to the
   * canvas `_id` (not slug) so it lives in the same `canvas:{id}:*` namespace as
   * the hot-path keys. The worker writes it after a successful rebuild and reads it
   * at boot to skip a redundant replay under `restart: unless-stopped`.
   */
  rebuiltAt: string;
}

/**
 * Build every per-canvas Redis key from the canvas id (the canvas Convex `_id`
 * since FEN-1613; = GATEWAY_CANVAS_ID for the default canvas, ADR-0003). Ported
 * from the worker lineage so the gateway hot path and the worker drain agree on
 * the exact key namespace.
 */
export function canvasKeys(canvasId: string): CanvasKeys {
  return {
    pixels: `canvas:${canvasId}:pixels`,
    meta: `canvas:${canvasId}:meta`,
    stream: `canvas:${canvasId}:stream`,
    frozen: `canvas:${canvasId}:frozen`,
    bans: `canvas:${canvasId}:bans`,
    rebuiltAt: `canvas:${canvasId}:rebuiltAt`,
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
 * Per-(canvas, user) gauge hash: { c = charges, ts = refill clock epoch ms }. The
 * upgrade bonus is NOT stored here — it lives in Convex (F6) and the gateway folds
 * it into the effective max passed to the scripts.
 *
 * The gauge is scoped to the canvas (FEN-1616): the live réserve/cooldown must be
 * independent per canvas, exactly like the durable `userCanvasStats` (points,
 * gaugeMaxBonus) it mirrors. The original single-canvas MVP used a flat
 * `gauge:{userId}` key; that leaked one réserve across every canvas a user visited
 * (place on canvas B → the same charges show on canvas A). Namespacing under
 * `canvas:{canvasId}:` gives each (canvas, user) its own bucket. Keep this in the
 * SAME namespace as {@link canvasKeys} so a per-canvas key sweep also reaches it.
 */
export function gaugeKey(canvasId: string, userId: string): string {
  return `canvas:${canvasId}:gauge:${userId}`;
}

/**
 * Per-canvas pub/sub channel carrying individual pixel writes ("seq,x,y,color")
 * for the realtime fan-out (F7/FEN-13). Scoped to the canvas so multi-canvas
 * deployments subscribe each gateway instance to exactly the writes for its
 * canvas without cross-canvas noise. The durable, per-canvas record lives on
 * the `stream` key; this channel is ephemeral. Single source of truth for the
 * channel name — imported by both the publisher (place.lua ARGV, moderate.lua
 * ARGV) and the subscriber (gateway's Redis sub connection).
 */
export function canvasDeltaChannel(canvasId: string): string {
  return `canvas:${canvasId}:deltas`;
}

/**
 * Extract the canvasId from a per-canvas delta channel name; `null` if the
 * string is not a delta channel. Co-located with `canvasDeltaChannel` so a
 * schema change to the channel format propagates to both builder and parser.
 */
export function parseCanvasDeltaChannel(channel: string): string | null {
  const m = /^canvas:([^:]+):deltas$/.exec(channel);
  return m ? (m[1] ?? null) : null;
}

/**
 * SCAN pattern for all per-(canvas, user) idempotency keys (F4 CA5). Used by
 * the account-deletion purge to sweep op keys for a specific user without
 * touching other users' keys. Co-located with `userOpKey` so a schema change
 * is caught in one place.
 */
export function canvasUserOpPattern(canvasId: string, userId: string): string {
  return `canvas:${canvasId}:op:${userId}:*`;
}

/**
 * SCAN pattern for the entire per-canvas namespace (`canvas:{id}:*`). Used by
 * the account-deletion purge to wipe an owned canvas wholesale (§3d). The
 * wildcard intentionally covers pixels, meta, stream, frozen, bans, gauges, ops
 * and the one-shot rebuild marker — anything the hot path or the worker wrote.
 * Co-located with `canvasKeys` so a namespace rename is caught here.
 */
export function canvasNamespacePattern(canvasId: string): string {
  return `canvas:${canvasId}:*`;
}

/**
 * Per-canvas pub/sub channel the gateway nudges the persistence worker on before
 * a mass moderation action (F8 / FEN-19). The moderation seam publishes a
 * best-effort message here (ModerationService.requestFlush); the worker (FEN-71)
 * subscribes on a dedicated connection and drains `canvas:{id}:stream` → Convex
 * immediately instead of waiting for its poll tick, narrowing the freshness
 * window for Convex's "what was underneath" derivation. Per-canvas (unlike the
 * global delta channel) so a nudge only wakes the drain for the affected canvas.
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
 * KEYS = [pixels, gaugeKey, meta, frozen, stream, bans, op]; ARGV as
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
  /**
   * Approximate MAXLEN backstop on the durable stream XADD (FEN-651/A8). Caps Redis
   * memory if the worker is down and the post-flush MINID trim stops running. Omitted
   * / 0 = no cap. See docs/contracts/retention.md.
   */
  streamMaxLen?: number;
}): { keys: [string, string, string, string, string, string, string]; argv: string[] } {
  const canvasId = opts.canvasId ?? DEFAULT_CANVAS_ID;
  const k = canvasKeys(canvasId);
  const opId = opts.opId ?? "";
  // Empty op slot ("") when no idempotency id is supplied; the script guards on
  // it so the slot stays positional without ever being touched.
  const opKey = opId === "" ? "" : userOpKey(canvasId, opts.userId, opId);
  return {
    keys: [k.pixels, gaugeKey(canvasId, opts.userId), k.meta, k.frozen, k.stream, k.bans, opKey],
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
      opts.deltaChannel ?? canvasDeltaChannel(canvasId),
      opts.userId,
      opId,
      String(opts.opTtlMs ?? 0),
      String(opts.streamMaxLen ?? 0),
    ],
  };
}

/**
 * Build args for refill-peek.lua.
 * KEYS = [gaugeKey]; ARGV as documented in the script. `canvasId` scopes the
 * gauge to the canvas (FEN-1616); defaults to DEFAULT_CANVAS_ID for single-canvas
 * / local smoke, but a gateway serving a specific canvas MUST pass the connection's
 * canvasId so the peek reads the SAME per-canvas bucket place.lua writes.
 */
export function peekArgs(opts: {
  nowMs: number;
  gauge: GaugeParams;
  userId: string;
  canvasId?: string;
}): { keys: [string]; argv: string[] } {
  return {
    keys: [gaugeKey(opts.canvasId ?? DEFAULT_CANVAS_ID, opts.userId)],
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
 * KEYS = [gaugeKey]; ARGV = [now, interval, amount, gaugeMax, grant, ttl].
 * `gauge.gaugeMax` MUST be the effective max (base + the just-raised bonus) the
 * gateway resolves after the claim; the script clamps the grant to it. `grant`
 * is the number of charges to add (the claim's `granted` delta, board default 1).
 * `canvasId` scopes the gauge to the canvas the tier was claimed on (FEN-1616);
 * defaults to DEFAULT_CANVAS_ID for single-canvas / local smoke.
 * The reply is the same `[charges, max, cooldownUntil]` shape as refill-peek
 * (parse with `parsePeekResult`) — a post-grant gauge snapshot to push to the client.
 */
export function grantArgs(opts: {
  nowMs: number;
  gauge: GaugeParams;
  userId: string;
  grant: number;
  canvasId?: string;
}): { keys: [string]; argv: string[] } {
  return {
    keys: [gaugeKey(opts.canvasId ?? DEFAULT_CANVAS_ID, opts.userId)],
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
 * the per-canvas delta channel (canvasDeltaChannel).
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
  const canvasId = opts.canvasId ?? DEFAULT_CANVAS_ID;
  const k = canvasKeys(canvasId);
  const argv: string[] = [
    String(opts.width),
    String(opts.height),
    String(opts.paletteSize),
    opts.deltaChannel ?? canvasDeltaChannel(canvasId),
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

// ─────────────────────────────────────────────────────────────────────────────
// grid-resize.lua args / result (FEN-1806).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build args for grid-resize.lua — atomic row-wise relayout on canvas resize.
 * KEYS = [pixels]; ARGV = [oldWidth, oldHeight, newWidth, newHeight].
 * `canvasId` defaults to DEFAULT_CANVAS_ID for single-canvas / local smoke.
 */
export function resizeGridArgs(opts: {
  oldWidth: number;
  oldHeight: number;
  newWidth: number;
  newHeight: number;
  canvasId?: string;
}): { keys: [string]; argv: string[] } {
  return {
    keys: [canvasKeys(opts.canvasId ?? DEFAULT_CANVAS_ID).pixels],
    argv: [
      String(opts.oldWidth),
      String(opts.oldHeight),
      String(opts.newWidth),
      String(opts.newHeight),
    ],
  };
}

/** Count of non-zero pixels that survived inside the new canvas bounds. */
export interface ResizeGridResult {
  surviving: number;
}

/** Parse the raw integer returned by grid-resize.lua. */
export function parseResizeGridResult(raw: unknown): ResizeGridResult {
  return { surviving: Number(raw) };
}
