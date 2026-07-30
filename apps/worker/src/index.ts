/**
 * @canvas/worker — the LivePlace persistence worker.
 *
 * Off the hot path (G-A1): a pixel placement only touches Redis; this service
 * moves that data to the durable Convex layer out-of-band. It:
 *   1. restores Redis for every active canvas from the latest durable snapshot on
 *      cold start (FEN-2065: multi-canvas, not just the env-configured default),
 *   2. drains `canvas:{convexId}:stream` → `worker:applyFlush` in idempotent batches
 *      for EACH active canvas, advancing per-canvas durable resume cursors and
 *      trimming drained tails (R2), and
 *   3. periodically snapshots every live canvas for the next cold start.
 *
 * Multi-canvas (FEN-2065): canvases are resolved at boot from Convex
 * (`listActiveCanvases`). One tick iterates all active canvases sequentially
 * (MVP scale: few canvases). Fallback to the env-configured slug when Convex is
 * not yet deployed (bootstrap mode). A single DrainCoalescer serialises all
 * triggers; a nudge from any canvas fires the full multi-canvas tick.
 */
import { hostname } from "node:os";
import type Redis from "ioredis";
import { loadConfig, type WorkerConfig } from "./config.js";
import { ConvexDurable, type ActiveCanvas } from "./convex.js";
import { createRedis, readCanvasSnapshot, readGlobalViewerCount } from "./redis.js";
import { drainOnce } from "./drain.js";
import { buildAndRecord, shouldSnapshot, type SnapshotState, type SnapshotPolicy } from "./snapshot.js";
import { buildAndRecordThumbnail } from "./thumbnail.js";
import { restoreIfNeeded } from "./restore.js";
import { rebuildAtBoot } from "./rebuild.js";
import { flushLockKey, withLock } from "./lock.js";
import { DrainCoalescer, subscribeFlushRequests } from "./nudge.js";
import { flushRequestChannel } from "@canvas/redis-scripts";

function log(msg: string, extra?: Record<string, unknown>): void {
  const line = extra ? `${msg} ${JSON.stringify(extra)}` : msg;
  console.log(`[worker] ${line}`);
}

// ────────────────────────── Boot phases ──────────────────────────

function logStartup(cfg: WorkerConfig): void {
  log("starting (multi-canvas)", { slug: cfg.slug, convex: cfg.convexUrl, flushMs: cfg.flushIntervalMs });
  if (!cfg.internalSecret) {
    log("GATEWAY_INTERNAL_SECRET unset — durable Convex calls will be rejected until configured");
  }
}

async function runRebuildPhase(cfg: WorkerConfig, redis: Redis, convex: ConvexDurable): Promise<void> {
  // FEN-1576: gated hard-rebuild-from-placements. When REBUILD_SLUGS is set (a
  // supervised, one-shot maintenance run — DEFAULT UNSET → skipped), replay each
  // slug's CORRECTED durable placements from v0, overwrite the (comingled) Redis
  // grid, and record a fresh snapshot. This runs BEFORE the normal cold-start
  // restore below so the rebuilt grid is already live (restore then no-ops:
  // `meta` exists). Reconstructs at the ENGINE geometry (cfg.width/height, 512² —
  // FEN-1584), NOT the incoherent durable F2 dims.
  //
  // FEN-1586: rebuildAtBoot wraps each slug in a BOUNDED readiness retry so a cold
  // force-deploy (worker boots before convex-deploy seeds GATEWAY_INTERNAL_SECRET)
  // no longer soft-fails silently — it retries the seed window, then either runs or
  // emits an explicit scrapeable FEN1586_REBUILD_ABORTED line. Never crashes boot.
  await rebuildAtBoot(
    {
      slugs: cfg.rebuildSlugs,
      width: cfg.width,
      height: cfg.height,
      secretPresent: cfg.internalSecret.length > 0,
      maxAttempts: cfg.rebuildMaxAttempts,
      retryDelayMs: cfg.rebuildRetryDelayMs,
      force: cfg.rebuildForce,
      forceEmpty: cfg.rebuildForceEmpty,
    },
    { redis, convex, log },
  );
}

// ────────────────────────── Per-canvas runtime ──────────────────────────

interface PerCanvasRuntime {
  slug: string;
  /** Convex _id used as the Redis key namespace (canvas:{redisCanvasId}:*). */
  redisCanvasId: string;
  width: number;
  height: number;
  cursor: string;
  snapState: SnapshotState;
  snapPolicy: SnapshotPolicy;
}

/**
 * Resolve all active canvases from Convex and initialise per-canvas runtime
 * state (cursor + snapshot bookkeeping). Falls back to the env-configured slug
 * when Convex is not yet deployed or returns an empty list (bootstrap mode).
 */
async function loadCanvasMap(
  cfg: WorkerConfig,
  convex: ConvexDurable,
): Promise<Map<string, PerCanvasRuntime>> {
  let active: ActiveCanvas[] = [];
  try {
    active = await convex.listActiveCanvases();
    log("active canvases from Convex", { count: active.length, slugs: active.map((c) => c.slug) });
  } catch (err) {
    log("listActiveCanvases failed; falling back to env slug", { err: String(err) });
  }

  // Bootstrap fallback: Convex unreachable or no canvases yet.
  if (active.length === 0) {
    active = [{ canvasId: cfg.slug, slug: cfg.slug, width: cfg.width, height: cfg.height }];
    log("no active canvases from Convex; using env fallback", { slug: cfg.slug });
  }

  const map = new Map<string, PerCanvasRuntime>();
  for (const canvas of active) {
    let cursor = "0";
    let lastVersion = 0;
    try {
      cursor = (await convex.getFlushState(canvas.slug))?.lastStreamId ?? "0";
    } catch (err) {
      log("getFlushState failed; starting cursor at 0", { slug: canvas.slug, err: String(err) });
    }
    try {
      lastVersion = (await convex.getLatestSnapshot(canvas.slug))?.version ?? 0;
    } catch (err) {
      log("getLatestSnapshot failed; lastVersion=0", { slug: canvas.slug, err: String(err) });
    }
    map.set(canvas.slug, {
      slug: canvas.slug,
      redisCanvasId: canvas.canvasId,
      width: canvas.width,
      height: canvas.height,
      cursor,
      snapState: { lastVersion, lastAtMs: Date.now() },
      snapPolicy: {
        intervalMs: cfg.snapshotIntervalMs,
        everyNVersions: cfg.snapshotEveryNVersions,
      },
    });
    log("canvas state loaded", {
      slug: canvas.slug,
      redisCanvasId: canvas.canvasId,
      cursor,
      lastVersion,
    });
  }
  return map;
}

async function runRestorePhases(
  cfg: WorkerConfig,
  redis: Redis,
  convex: ConvexDurable,
  canvases: Map<string, PerCanvasRuntime>,
): Promise<void> {
  for (const canvas of canvases.values()) {
    try {
      const r = await restoreIfNeeded(
        redis,
        convex,
        canvas.slug,
        canvas.width,
        canvas.height,
        5_000,
        canvas.redisCanvasId,
      );
      log("restore", { slug: canvas.slug, ...(r as unknown as Record<string, unknown>) });
    } catch (err) {
      log("restore failed (continuing; gateway can bootstrap)", { slug: canvas.slug, err: String(err) });
    }
  }
}

// ────────────────────────── Mutable runtime ──────────────────────────

interface WorkerRuntime {
  canvases: Map<string, PerCanvasRuntime>;
  stopping: boolean;
}

// ────────────────────────── Runtime closures ──────────────────────

function makeTick(
  cfg: WorkerConfig,
  redis: Redis,
  convex: ConvexDurable,
  token: string,
  rt: WorkerRuntime,
): () => Promise<void> {
  return async function tick(): Promise<void> {
    if (rt.stopping) return;
    // Sequential over all active canvases — MVP scale: few canvases.
    for (const canvas of rt.canvases.values()) {
      if (rt.stopping) break;
      try {
        await withLock(
          redis,
          flushLockKey(canvas.redisCanvasId),
          token,
          Math.max(5_000, cfg.flushIntervalMs * 3),
          async () => {
            // Drain repeatedly within a tick until the stream is empty (bounded so
            // one canvas can't starve the loop).
            let guard = 0;
            let newestActivityTs = 0;
            for (;;) {
              const out = await drainOnce(
                {
                  redis,
                  convex,
                  slug: canvas.slug,
                  redisCanvasId: canvas.redisCanvasId,
                  maxBatch: cfg.flushMaxBatch,
                  now: Date.now,
                  log,
                },
                canvas.cursor,
              );
              canvas.cursor = out.cursor;
              if (out.newestPlacementTs > newestActivityTs) newestActivityTs = out.newestPlacementTs;
              if (out.inserted > 0 || out.dropped > 0) {
                log("drained", {
                  slug: canvas.slug,
                  inserted: out.inserted,
                  dropped: out.dropped,
                  maxVersion: out.maxVersion,
                });
              }
              if (out.empty || !out.canvasFound || out.read < cfg.flushMaxBatch) break;
              if (++guard >= 50) {
                log("drain guard hit; yielding to next tick", { slug: canvas.slug });
                break;
              }
            }

            // F12 gallery activity (FEN-33): advance lastActivityAt to the newest
            // drained placement. Off the hot path + best-effort.
            if (newestActivityTs > 0) {
              try {
                await convex.setGalleryFields(canvas.slug, { lastActivityAt: newestActivityTs });
              } catch (err) {
                log("gallery activity flush failed (ignored)", { slug: canvas.slug, err: String(err) });
              }
            }

            // Re-resolve durable geometry — the canvas may have been resized since
            // boot and the snapshot must use the current dims (FEN-1802).
            try {
              const fresh = await convex.getCanvasDurable(canvas.slug);
              if (fresh && (fresh.width !== canvas.width || fresh.height !== canvas.height)) {
                log("canvas geometry changed; updating before snapshot", {
                  slug: canvas.slug,
                  oldW: canvas.width,
                  oldH: canvas.height,
                  newW: fresh.width,
                  newH: fresh.height,
                });
                canvas.width = fresh.width;
                canvas.height = fresh.height;
              }
            } catch {
              // best-effort; keep current geometry for this snapshot
            }

            // Snapshot policy: read the current head + pixels atomically.
            const now = Date.now();
            const { seq } = await readCanvasSnapshot(redis, canvas.redisCanvasId, canvas.width, canvas.height);
            if (shouldSnapshot(seq, canvas.snapState, canvas.snapPolicy, now)) {
              const res = await buildAndRecord(
                redis,
                convex,
                canvas.slug,
                canvas.width,
                canvas.height,
                now,
                canvas.redisCanvasId,
              );
              canvas.snapState.lastVersion = res.version;
              canvas.snapState.lastAtMs = now;
              log("snapshot recorded", { slug: canvas.slug, version: res.version, bytes: res.bytes });

              // Derive the gallery thumbnail from the snapshot we just built (FEN-33).
              if (cfg.thumbnailMaxLongSide > 0) {
                try {
                  const t = await buildAndRecordThumbnail(
                    convex,
                    canvas.slug,
                    res.version,
                    res.blob,
                    cfg.thumbnailMaxLongSide,
                  );
                  if (t) log("thumbnail recorded", { slug: canvas.slug, version: res.version, ...t });
                } catch (err) {
                  log("thumbnail failed (ignored)", { slug: canvas.slug, version: res.version, err: String(err) });
                }
              }
            }
          },
        );
      } catch (err) {
        log("tick error for canvas (will retry)", { slug: canvas.slug, err: String(err) });
      }
    }
  };
}

function makeViewersTick(
  redis: Redis,
  convex: ConvexDurable,
  rt: WorkerRuntime,
): () => Promise<void> {
  // F12 gallery viewer count (FEN-33): periodically flush the live presence total
  // (summed from the gateway's per-instance `presence:inst:*` keys) onto each
  // active canvas's F2 row. The gateway uses a global count (all clients across all
  // canvases), so each canvas row receives the same total for now; per-canvas
  // presence namespacing is a future gateway extension. Best-effort: a failed
  // read/write just leaves the last value. Runs outside the flush lock — it's an
  // independent, idempotent presence level.
  let inViewers = false;
  return async function viewersTick(): Promise<void> {
    if (rt.stopping || inViewers) return;
    inViewers = true;
    try {
      const viewerCount = await readGlobalViewerCount(redis);
      for (const canvas of rt.canvases.values()) {
        try {
          const r = await convex.setGalleryFields(canvas.slug, { viewerCount });
          if (r.updated) log("gallery viewers flushed", { slug: canvas.slug, viewerCount });
        } catch (err) {
          log("gallery viewers flush failed (ignored)", { slug: canvas.slug, err: String(err) });
        }
      }
    } catch (err) {
      log("gallery viewers read failed (ignored)", { err: String(err) });
    } finally {
      inViewers = false;
    }
  };
}

function makeShutdown(
  redis: Redis,
  rt: WorkerRuntime,
  drainer: DrainCoalescer,
  timer: ReturnType<typeof setInterval>,
  viewersTimer: ReturnType<typeof setInterval>,
  flushSubs: Array<{ close(): Promise<void> }>,
): (sig: string) => Promise<void> {
  return async function shutdown(sig: string): Promise<void> {
    if (rt.stopping) return;
    rt.stopping = true;
    log("shutting down", { sig });
    clearInterval(timer);
    clearInterval(viewersTimer);
    // Close all per-canvas flush nudge subscriptions.
    await Promise.all(flushSubs.map((sub) => sub.close().catch(() => {})));
    const deadline = Date.now() + 5_000;
    while (drainer.isRunning && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await redis.quit().catch(() => redis.disconnect());
    process.exit(0);
  };
}

// ────────────────────────── Entry point ──────────────────────────

async function main(): Promise<void> {
  const cfg = loadConfig();
  const redis = createRedis(cfg.redisUrl);
  const convex = new ConvexDurable(cfg.convexUrl, cfg.internalSecret);
  const token = `${hostname()}-${process.pid}`;

  logStartup(cfg);
  await runRebuildPhase(cfg, redis, convex);

  const canvases = await loadCanvasMap(cfg, convex);
  await runRestorePhases(cfg, redis, convex, canvases);

  const rt: WorkerRuntime = { canvases, stopping: false };

  const tick = makeTick(cfg, redis, convex, token, rt);
  const viewersTick = makeViewersTick(redis, convex, rt);

  // Single coalescer for all canvases: a nudge from any canvas fires the full
  // multi-canvas tick. At MVP scale (few canvases, sequential tick) the extra
  // work per nudge is negligible and simplifies the subscription model.
  const drainer = new DrainCoalescer(tick);
  const timer = setInterval(() => void drainer.trigger(), cfg.flushIntervalMs);

  // Subscribe to the flush-request channel for EACH active canvas. The gateway
  // publishes on `canvas:{convexId}:flush:request` (using the Convex _id as the
  // channel key), so we subscribe on `flushRequestChannel(redisCanvasId)`.
  const flushSubs: Array<{ close(): Promise<void> }> = [];
  for (const canvas of rt.canvases.values()) {
    try {
      const sub = await subscribeFlushRequests(
        cfg.redisUrl,
        flushRequestChannel(canvas.redisCanvasId),
        () => void drainer.trigger(),
        log,
      );
      flushSubs.push(sub);
    } catch (err) {
      log("flush nudge subscribe failed for canvas (continuing on timer only)", {
        slug: canvas.slug,
        err: String(err),
      });
    }
  }

  const viewersTimer = setInterval(() => void viewersTick(), cfg.viewerFlushIntervalMs);

  const shutdown = makeShutdown(redis, rt, drainer, timer, viewersTimer, flushSubs);
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
