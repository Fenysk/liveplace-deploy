/**
 * @canvas/redis-scripts — the Redis key schema, channel names, and the loader
 * for the atomic hot-path Lua script. Frozen in Phase 1 to unblock the Backend
 * hire. See docs/contracts/redis-keys.md for the full schema.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Source of the atomic place-pixel script. Load once, then EVALSHA. */
export const PLACE_PIXEL_LUA: string = readFileSync(
  join(__dirname, "scripts", "place-pixel.lua"),
  "utf8",
);

// ─────────────────────────────────────────────────────────────────────────────
// Key schema. Keep all key construction here so every service agrees.
// ─────────────────────────────────────────────────────────────────────────────

/** The canvas itself: one Redis string, 1 byte/pixel, row-major (offset = y*W + x). */
export const CANVAS_BITMAP_KEY = "canvas:bitmap";

/** Per-user gauge hash: { c = charges, ts = regen clock epoch ms }. */
export function userGaugeKey(userId: string): string {
  return `gauge:${userId}`;
}

/** Monotonic counter of total writes (for metrics / flush bookkeeping). */
export const CANVAS_WRITE_COUNTER_KEY = "canvas:writes:count";

/** Pub/sub channel carrying individual pixel writes ("x,y,color") for fan-out. */
export const DELTA_CHANNEL = "canvas:deltas";

// ─────────────────────────────────────────────────────────────────────────────
// Gauge defaults — PROVISIONAL. These are decision D1 (Product Owner). The
// gateway passes them into the script; change them in one place when D1 lands.
// ─────────────────────────────────────────────────────────────────────────────

export interface GaugeParams {
  /** ms to regenerate one charge */
  regenMs: number;
  /** max stockpiled charges */
  maxCharges: number;
  /** TTL (ms) on the gauge hash to reclaim idle users; 0 = never expire */
  gaugeTtlMs: number;
}

export const DEFAULT_GAUGE: GaugeParams = {
  regenMs: 5_000, // provisional — D1
  maxCharges: 1, // provisional — D1 (1 = plain cooldown)
  gaugeTtlMs: 24 * 60 * 60 * 1000,
};

// ─────────────────────────────────────────────────────────────────────────────
// Typed wrapper for the script result.
// ─────────────────────────────────────────────────────────────────────────────

export type PlaceStatus = "ok" | "cooldown" | "out_of_bounds" | "invalid_color";

export interface PlaceResult {
  status: PlaceStatus;
  charges: number;
  cooldownUntil: number;
}

/** Parse the raw [status, charges, cooldownUntil] array returned by the script. */
export function parsePlaceResult(raw: unknown): PlaceResult {
  const arr = raw as [string, number | string, number | string];
  return {
    status: arr[0] as PlaceStatus,
    charges: Number(arr[1]),
    cooldownUntil: Number(arr[2]),
  };
}

/**
 * Build the EVALSHA/EVAL argument list for a placement.
 * KEYS = [canvasBitmapKey, userGaugeKey]; ARGV as documented in the script.
 */
export function placePixelArgs(opts: {
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
}): { keys: [string, string]; argv: string[] } {
  return {
    keys: [CANVAS_BITMAP_KEY, userGaugeKey(opts.userId)],
    argv: [
      String(opts.x),
      String(opts.y),
      String(opts.width),
      String(opts.height),
      String(opts.color),
      String(opts.paletteSize),
      String(opts.nowMs),
      String(opts.gauge.regenMs),
      String(opts.gauge.maxCharges),
      String(opts.gauge.gaugeTtlMs),
      opts.deltaChannel ?? DELTA_CHANNEL,
    ],
  };
}
