/**
 * Persistence-worker configuration, parsed once from the environment.
 *
 * The worker reads the same `GATEWAY_CANVAS_ID` env var the gateway uses, so the
 * hot-path producer and the durable consumer point at the same default canvas.
 * Since FEN-1564/1613 the per-canvas Redis key namespace (`canvasKeys`, ADR-0003)
 * is the canvas Convex `_id`, NOT the human `slug` — ADR-0001's "canvasId == slug"
 * is historical. The `slug` field below keeps its legacy name but carries that id
 * value; multi-canvas loops thread a `(slug, redisCanvasId=_id)` pair explicitly.
 */
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "@canvas/protocol";
import { DEFAULT_CANVAS_ID, num, bool } from "@canvas/redis-scripts";

export interface WorkerConfig {
  redisUrl: string;
  /** Convex backend URL (same env var as the gateway: CONVEX_URL). */
  convexUrl: string;
  /**
   * Shared secret authenticating the worker to the `worker:run` Convex action
   * (FEN-86). MUST match `GATEWAY_INTERNAL_SECRET` set on the Convex deployment.
   * Empty in anonymous bootstrap (Convex undeployed) — calls then fail and are
   * tolerated per-tick like any other Convex error.
   */
  internalSecret: string;
  /**
   * Default canvas id == `GATEWAY_CANVAS_ID` == per-canvas key namespace (the
   * Convex `_id` since FEN-1613, not a human slug; field name is legacy). Falls
   * back to DEFAULT_CANVAS_ID for local single-canvas smoke (ADR-0003).
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
  /**
   * FEN-1576 hard-rebuild trigger: comma-separated slugs to rebuild-from-placements
   * once at boot (empty = inert, the normal case). DevOps sets `REBUILD_SLUGS`
   * for a single supervised run after `executeReattribution`, then clears it.
   */
  rebuildSlugs: string[];
  /**
   * FEN-1586: bounded readiness retry for the boot rebuild. On a cold force-deploy
   * the worker only `depends_on convex-backend:healthy`, NOT the `convex-deploy`
   * one-shot, so it can boot before `GATEWAY_INTERNAL_SECRET` is seeded on the
   * Convex side — `worker:run` then rejects and the rebuild used to soft-fail
   * silently (needing a manual restart). We instead retry each slug up to
   * `rebuildMaxAttempts` times, spaced `rebuildRetryDelayMs` apart, before emitting
   * an EXPLICIT (scrapeable) abort line. Defaults give ~30s for the seed to land.
   */
  rebuildMaxAttempts: number;
  rebuildRetryDelayMs: number;
  /**
   * FEN-1598 one-shot bypass. Default false → a slug already carrying a
   * `rebuiltAt:<slug>` marker is skipped, so a crash-loop / forgotten
   * `REBUILD_SLUGS` env cannot replay the destructive rebuild every boot. Set
   * `REBUILD_FORCE=1` for a deliberate re-run despite the marker.
   */
  rebuildForce: boolean;
  /**
   * FEN-1598 anti-wipe bypass. Default false → an empty replay onto a populated
   * live grid ABORTS instead of wiping+snapshotting it (irreversible under the
   * snapshot-only restore). Set `REBUILD_FORCE_EMPTY=1` only when the corrected
   * source of truth really is empty and the operator wants the grid cleared.
   */
  rebuildForceEmpty: boolean;
}

export function loadConfig(): WorkerConfig {
  return {
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    // CONVEX_URL is the canonical name (shared with the gateway); fall back to the
    // legacy CONVEX_SELF_HOSTED_URL for existing local .env files.
    convexUrl: process.env.CONVEX_URL ?? process.env.CONVEX_SELF_HOSTED_URL ?? "http://localhost:3210",
    internalSecret: process.env.GATEWAY_INTERNAL_SECRET || "",
    slug: process.env.GATEWAY_CANVAS_ID || DEFAULT_CANVAS_ID,
    width: num("CANVAS_WIDTH", CANVAS_WIDTH),
    height: num("CANVAS_HEIGHT", CANVAS_HEIGHT),
    flushIntervalMs: num("FLUSH_INTERVAL_MS", 2_000),
    flushMaxBatch: num("FLUSH_MAX_BATCH", 500),
    snapshotIntervalMs: num("SNAPSHOT_INTERVAL_MS", 60_000),
    snapshotEveryNVersions: num("SNAPSHOT_EVERY_N_VERSIONS", 5_000),
    viewerFlushIntervalMs: num("VIEWER_FLUSH_INTERVAL_MS", 10_000),
    thumbnailMaxLongSide: num("THUMBNAIL_MAX_LONG_SIDE", 256),
    rebuildSlugs: (process.env.REBUILD_SLUGS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    rebuildMaxAttempts: num("REBUILD_MAX_ATTEMPTS", 10),
    rebuildRetryDelayMs: num("REBUILD_RETRY_DELAY_MS", 3_000),
    rebuildForce: bool("REBUILD_FORCE", false),
    rebuildForceEmpty: bool("REBUILD_FORCE_EMPTY", false),
  };
}
