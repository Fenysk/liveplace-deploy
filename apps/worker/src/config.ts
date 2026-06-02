/**
 * Persistence-worker configuration, parsed once from the environment.
 *
 * The worker addresses Convex by the canvas `slug`, which is fixed equal to the
 * gateway's `GATEWAY_CANVAS_ID` and the per-canvas Redis key namespace
 * (`canvasKeys`, ADR-0001 / ADR-0003). Reading the same env var the gateway uses
 * is what keeps the hot-path producer and the durable consumer pointed at the
 * same canvas without a translation table.
 */
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "@canvas/protocol";
import { DEFAULT_CANVAS_ID } from "@canvas/redis-scripts";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got "${raw}"`);
  return n;
}

export interface WorkerConfig {
  redisUrl: string;
  /** Self-hosted Convex backend URL (worker calls the public `worker:*` fns). */
  convexUrl: string;
  /**
   * Canvas slug == `GATEWAY_CANVAS_ID` == per-canvas key namespace. Falls back to
   * DEFAULT_CANVAS_ID for local single-canvas smoke (ADR-0003).
   */
  slug: string;
  /** Geometry fallback when the durable canvas row is not yet readable. */
  width: number;
  height: number;
  /** Drain the placement stream every N ms. */
  flushIntervalMs: number;
  /** Max stream entries pulled + written to Convex per drain cycle. */
  flushMaxBatch: number;
  /** Write a durable snapshot at most every N ms (skipped if canvas unchanged). */
  snapshotIntervalMs: number;
  /** Also snapshot once this many versions have accrued since the last one. */
  snapshotEveryNVersions: number;
  /** Flush the live viewer count onto the F2 gallery row every N ms (FEN-33). */
  viewerFlushIntervalMs: number;
  /** Gallery thumbnail long-side cap in px (0 disables thumbnail generation). */
  thumbnailMaxLongSide: number;
}

export function loadConfig(): WorkerConfig {
  return {
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    convexUrl: process.env.CONVEX_SELF_HOSTED_URL ?? "http://localhost:3210",
    slug: process.env.GATEWAY_CANVAS_ID || DEFAULT_CANVAS_ID,
    width: num("CANVAS_WIDTH", CANVAS_WIDTH),
    height: num("CANVAS_HEIGHT", CANVAS_HEIGHT),
    flushIntervalMs: num("FLUSH_INTERVAL_MS", 2_000),
    flushMaxBatch: num("FLUSH_MAX_BATCH", 500),
    snapshotIntervalMs: num("SNAPSHOT_INTERVAL_MS", 60_000),
    snapshotEveryNVersions: num("SNAPSHOT_EVERY_N_VERSIONS", 5_000),
    viewerFlushIntervalMs: num("VIEWER_FLUSH_INTERVAL_MS", 10_000),
    thumbnailMaxLongSide: num("THUMBNAIL_MAX_LONG_SIDE", 256),
  };
}
