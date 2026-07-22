/**
 * Durable persistence-worker support API (FEN-17 / FEN-47, ADR-0001).
 *
 * The persistence worker is a trusted backend service: it drains the Redis
 * placement stream to Convex in idempotent batches, periodically writes a binary
 * snapshot blob, and restores Redis from durable storage on cold start. These
 * functions are its durable seam, and OFF the hot path (G-A1: no DB write happens
 * during a pixel placement; the gateway only touches Redis).
 *
 * Trust boundary (FEN-86, security): these are `internal*` functions — NOT
 * reachable from the public `/convex/*` route a browser uses. The worker reaches
 * them ONLY through the single public `run` action at the bottom of this file,
 * which authenticates the caller against the shared `GATEWAY_INTERNAL_SECRET`
 * before dispatching. They were previously exported `mutation`/`query`, i.e.
 * callable by anyone on the internet (forged points/placements, mined upload
 * URLs, leaked placement log); the audit on 2026-06-03 flagged that and this
 * closes it.
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
import { action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { aggregatePlacementCounts, cellCountDelta } from "./lib/placementAggregate";
import { accruePlacementPoints } from "./points";
import { GATEWAY_INTERNAL_SECRET } from "./env";
import { canvasStatusValidator } from "./schema";

/**
 * Snapshot compaction (FEN-651/A8): how many of the newest durable snapshots to keep
 * per canvas. A snapshot is a full canvas image, so older ones are pure storage cost
 * once a newer full snapshot exists — the placement stream + `placements` cover the
 * tail beyond the latest. We keep a few for restore robustness, not history. See
 * docs/contracts/retention.md.
 */
const SNAPSHOT_RETENTION = 5;

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
 * log inside this single transaction. Gallery `lastActivityAt` is advanced to the
 * newest fresh-insert `ts` atomically in the same transaction (FEN-696: previously
 * a separate `setGalleryFields` call that could fail silently; moved here so
 * `lastActivityAt` is guaranteed to advance whenever placements are durably
 * persisted).
 */
export const UNAUTH_applyFlush = internalMutation({
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
    const inserted: Array<{
      x: number;
      y: number;
      color: number;
      version: number;
      userId?: string;
      ts: number;
    }> = [];
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

    // Advance cellCount and gallery lastActivityAt for freshly-inserted placements.
    // Atomic with this transaction: if applyFlush commits, both counters are
    // guaranteed to reflect the drained batch (FEN-696, FEN-1571).
    //
    // cellCount tracks distinct non-empty cells. For each newly inserted
    // placement we look up the cell's most recent prior color via the
    // by_canvas_cell index to detect transitions:
    //   empty→filled  (prevColor=0, color>0) → +1
    //   filled→empty  (prevColor>0, color=0) → −1
    //   filled→filled (prevColor>0, color>0) → 0  (repaint, no change)
    // In-batch ordering is handled naturally: the version range query
    // (.lt("version", p.version)) will find earlier placements from the same
    // batch for the same cell, so multi-hop transitions within one batch
    // resolve correctly.
    if (inserted.length > 0) {
      let newestTs = 0;
      let cellDelta = 0;
      for (const p of inserted) {
        if (p.ts > newestTs) newestTs = p.ts;
        const prev = await ctx.db
          .query("placements")
          .withIndex("by_canvas_cell", (q) =>
            q.eq("canvasId", canvasId).eq("x", p.x).eq("y", p.y).lt("version", p.version),
          )
          .order("desc")
          .first();
        const prevColor = prev?.color ?? 0;
        cellDelta += cellCountDelta(prevColor, p.color);
      }
      const canvas = await ctx.db.get(canvasId);
      if (canvas) {
        const patch: { cellCount?: number; lastActivityAt?: number } = {};
        if (cellDelta !== 0) {
          patch.cellCount = Math.max(0, canvas.cellCount + cellDelta);
        }
        if (newestTs > 0 && newestTs > (canvas.lastActivityAt ?? 0)) {
          patch.lastActivityAt = newestTs;
        }
        if (patch.cellCount !== undefined || patch.lastActivityAt !== undefined) {
          await ctx.db.patch(canvasId, patch);
        }
      }
    }

    return { canvasFound: true, maxVersion, inserted: inserted.length };
  },
});

/**
 * Record a durable snapshot blob (uploaded via `worker:generateUploadUrl`) and
 * stamp `lastSnapshotAt` on the canvas row. Inserts the new snapshot, then compacts
 * to the newest `SNAPSHOT_RETENTION` per canvas (FEN-651/A8) so durable storage stays
 * bounded; the latest is read back on cold-start restore. `lastSnapshotAt` only advances.
 */
export const UNAUTH_recordSnapshot = internalMutation({
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

    // Compaction (FEN-651/A8): keep only the newest SNAPSHOT_RETENTION snapshots for
    // this canvas; delete older rows AND their storage blobs so durable storage stays
    // bounded instead of growing one full-canvas blob per snapshot interval forever.
    // Cheap: we compact on every insert, so the table never holds more than
    // SNAPSHOT_RETENTION+1 rows per canvas. See docs/contracts/retention.md.
    const snaps = await ctx.db
      .query("snapshots")
      .withIndex("by_canvas_version", (q) => q.eq("canvasId", canvasId))
      .order("desc")
      .collect();
    for (const stale of snaps.slice(SNAPSHOT_RETENTION)) {
      await ctx.storage.delete(stale.storageId);
      await ctx.db.delete(stale._id);
    }

    const canvas = await ctx.db.get(canvasId);
    if (canvas && (canvas.lastSnapshotAt === null || a.now > canvas.lastSnapshotAt)) {
      await ctx.db.patch(canvasId, { lastSnapshotAt: a.now });
    }
    return { canvasFound: true };
  },
});

/** Short-lived upload URL for storing a snapshot blob in Convex file storage. */
export const UNAUTH_generateUploadUrl = internalMutation({
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
export const UNAUTH_getCanvasDurable = internalQuery({
  args: { slug: v.string() },
  returns: v.union(
    v.object({
      canvasId: v.id("canvases"),
      slug: v.string(),
      width: v.number(),
      height: v.number(),
      status: canvasStatusValidator,
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
export const UNAUTH_getLatestSnapshot = internalQuery({
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
export const UNAUTH_getPlacementsSince = internalQuery({
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

/**
 * List all active canvases with their durable geometry. Used by the worker on
 * boot to discover which canvases to drain/snapshot (FEN-2065 multi-canvas).
 */
export const UNAUTH_listActiveCanvases = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      canvasId: v.id("canvases"),
      slug: v.string(),
      width: v.number(),
      height: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("canvases")
      .withIndex("by_status_activity", (q) => q.eq("status", "active"))
      .collect();
    return rows.map((row) => ({
      canvasId: row._id,
      slug: row.slug,
      width: row.width,
      height: row.height,
    }));
  },
});

/** Flush bookkeeping for a canvas (resume cursor); null if never flushed. */
export const UNAUTH_getFlushState = internalQuery({
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

// ─────────────────────────────────────────────────────────────────────────────
// Trusted worker RPC seam (FEN-86).
// ─────────────────────────────────────────────────────────────────────────────

/** Constant-time string compare (length leak only) so the secret check below
 * doesn't short-circuit on the first differing byte. */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The persistence worker's single entry point into the durable seam (FEN-86).
 *
 * Why an action (and not a public deploy/admin key on the worker's
 * `ConvexHttpClient`, nor a `.site` httpAction): this keeps the worker on the
 * exact client + `CONVEX_SELF_HOSTED_URL` it already uses (no new networking, no
 * over-broad admin key in the worker container, no reliance on the untyped
 * private `setAdminAuth`). The action is callable from the public `/convex/*`
 * route, but is **inert without the shared secret** (`GATEWAY_INTERNAL_SECRET`):
 * it authenticates, then forwards to the `internal*` worker/canvases functions
 * via `ctx.runMutation`/`ctx.runQuery`. Those functions keep their own strict
 * arg validators, which run on dispatch.
 *
 * `fn` is validated as a union of known literals — the Convex runtime rejects
 * unknown fn names before the handler runs. `args` is left as `v.any()` because
 * each downstream `internal*` function owns its own strict validator; the
 * dispatcher trusts the internal layer, not the wire args shape.
 *
 * OFF the hot path (worker drain loop, ~every 2s) — the extra action→function
 * hop costs nothing the gateway/players can feel.
 */
export const run = action({
  args: {
    secret: v.string(),
    fn: v.union(
      v.literal("applyFlush"),
      v.literal("recordSnapshot"),
      v.literal("generateUploadUrl"),
      v.literal("setGalleryFields"),
      v.literal("getCanvasDurable"),
      v.literal("getLatestSnapshot"),
      v.literal("getPlacementsSince"),
      v.literal("getFlushState"),
      v.literal("listActiveCanvases"),
      v.literal("lookupProfileByLogin"),
      v.literal("diagnoseTwitchToken"),
    ),
    args: v.any(),
  },
  handler: async (ctx, a): Promise<unknown> => {
    const expected = GATEWAY_INTERNAL_SECRET;
    if (!expected || !secretsMatch(a.secret, expected)) {
      throw new Error("worker:run unauthorized");
    }
    switch (a.fn) {
      case "applyFlush":
        return ctx.runMutation(internal.worker.UNAUTH_applyFlush, a.args);
      case "recordSnapshot":
        return ctx.runMutation(internal.worker.UNAUTH_recordSnapshot, a.args);
      case "generateUploadUrl":
        return ctx.runMutation(internal.worker.UNAUTH_generateUploadUrl, {});
      case "setGalleryFields":
        return ctx.runMutation(internal.canvases.UNAUTH_setGalleryFields, a.args);
      case "getCanvasDurable":
        return ctx.runQuery(internal.worker.UNAUTH_getCanvasDurable, a.args);
      case "getLatestSnapshot":
        return ctx.runQuery(internal.worker.UNAUTH_getLatestSnapshot, a.args);
      case "getPlacementsSince":
        return ctx.runQuery(internal.worker.UNAUTH_getPlacementsSince, a.args);
      case "getFlushState":
        return ctx.runQuery(internal.worker.UNAUTH_getFlushState, a.args);
      case "listActiveCanvases":
        return ctx.runQuery(internal.worker.UNAUTH_listActiveCanvases, {});
      // FEN-1737: one-shot Helix diagnostic — captures real error string (scope vs config).
      case "lookupProfileByLogin":
        return ctx.runQuery(internal.moderationDiag.UNAUTH_lookupProfileByLogin, a.args);
      case "diagnoseTwitchToken":
        return ctx.runAction(internal.moderationDiag.UNAUTH_diagnoseTwitchToken, a.args);
    }
  },
});
