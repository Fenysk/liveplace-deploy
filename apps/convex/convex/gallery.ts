/**
 * Public gallery — canvas discovery (F12 / FEN-23).
 *
 * A single paginated query that lists every **public + active** canvas, ordered
 * by recent activity, with the pre-generated thumbnail URL, streamer identity,
 * and live viewer count needed to render a discovery card (CA1). Each item
 * carries the `slug` the web app routes to on click (CA2 → `/c/{slug}`).
 *
 * Business rules / projection live in `./lib/gallery.ts` (pure, unit-tested).
 * This handler is a thin I/O wrapper: index scan → join profile → resolve the
 * thumbnail blob URL. The thumbnail is NEVER rendered here (G-Perf3); the canvas
 * row only points at a blob the worker pre-rendered off the hot path.
 *
 * Cost note: the streamer-profile lookup and `storage.getUrl` run once per item,
 * but the work is bounded by `paginationOpts.numItems` (a page of cards, not the
 * whole table), so there is no unbounded N+1.
 */
import { query } from "./_generated/server";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { toGalleryItem } from "./lib/gallery";
import { getProfileByAuthUserId } from "./lib/profiles";
import { CANVAS_STATUS } from "./schema";

/**
 * Safety cap: if a canvas has more placement log rows than this, skip the
 * inline pixel grid to avoid exceeding Convex read budgets. Only triggered
 * on large/very-active canvases — MVP canvases with few pixels never hit it.
 */
const PIXEL_GRID_MAX_PLACEMENTS = 5000;

/**
 * Shared join: resolve the canvas owner's profile and twitchLive flag.
 *
 * Both `listPublicCanvases` and `listHomeCanvases` need this pair (FEN-2058/N5).
 * Returns profile=null gracefully when the profiles row doesn't exist yet.
 */
async function resolveGalleryOwner(
  ctx: QueryCtx,
  ownerId: string,
): Promise<{ profile: Doc<"profiles"> | null; twitchLive: boolean }> {
  const profile = await getProfileByAuthUserId(ctx.db, ownerId);
  let twitchLive = false;
  if (profile?.twitchId) {
    const ss = await ctx.db
      .query("streamStatus")
      .withIndex("by_twitchId", (q) => q.eq("twitchId", profile.twitchId))
      .unique();
    twitchLive = ss?.isLive ?? false;
  }
  return { profile, twitchLive };
}

/**
 * Build the current pixel grid from the placements log (FEN-1877 — Option A).
 *
 * Scans all placements ordered by version ascending (`by_canvas_version` index);
 * since later entries overwrite earlier ones at the same (x,y), one pass gives
 * the live grid state without per-cell dedup tracking.
 *
 * Returns a flat row-major array of palette indices (length = width × height,
 * index = y * width + x, 0 = empty/erased). Returns null when the placement
 * count exceeds PIXEL_GRID_MAX_PLACEMENTS (safety cap for very active canvases).
 *
 * Anonymous-safe: reads only the public placements log, no auth required.
 */
async function fetchPixelGridForGallery(
  ctx: QueryCtx,
  canvasId: Id<"canvases">,
  width: number,
  height: number,
): Promise<number[] | null> {
  const rows = await ctx.db
    .query("placements")
    .withIndex("by_canvas_version", (q) => q.eq("canvasId", canvasId))
    .collect();
  if (rows.length > PIXEL_GRID_MAX_PLACEMENTS) return null;

  // Ascending version order means the last write at each cell is the current state.
  const grid = new Array<number>(width * height).fill(0);
  for (const p of rows) {
    if (p.x >= 0 && p.x < width && p.y >= 0 && p.y < height) {
      grid[p.y * width + p.x] = p.color;
    }
  }
  return grid;
}

/**
 * Pixel grid for a single canvas, fetched on demand by gallery cards (B5).
 *
 * Extracted from the inline N+1 pattern in `listPublicCanvases` /
 * `listHomeCanvases`. Clients call this per card after the gallery feed has
 * loaded, so the initial list query is not blocked by placements scans.
 *
 * Returns null when the canvas does not exist or exceeds the
 * PIXEL_GRID_MAX_PLACEMENTS safety cap. Anonymous-safe.
 */
export const pixelGridForCanvas = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const canvas = await ctx.db
      .query("canvases")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!canvas) return null;
    const pixelGrid = await fetchPixelGridForGallery(
      ctx,
      canvas._id,
      canvas.width,
      canvas.height,
    );
    return { pixelGrid, width: canvas.width, height: canvas.height };
  },
});

/**
 * Paginated public-canvas discovery feed, most-active first.
 *
 * Returns Convex's standard pagination envelope `{ page, isDone, continueCursor }`
 * where `page` is an array of `GalleryItem` cards. Anonymous-safe: no auth
 * required and no private field is ever surfaced (allow-list projection, CA2).
 */
export const listPublicCanvases = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const result = await ctx.db
      .query("canvases")
      // All active canvases, ordered by lastActivityAt; `.order("desc")` → newest
      // activity first (CA: "tri par activité"). Index keeps pagination correct.
      // FEN-685: isPublic filter removed — personal canvases default private, so
      // filtering on it excluded every existing canvas from discovery.
      // FEN-1994: reverted FEN-1971 0-pixel exclusion — empty canvases must appear
      // with the FE empty-state card (PublicGalleryGrid handles pixelGrid=[0…]).
      .withIndex("by_status_activity", (q) => q.eq("status", CANVAS_STATUS.ACTIVE))
      .order("desc")
      .paginate(paginationOpts);

    const page = await Promise.all(
      result.page.map(async (canvas: Doc<"canvases">) => {
        const { profile: streamer, twitchLive } = await resolveGalleryOwner(ctx, canvas.ownerId);
        const thumbnailUrl = canvas.thumbnailStorageId
          ? await ctx.storage.getUrl(canvas.thumbnailStorageId)
          : null;
        // Fallback for client-side rendering when no worker thumbnail exists yet.
        // Fetch the latest durable snapshot blob URL; the web client decodes it
        // and renders pixels directly into a <canvas> element (anonymous-safe).
        const latestSnapshot = await ctx.db
          .query("snapshots")
          .withIndex("by_canvas", (q) => q.eq("canvasId", canvas._id))
          .order("desc")
          .first();
        const latestSnapshotUrl = latestSnapshot
          ? await ctx.storage.getUrl(latestSnapshot.storageId)
          : null;
        return {
          ...toGalleryItem(canvas, streamer, thumbnailUrl, latestSnapshotUrl, twitchLive),
          width: canvas.width,
          height: canvas.height,
        };
      }),
    );

    return { ...result, page };
  },
});

/**
 * Home live-discovery feed (G6 / FEN-611).
 *
 * Non-paginated; returns the top 50 public+active canvases ordered by recent
 * activity. Used to populate the "En live maintenant" and "Toutes les chaînes"
 * rails on the home discovery page. Lighter than `listPublicCanvases`: no
 * streamer-profile join, no pagination envelope.
 *
 * - `totalPixels`: `cellCount` (current non-empty cells — best available proxy).
 * - `contributors`: `viewerCount` when > 0, else `null` (mask the badge per AC4).
 * - `lastActivityAt`: falls back to `createdAt` when never written by the worker.
 *
 * Ops seam (D5): DevOps reads `totalPixels` via this query for prod cellCount
 * readback (e.g. `convex run gallery:listHomeCanvases`). Do not remove.
 */
export const listHomeCanvases = query({
  args: {},
  handler: async (ctx) => {
    const canvases = await ctx.db
      .query("canvases")
      // FEN-685: filter by status only; isPublic was blocking every canvas (default false).
      .withIndex("by_status_activity", (q) => q.eq("status", CANVAS_STATUS.ACTIVE))
      .order("desc")
      .take(50);

    const rawItems = await Promise.all(
      canvases.map(async (canvas: Doc<"canvases">) => {
        const thumbnailUrl = canvas.thumbnailStorageId
          ? await ctx.storage.getUrl(canvas.thumbnailStorageId)
          : null;
        const vc = canvas.viewerCount;
        // FEN-1868: resolve twitchLive from streamStatus (A7: defaults false).
        const { twitchLive } = await resolveGalleryOwner(ctx, canvas.ownerId);
        return {
          slug: canvas.slug,
          name: canvas.title,
          thumbnailUrl: thumbnailUrl ?? null,
          totalPixels: canvas.cellCount,
          contributors: typeof vc === "number" && vc > 0 ? vc : null,
          lastActivityAt:
            typeof canvas.lastActivityAt === "number"
              ? canvas.lastActivityAt
              : canvas.createdAt,
          twitchLive,
          width: canvas.width,
          height: canvas.height,
        };
      }),
    );

    // FEN-1994: reverted FEN-1935 0-pixel exclusion — all active canvases must
    // appear; the FE renders an empty-state card when pixelGrid is all zeros.
    return rawItems;
  },
});
