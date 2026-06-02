/**
 * Durable persistence-worker support API (FEN-17 / FEN-47, ADR-0001).
 *
 * The persistence worker is a trusted backend service: it drains the Redis
 * placement stream to Convex in idempotent batches, periodically writes a binary
 * snapshot blob, and restores Redis from durable storage on cold start. These
 * functions are its durable seam. They are PUBLIC (no `ctx.auth`) like the other
 * worker-support functions — the self-hosted Convex is reachable only by trusted
 * services — and OFF the hot path (G-A1: no DB write happens during a pixel
 * placement; the gateway only touches Redis).
 *
 * ADR-0001 (two-master reconciliation): the worker addresses a canvas by its WS
 * `canvasId`, which is fixed equal to the F2 `slug` (enforced operationally by
 * `GATEWAY_CANVAS_ID`). Every function here resolves the F2 `id("canvases")` via
 * `canvases.by_slug` and writes to the F2-`_id`-keyed side tables
 * (`placements` / `snapshots` / `flushState`) and the F2 `userCanvasStats`. The
 * retired worker lineage's string-keyed `canvases` / `userCanvasStats` /
 * `thumbnails` tables are dropped (thumbnails live on the canvas row, see
 * `canvases:setGalleryFields`).
 *
 * Ownership boundary (ADR-0001): if no canvas row matches the slug yet, every
 * mutation is a **no-op** — `canvases:createCanvas` is the sole creator of canvas
 * rows; the worker never manufactures a partial canvas. Reads return null/[].
 */
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { aggregatePlacementCounts } from "./lib/placementAggregate";
import { accruePlacementPoints } from "./points";

/** Resolve the F2 canvas `_id` from the worker's WS `canvasId == slug` (ADR-0001). */
async function resolveCanvasId(ctx: QueryCtx, slug: string): Promise<Id<"canvases"> | null> {
  const row = await ctx.db
    .query("canvases")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
  return row?._id ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Durable write API.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply a batch drained from the Redis stream. Idempotent: a placement already
 * recorded (same canvasId + version) is dup-skipped, so at-least-once redelivery
 * is safe (R2). Returns the highest version seen and how many rows were inserted.
 *
 * Side effect (CA1 accrual): the SAME freshly-inserted placements feed the F2
 * `userCanvasStats` aggregate (points / pixelsPlaced / lastPlacedAt) via the
 * shared `accruePlacementPoints`. Only fresh inserts feed it (dup-skipped
 * redeliveries excluded), so the aggregate stays exactly-once with the placement
 * log inside this single transaction. Gallery `lastActivityAt` is advanced
 * separately by the worker off the newest placement ts (`canvases:setGalleryFields`).
 */
export const applyFlush = mutation({
  args: {
    slug: v.string(),
    lastStreamId: v.string(),
    placements: v.array(
      v.object({
        x: v.number(),
        y: v.number(),
        color: v.number(),
        version: v.number(),
        userId: v.optional(v.string()),
        ts: v.number(),
      }),
    ),
    now: v.number(),
  },
  returns: v.object({
    canvasFound: v.boolean(),
    maxVersion: v.number(),
    inserted: v.number(),
  }),
  handler: async (ctx, a) => {
    const canvasId = await resolveCanvasId(ctx, a.slug);
    if (!canvasId) return { canvasFound: false, maxVersion: 0, inserted: 0 };

    let maxVersion = 0;
    const inserted: Array<{ userId?: string }> = [];
    for (const p of a.placements) {
      if (p.version > maxVersion) maxVersion = p.version;
      const dup = await ctx.db
        .query("placements")
        .withIndex("by_canvas_version", (q) =>
          q.eq("canvasId", canvasId).eq("version", p.version),
        )
        .unique();
      if (dup) continue;
      await ctx.db.insert("placements", { canvasId, ...p });
      inserted.push(p);
    }

    // Fold freshly-inserted placements into the F2 per-user aggregate (CA1).
    for (const d of aggregatePlacementCounts(inserted)) {
      await accruePlacementPoints(ctx, {
        canvasId,
        userId: d.userId,
        count: d.count,
        now: a.now,
      });
    }

    // Advance the resume cursor (monotonic on version).
    const state = await ctx.db
      .query("flushState")
      .withIndex("by_canvas", (q) => q.eq("canvasId", canvasId))
      .unique();
    if (state) {
      await ctx.db.patch(state._id, {
        lastStreamId: a.lastStreamId,
        lastFlushedVersion: Math.max(state.lastFlushedVersion, maxVersion),
        updatedAt: a.now,
      });
    } else {
      await ctx.db.insert("flushState", {
        canvasId,
        lastStreamId: a.lastStreamId,
        lastFlushedVersion: maxVersion,
        updatedAt: a.now,
      });
    }

    return { canvasFound: true, maxVersion, inserted: inserted.length };
  },
});

/**
 * Record a durable snapshot blob (uploaded via `worker:generateUploadUrl`) and
 * stamp `lastSnapshotAt` on the canvas row. Append-only on `snapshots`; the
 * latest is read back on cold-start restore. `lastSnapshotAt` only advances.
 */
export const recordSnapshot = mutation({
  args: {
    slug: v.string(),
    version: v.number(),
    storageId: v.id("_storage"),
    bytes: v.number(),
    now: v.number(),
  },
  returns: v.object({ canvasFound: v.boolean() }),
  handler: async (ctx, a) => {
    const canvasId = await resolveCanvasId(ctx, a.slug);
    if (!canvasId) return { canvasFound: false };

    await ctx.db.insert("snapshots", {
      canvasId,
      version: a.version,
      storageId: a.storageId,
      bytes: a.bytes,
      createdAt: a.now,
    });

    const canvas = await ctx.db.get(canvasId);
    if (canvas && (canvas.lastSnapshotAt === null || a.now > canvas.lastSnapshotAt)) {
      await ctx.db.patch(canvasId, { lastSnapshotAt: a.now });
    }
    return { canvasFound: true };
  },
});

/** Short-lived upload URL for storing a snapshot blob in Convex file storage. */
export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: (ctx) => ctx.storage.generateUploadUrl(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Restore / resume reads.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Durable canvas meta the worker needs to restore Redis (geometry + slug). The
 * live hot-path config (palette / cooldown / gauge) is NOT stored on the F2 row
 * — it is canvas/Redis config the gateway owns — so it is intentionally absent
 * here. Returns null if the slug has no canvas row.
 */
export const getCanvasDurable = query({
  args: { slug: v.string() },
  returns: v.union(
    v.object({
      canvasId: v.id("canvases"),
      slug: v.string(),
      width: v.number(),
      height: v.number(),
      status: v.union(v.literal("active"), v.literal("archived")),
      lastSnapshotAt: v.union(v.number(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, a) => {
    const row = await ctx.db
      .query("canvases")
      .withIndex("by_slug", (q) => q.eq("slug", a.slug))
      .unique();
    if (!row) return null;
    return {
      canvasId: row._id,
      slug: row.slug,
      width: row.width,
      height: row.height,
      status: row.status,
      lastSnapshotAt: row.lastSnapshotAt,
    };
  },
});

/**
 * Latest durable snapshot for a canvas + a temporary download URL for its blob.
 * The worker seeds Redis from it on cold start before replaying newer placements.
 * Returns null if the canvas (or its snapshot) is absent.
 */
export const getLatestSnapshot = query({
  args: { slug: v.string() },
  returns: v.union(
    v.object({
      version: v.number(),
      bytes: v.number(),
      url: v.union(v.string(), v.null()),
      createdAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, a) => {
    const canvasId = await resolveCanvasId(ctx, a.slug);
    if (!canvasId) return null;
    const snap = await ctx.db
      .query("snapshots")
      .withIndex("by_canvas", (q) => q.eq("canvasId", canvasId))
      .order("desc")
      .first();
    if (!snap) return null;
    const url = await ctx.storage.getUrl(snap.storageId);
    return { version: snap.version, bytes: snap.bytes, url, createdAt: snap.createdAt };
  },
});

/**
 * Placements with version strictly greater than `afterVersion`, ascending,
 * bounded by `limit` (clamped to [1, 10000]). Used to replay the tail past the
 * latest snapshot during restore; the caller pages by advancing `afterVersion`.
 */
export const getPlacementsSince = query({
  args: {
    slug: v.string(),
    afterVersion: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, a) => {
    const canvasId = await resolveCanvasId(ctx, a.slug);
    if (!canvasId) return [];
    return ctx.db
      .query("placements")
      .withIndex("by_canvas_version", (q) =>
        q.eq("canvasId", canvasId).gt("version", a.afterVersion),
      )
      .order("asc")
      .take(Math.max(1, Math.min(a.limit, 10000)));
  },
});

/** Flush bookkeeping for a canvas (resume cursor); null if never flushed. */
export const getFlushState = query({
  args: { slug: v.string() },
  returns: v.union(
    v.object({
      lastStreamId: v.string(),
      lastFlushedVersion: v.number(),
      updatedAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, a) => {
    const canvasId = await resolveCanvasId(ctx, a.slug);
    if (!canvasId) return null;
    const state = await ctx.db
      .query("flushState")
      .withIndex("by_canvas", (q) => q.eq("canvasId", canvasId))
      .unique();
    if (!state) return null;
    return {
      lastStreamId: state.lastStreamId,
      lastFlushedVersion: state.lastFlushedVersion,
      updatedAt: state.updatedAt,
    };
  },
});
