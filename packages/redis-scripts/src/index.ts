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
 * Atomic bulk overwrite + fan-out for the moderation suite (F8.1/F8.2/F8.3:
 * ban+wipe, delete, restore). Single critical section; rides the same
 * DELTA_CHANNEL + coalescer as place.lua so a wipe reaches clients as one
 * bulkDelta. Load once, then EVALSHA.
 */
export const MODERATE_LUA: string = loadScript("moderate.lua");

// ─────────────────────────────────────────────────────────────────────────────
// Key schema. Keep all key construction here so every service agrees.
// ─────────────────────────────────────────────────────────────────────────────

/** The canvas itself: one Redis string, 1 byte/pixel, row-major (offset = y*W + x). */
export const CANVAS_BITMAP_KEY = "canvas:bitmap";

/**
 * Per-user gauge hash: { c = charges, ts = refill clock epoch ms }. The upgrade
 * bonus is NOT stored here — it lives in Convex (F6) and the gateway folds it
 * into the effective max passed to the scripts.
 */
export function userGaugeKey(userId: string): string {
  return `gauge:${userId}`;
}

/**
 * Monotonic counter of total writes. Also the global delta sequence: place.lua
 * INCRs it per write and stamps each published delta with the result, so its
 * value is "the seq of the most recent write". The gateway reads it next to the
 * bitmap to label a snapshot for resync (F7/FEN-13).
 */
export const CANVAS_WRITE_COUNTER_KEY = "canvas:writes:count";

/** Pub/sub channel carrying individual pixel writes ("seq,x,y,color") for fan-out. */
export const DELTA_CHANNEL = "canvas:deltas";

/**
 * Emergency-freeze flag (F8.4). `"1"` = placement is closed for everyone;
 * absent/falsey = open. place.lua reads it before touching the gauge so a
 * moderator's freeze/unfreeze takes effect on the very next placement (CA4).
 * A single SET/DEL on this key is the whole freeze action.
 */
export const CANVAS_FROZEN_KEY = "canvas:frozen";

// ─────────────────────────────────────────────────────────────────────────────
// Typed wrappers for the script results.
// ─────────────────────────────────────────────────────────────────────────────

export type PlaceStatus = "ok" | "cooldown" | "out_of_bounds" | "invalid_color" | "frozen";

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
 * KEYS = [canvasBitmapKey, userGaugeKey, writeCounterKey, frozenFlagKey]; ARGV as
 * documented in the script. The write counter feeds the monotonic per-write
 * sequence used for reconnect/resync (FEN-13); the frozen flag (F8.4) lets a
 * moderator close placement for everyone with a single SET.
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
  deltaChannel?: string;
}): { keys: [string, string, string, string]; argv: string[] } {
  return {
    keys: [CANVAS_BITMAP_KEY, userGaugeKey(opts.userId), CANVAS_WRITE_COUNTER_KEY, CANVAS_FROZEN_KEY],
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
 * delete and restore (F8.1–F8.3). KEYS = [canvasBitmapKey, writeCounterKey];
 * ARGV = [width, height, paletteSize, deltaChannel, count, x,y,color, …]. The
 * caller (gateway, on a Convex-authorised moderation action) supplies the cells
 * and the colours to write; the script applies and fans them out atomically.
 */
export function moderateArgs(opts: {
  width: number;
  height: number;
  paletteSize: number;
  cells: ReadonlyArray<ModerationCell>;
  deltaChannel?: string;
}): { keys: [string, string]; argv: string[] } {
  const argv: string[] = [
    String(opts.width),
    String(opts.height),
    String(opts.paletteSize),
    opts.deltaChannel ?? DELTA_CHANNEL,
    String(opts.cells.length),
  ];
  for (const c of opts.cells) {
    argv.push(String(c.x), String(c.y), String(c.color));
  }
  return { keys: [CANVAS_BITMAP_KEY, CANVAS_WRITE_COUNTER_KEY], argv };
}

/** Parse the raw [applied, lastSeq] array from moderate.lua. */
export function parseModerateResult(raw: unknown): ModerateResult {
  const arr = raw as [number | string, number | string];
  return { applied: Number(arr[0]), lastSeq: Number(arr[1]) };
}
