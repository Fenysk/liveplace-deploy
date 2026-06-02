/**
 * The at-least-once drain cycle: Redis `canvas:{slug}:stream` → Convex
 * `worker:applyFlush`, advancing a durable resume cursor (ADR-0003 / FEN-47).
 *
 * Ordering matters for correctness (R2):
 *   1. XREAD brand-new entries strictly after the cursor.
 *   2. applyFlush — the durable, idempotent write (dup-skip on `version`). It
 *      also advances `flushState.lastStreamId` server-side, so the cursor is
 *      authoritative in Convex and survives a worker crash.
 *   3. Advance the local cursor and trim the stream tail ONLY after the flush
 *      confirms `canvasFound` — a crash before step 2 simply redelivers.
 *
 * If the slug has no canvas row yet (`canvasFound: false`), applyFlush is a
 * server-side no-op; we leave the cursor and stream untouched and retry next
 * cycle (canvases:createCanvas is the sole row creator — the worker waits).
 */
import type Redis from "ioredis";
import { assembleBatch } from "./stream.js";
import { readNew, trimStream } from "./redis.js";
import type { ConvexDurable } from "./convex.js";

export interface DrainDeps {
  redis: Redis;
  convex: ConvexDurable;
  slug: string;
  maxBatch: number;
  /** Injected clock so the path stays deterministic under test. */
  now: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface DrainOutcome {
  /** True when nothing was read this cycle (caller may idle). */
  empty: boolean;
  /** True when the durable canvas row exists (false → flush was a no-op). */
  canvasFound: boolean;
  /** Placements newly inserted into Convex (dup-skipped excluded). */
  inserted: number;
  /** Total entries read from the stream this cycle (incl. dropped poison). */
  read: number;
  /** Malformed entries dropped from the payload (still advance the cursor). */
  dropped: number;
  /** Highest version drained this cycle (0 if none). */
  maxVersion: number;
  /** The cursor after this cycle (unchanged from input if nothing advanced). */
  cursor: string;
}

/**
 * One drain cycle against the current `cursor`. Returns the (possibly advanced)
 * cursor the caller must thread into the next cycle.
 */
export async function drainOnce(d: DrainDeps, cursor: string): Promise<DrainOutcome> {
  const entries = await readNew(d.redis, d.slug, cursor, d.maxBatch);
  if (entries.length === 0) {
    return { empty: true, canvasFound: true, inserted: 0, read: 0, dropped: 0, maxVersion: 0, cursor };
  }

  let dropped = 0;
  const batch = assembleBatch(entries, (id, reason) => {
    dropped++;
    d.log?.("dropped malformed stream entry", { id, reason });
  });

  // lastId is always set here (entries.length > 0), but type-guard for safety.
  if (!batch.lastId) {
    return { empty: true, canvasFound: true, inserted: 0, read: entries.length, dropped, maxVersion: 0, cursor };
  }

  // Durable write. Idempotent on (canvasId, version); also advances the durable
  // resume cursor server-side. Throws on transport failure → cursor unchanged →
  // redelivered next cycle.
  const res = await d.convex.applyFlush(d.slug, batch.lastId, batch.placements, d.now());

  if (!res.canvasFound) {
    // No F2 row for this slug yet. Don't advance/trim — wait for createCanvas.
    d.log?.("applyFlush no-op: no canvas row for slug", { slug: d.slug, pending: entries.length });
    return {
      empty: false,
      canvasFound: false,
      inserted: 0,
      read: entries.length,
      dropped,
      maxVersion: 0,
      cursor,
    };
  }

  // Flush confirmed → advance the local cursor and trim the drained tail.
  await trimStream(d.redis, d.slug, batch.lastId);

  return {
    empty: false,
    canvasFound: true,
    inserted: res.inserted,
    read: entries.length,
    dropped,
    maxVersion: res.maxVersion,
    cursor: batch.lastId,
  };
}
