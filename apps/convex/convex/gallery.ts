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
import { paginationOptsValidator } from "convex/server";
import type { Doc } from "./_generated/dataModel";
import { toGalleryItem, type GalleryItem } from "./lib/gallery";

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
      // Public + active, ordered by lastActivityAt; `.order("desc")` → newest
      // activity first (CA: "tri par activité"). Index keeps pagination correct.
      .withIndex("by_public_activity", (q) =>
        q.eq("isPublic", true).eq("status", "active"),
      )
      .order("desc")
      .paginate(paginationOpts);

    const page: GalleryItem[] = await Promise.all(
      result.page.map(async (canvas: Doc<"canvases">) => {
        const streamer = await ctx.db
          .query("profiles")
          .withIndex("by_authUserId", (q) => q.eq("authUserId", canvas.ownerId))
          .unique();
        const thumbnailUrl = canvas.thumbnailStorageId
          ? await ctx.storage.getUrl(canvas.thumbnailStorageId)
          : null;
        return toGalleryItem(canvas, streamer, thumbnailUrl);
      }),
    );

    return { ...result, page };
  },
});
