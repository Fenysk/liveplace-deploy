/**
 * @canvas/worker — the LivePlace persistence worker.
 *
 * Off the hot path (G-A1): a pixel placement only touches Redis; this service
 * moves that data to the durable Convex layer out-of-band. It:
 *   1. restores the Redis canvas from the latest durable snapshot on cold start,
 *   2. drains `canvas:{slug}:stream` → `worker:applyFlush` in idempotent batches,
 *      advancing a durable resume cursor and trimming the drained tail (R2), and
 *   3. periodically snapshots the live canvas for the next cold start.
 *
 * Single-canvas MVP: one `slug` (= `GATEWAY_CANVAS_ID`), one drain loop. A
 * best-effort Redis lock keeps two instances from double-draining; correctness
 * does not depend on it (the cursor is durable, applyFlush idempotent).
 */
import { hostname } from "node:os";
import { loadConfig } from "./config.js";
import { ConvexDurable } from "./convex.js";
import { createRedis, readCanvasSnapshot } from "./redis.js";
import { drainOnce } from "./drain.js";
import { buildAndRecord, shouldSnapshot, type SnapshotState } from "./snapshot.js";
import { restoreIfNeeded } from "./restore.js";
import { flushLockKey, withLock } from "./lock.js";

function log(msg: string, extra?: Record<string, unknown>): void {
  const line = extra ? `${msg} ${JSON.stringify(extra)}` : msg;
  console.log(`[worker] ${line}`);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const token = `${hostname()}-${process.pid}`;
  const redis = createRedis(cfg.redisUrl);
  const convex = new ConvexDurable(cfg.convexUrl);

  log("starting", { slug: cfg.slug, convex: cfg.convexUrl, flushMs: cfg.flushIntervalMs });

  // Geometry: prefer the durable canvas row; fall back to env for a slug whose
  // row isn't readable yet (the drain itself no-ops until the row exists).
  let { width, height } = cfg;
  try {
    const durable = await convex.getCanvasDurable(cfg.slug);
    if (durable) {
      width = durable.width;
      height = durable.height;
      log("durable canvas geometry", { width, height, status: durable.status });
    } else {
      log("no durable canvas row yet; using env geometry", { width, height });
    }
  } catch (err) {
    log("getCanvasDurable failed; using env geometry", { err: String(err), width, height });
  }

  // Cold-start restore (no-op when Redis already holds the canvas).
  try {
    const r = await restoreIfNeeded(redis, convex, cfg.slug, width, height);
    log("restore", r as unknown as Record<string, unknown>);
  } catch (err) {
    log("restore failed (continuing; gateway can bootstrap)", { err: String(err) });
  }

  // Resume cursor: the durable stream id, or "0" to start from the beginning.
  let cursor = (await convex.getFlushState(cfg.slug))?.lastStreamId ?? "0";
  log("resume cursor", { cursor });

  // Snapshot bookkeeping seeded off the latest durable snapshot.
  const snapState: SnapshotState = {
    lastVersion: (await convex.getLatestSnapshot(cfg.slug))?.version ?? 0,
    lastAtMs: Date.now(),
  };
  const snapPolicy = {
    intervalMs: cfg.snapshotIntervalMs,
    everyNVersions: cfg.snapshotEveryNVersions,
  };

  let stopping = false;
  let ticking = false;

  // Drain repeatedly within a tick until the stream is empty (bounded so one
  // canvas can't starve the loop), then evaluate the snapshot policy. The whole
  // tick runs under the best-effort flush lock.
  async function tick(): Promise<void> {
    if (stopping || ticking) return;
    ticking = true;
    try {
      await withLock(redis, flushLockKey(cfg.slug), token, Math.max(5_000, cfg.flushIntervalMs * 3), async () => {
        let guard = 0;
        for (;;) {
          const out = await drainOnce(
            { redis, convex, slug: cfg.slug, maxBatch: cfg.flushMaxBatch, now: Date.now, log },
            cursor,
          );
          cursor = out.cursor;
          if (out.inserted > 0 || out.dropped > 0) {
            log("drained", { inserted: out.inserted, dropped: out.dropped, maxVersion: out.maxVersion });
          }
          // Stop when the stream is drained, the flush no-op'd (no row yet), or
          // we read a short (sub-batch) page.
          if (out.empty || !out.canvasFound || out.read < cfg.flushMaxBatch) break;
          if (++guard >= 50) {
            log("drain guard hit; yielding to next tick");
            break;
          }
        }

        // Snapshot policy: read the current head + pixels atomically.
        const now = Date.now();
        const { seq } = await readCanvasSnapshot(redis, cfg.slug, width, height);
        if (shouldSnapshot(seq, snapState, snapPolicy, now)) {
          const res = await buildAndRecord(redis, convex, cfg.slug, width, height, now);
          snapState.lastVersion = res.version;
          snapState.lastAtMs = now;
          log("snapshot recorded", { version: res.version, bytes: res.bytes });
        }
      });
    } catch (err) {
      log("tick error (will retry)", { err: String(err) });
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => void tick(), cfg.flushIntervalMs);

  async function shutdown(sig: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    log("shutting down", { sig });
    clearInterval(timer);
    // Let an in-flight tick finish, then close Redis.
    const deadline = Date.now() + 5_000;
    while (ticking && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await redis.quit().catch(() => redis.disconnect());
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
