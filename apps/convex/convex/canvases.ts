/**
 * Canvas lifecycle & configuration (F2 / FEN-12).
 *
 * Functions: createCanvas, updateCanvasConfig, activateCanvas, archiveCanvas,
 * setPlacementOpen, plus read queries and the `canPlace` placement contract used
 * by the WS gateway. All business rules live in ./lib/canvasRules (pure, tested);
 * the handlers below are thin I/O wrappers that also enforce ownership and the
 * "one active canvas per owner" invariant.
 */
import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireUserId, optionalUserId } from "./lib/identity";
import {
  DEFAULT_DIMENSION,
  DEFAULT_PALETTE_COLORS,
  assertOwner,
  assertResizeAllowed,
  assertValidDimensions,
  assertValidEventWindow,
  assertValidSlug,
  assertValidTitle,
  canvasesToDemote,
  evaluatePlacement,
  slugify,
  type CanvasShape,
  type PlacementDecision,
  type PlacementDenyReason,
} from "./lib/canvasRules";
import { planGalleryFieldsPatch } from "./lib/gallery";

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers.
// ─────────────────────────────────────────────────────────────────────────────

/** Project a stored canvas doc onto the shape the pure rules operate over. */
function toShape(c: Doc<"canvases">): CanvasShape {
  return {
    ownerId: c.ownerId,
    width: c.width,
    height: c.height,
    status: c.status,
    placementOpen: c.placementOpen,
    eventStartAt: c.eventStartAt,
    eventEndAt: c.eventEndAt,
    cellCount: c.cellCount,
  };
}

/**
 * Archive every active canvas of `ownerId` except `exceptId`, enforcing the
 * one-active-per-owner invariant (CA2). Uses the pure `canvasesToDemote` planner
 * (unit-tested) and is defensive: if more than one active row ever exists, all
 * the stragglers are demoted, not just the first.
 */
async function demoteActive(
  ctx: MutationCtx,
  ownerId: string,
  now: number,
  exceptId?: Id<"canvases">,
): Promise<void> {
  const active = await ctx.db
    .query("canvases")
    .withIndex("by_owner_status", (q) => q.eq("ownerId", ownerId).eq("status", "active"))
    .collect();
  const toDemote = canvasesToDemote(
    active.map((c) => ({ id: c._id, status: c.status })),
    exceptId ?? null,
  );
  for (const id of toDemote) {
    await ctx.db.patch(id as Id<"canvases">, { status: "archived", archivedAt: now });
  }
}

/** Resolve a slug that is unique across all canvases (suffixing -2, -3, … as needed). */
async function uniqueSlug(ctx: QueryCtx, base: string): Promise<string> {
  let candidate = base;
  for (let n = 2; ; n++) {
    const taken = await ctx.db
      .query("canvases")
      .withIndex("by_slug", (q) => q.eq("slug", candidate))
      .first();
    if (!taken) return candidate;
    candidate = `${base}-${n}`.slice(0, 64);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutations.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new canvas. It becomes the owner's active canvas (CA1), archiving the
 * previously-active one to preserve the one-active-per-owner invariant.
 * Defaults: 100×100, system default palette, placement open, private.
 */
export const createCanvas = mutation({
  args: {
    title: v.optional(v.string()),
    slug: v.optional(v.string()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    paletteId: v.optional(v.id("palettes")),
    isPublic: v.optional(v.boolean()),
    eventStartAt: v.optional(v.union(v.number(), v.null())),
    eventEndAt: v.optional(v.union(v.number(), v.null())),
  },
  returns: v.id("canvases"),
  handler: async (ctx, args): Promise<Id<"canvases">> => {
    const ownerId = await requireUserId(ctx);
    const now = Date.now();

    const width = args.width ?? DEFAULT_DIMENSION;
    const height = args.height ?? DEFAULT_DIMENSION;
    assertValidDimensions(width, height);

    const identity = await ctx.auth.getUserIdentity();
    const login =
      (identity?.nickname as string | undefined) ??
      (identity?.preferredUsername as string | undefined) ??
      "canvas";
    const title = args.title ?? `${login}'s canvas`;
    assertValidTitle(title);

    const eventStartAt = args.eventStartAt ?? null;
    const eventEndAt = args.eventEndAt ?? null;
    assertValidEventWindow(eventStartAt, eventEndAt);

    // Resolve palette: caller's choice (must be system or owned) or the default.
    let paletteId: Id<"palettes">;
    if (args.paletteId) {
      const palette = await ctx.db.get(args.paletteId);
      if (!palette) throw new Error("palette not found");
      if (palette.ownerId !== null && palette.ownerId !== ownerId) {
        throw new Error("not_owner: cannot use another user's palette.");
      }
      paletteId = args.paletteId;
    } else {
      const def = await ctx.db
        .query("palettes")
        .withIndex("by_owner", (q) => q.eq("ownerId", null))
        .first();
      if (!def) {
        throw new Error(
          "default palette missing — run palettes:ensureDefaultPalette (seed) first.",
        );
      }
      paletteId = def._id;
    }

    // Slug: validate explicit input; otherwise derive from login and de-dupe.
    let slug: string;
    if (args.slug !== undefined) {
      assertValidSlug(args.slug);
      const taken = await ctx.db
        .query("canvases")
        .withIndex("by_slug", (q) => q.eq("slug", args.slug as string))
        .first();
      if (taken) throw new Error(`slug "${args.slug}" is already taken.`);
      slug = args.slug;
    } else {
      const base = slugify(login) || "canvas";
      slug = await uniqueSlug(ctx, base);
    }

    // New canvas is active → archive the previous active one (one-active invariant).
    await demoteActive(ctx, ownerId, now);

    return await ctx.db.insert("canvases", {
      ownerId,
      slug,
      title,
      width,
      height,
      paletteId,
      status: "active",
      placementOpen: true,
      isPublic: args.isPublic ?? false,
      eventStartAt,
      eventEndAt,
      createdAt: now,
      archivedAt: null,
      lastSnapshotAt: null,
      cellCount: 0,
      // Gallery (F12): seed activity to creation time so a brand-new public
      // canvas already sorts; the worker advances these off the hot path.
      lastActivityAt: now,
      viewerCount: 0,
    });
  },
});

/**
 * Synthetic owner for the anonymous-mode seed canvas. It is deliberately NOT a
 * valid Better Auth subject (no Twitch login resolves to it), so the row is
 * unambiguously the seed and `requireUserId`-gated mutations can never mutate it
 * from a real session. The gallery join tolerates a missing `profiles` row:
 * `toGalleryItem` falls back to the slug for login/displayName, so the seed
 * canvas still renders in discovery without a streamer profile.
 */
const ANON_SEED_OWNER_ID = "system:anonymous";

/**
 * The default canvas slug. Mirrors `DEFAULT_CANVAS_ID` ("default", ADR-0003 /
 * `GATEWAY_CANVAS_ID` fallback) — the slug the single-canvas anonymous
 * deployment drains under.
 */
const DEFAULT_CANVAS_SLUG = "default";

/**
 * Live hot-path geometry (WS protocol `CANVAS_WIDTH`/`CANVAS_HEIGHT` = 512).
 * NOTE: this exceeds the F2 public-create cap `MAX_DIMENSION` (500) that
 * `assertValidDimensions` enforces, so the seed intentionally bypasses that
 * check: `getCanvasDurable` feeds these dims back to the worker to rebuild the
 * Redis bitmap on restore, so they MUST match the deployed gateway/Redis
 * geometry, not the public-create limit. The 512-vs-500 divergence between the
 * WS protocol and `canvasRules` is an FE-owned contract reconciliation (flagged
 * on FEN-94); the seed mirrors what is actually deployed.
 */
const HOT_PATH_DIMENSION = 512;

/**
 * Idempotently seed the canvas row for the anonymous-mode deployment (FEN-94).
 *
 * Why this exists: under `GATEWAY_AUTH_DISABLED=1` there is no authenticated
 * Twitch user, so `createCanvas` (the sole public creator, `requireUserId`-gated)
 * never runs and no `canvases` row exists for the deployed slug. Per ADR-0001,
 * `worker:applyFlush` / `setGalleryFields` / `recordSnapshot` are all no-ops
 * until a row exists, so the worker drains every ~2s but persists nothing and
 * `getCanvasDurable("default")` returns null. This seed creates that row so the
 * drain/restore + gallery path can be exercised end-to-end (unblocks FEN-89).
 *
 * `internalMutation` (not public): canvas creation must never be reachable from
 * the public `/convex/*` route (FEN-86 posture). DevOps calls it once from
 * `apps/convex/deploy.sh` via the minted admin key (`convex run
 * canvases:ensureDefaultCanvas`) after `convex deploy`.
 *
 * Idempotent: a no-op returning the existing id if the slug already has a row,
 * so it is safe to run on every deploy.
 */
export const ensureDefaultCanvas = internalMutation({
  args: {
    slug: v.optional(v.string()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    isPublic: v.optional(v.boolean()),
  },
  returns: v.object({ canvasId: v.id("canvases"), created: v.boolean() }),
  handler: async (ctx, args): Promise<{ canvasId: Id<"canvases">; created: boolean }> => {
    const slug = args.slug ?? DEFAULT_CANVAS_SLUG;

    // Idempotency: never create a second row for the slug (one-active invariant
    // also holds — the synthetic owner has at most this one canvas).
    const existing = await ctx.db
      .query("canvases")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (existing) return { canvasId: existing._id, created: false };

    // Ensure the system default palette exists (same logic as
    // palettes:ensureDefaultPalette, inlined to keep this a single mutation).
    let paletteId: Id<"palettes">;
    const defPalette = await ctx.db
      .query("palettes")
      .withIndex("by_owner", (q) => q.eq("ownerId", null))
      .first();
    if (defPalette) {
      paletteId = defPalette._id;
    } else {
      paletteId = await ctx.db.insert("palettes", {
        ownerId: null,
        version: 1,
        colors: DEFAULT_PALETTE_COLORS.map((c) => ({ index: c.index, hex: c.hex })),
      });
    }

    const now = Date.now();
    const width = args.width ?? HOT_PATH_DIMENSION;
    const height = args.height ?? HOT_PATH_DIMENSION;
    const canvasId = await ctx.db.insert("canvases", {
      ownerId: ANON_SEED_OWNER_ID,
      slug,
      title: "LivePlace",
      width,
      height,
      paletteId,
      status: "active",
      placementOpen: true,
      // Public so the seed canvas is visible in the gallery for the drain test.
      isPublic: args.isPublic ?? true,
      eventStartAt: null,
      eventEndAt: null,
      createdAt: now,
      archivedAt: null,
      lastSnapshotAt: null,
      cellCount: 0,
      // Gallery (F12): seed activity to creation so it sorts immediately; the
      // worker advances lastActivityAt/viewerCount/thumbnail off the hot path —
      // which is exactly what FEN-89's drain/restore smoke verifies.
      lastActivityAt: now,
      viewerCount: 0,
    });
    return { canvasId, created: true };
  },
});

/**
 * Update a canvas's configuration. The canvas must be active (archived canvases
 * are read-only, CA3). Dimensions may only change while the canvas is empty
 * (CA5). All fields are optional; omitted fields are left unchanged.
 */
export const updateCanvasConfig = mutation({
  args: {
    canvasId: v.id("canvases"),
    title: v.optional(v.string()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    paletteId: v.optional(v.id("palettes")),
    isPublic: v.optional(v.boolean()),
    eventStartAt: v.optional(v.union(v.number(), v.null())),
    eventEndAt: v.optional(v.union(v.number(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const ownerId = await requireUserId(ctx);
    const canvas = await ctx.db.get(args.canvasId);
    if (!canvas) throw new Error("canvas not found");
    assertOwner(canvas, ownerId);
    if (canvas.status === "archived") {
      throw new Error(
        "canvas_archived: archived canvases are read-only; reactivate it first to edit config.",
      );
    }

    const patch: Partial<Doc<"canvases">> = {};

    if (args.title !== undefined) {
      assertValidTitle(args.title);
      patch.title = args.title;
    }

    // Dimensions: validate + enforce the CA5 empty-canvas guard.
    const width = args.width ?? canvas.width;
    const height = args.height ?? canvas.height;
    if (args.width !== undefined || args.height !== undefined) {
      assertResizeAllowed(toShape(canvas), width, height);
      patch.width = width;
      patch.height = height;
    }

    if (args.paletteId !== undefined) {
      const palette = await ctx.db.get(args.paletteId);
      if (!palette) throw new Error("palette not found");
      if (palette.ownerId !== null && palette.ownerId !== ownerId) {
        throw new Error("not_owner: cannot use another user's palette.");
      }
      patch.paletteId = args.paletteId;
    }

    if (args.isPublic !== undefined) patch.isPublic = args.isPublic;

    if (args.eventStartAt !== undefined || args.eventEndAt !== undefined) {
      const start = args.eventStartAt !== undefined ? args.eventStartAt : canvas.eventStartAt;
      const end = args.eventEndAt !== undefined ? args.eventEndAt : canvas.eventEndAt;
      assertValidEventWindow(start, end);
      patch.eventStartAt = start;
      patch.eventEndAt = end;
    }

    await ctx.db.patch(args.canvasId, patch);
    return null;
  },
});

/**
 * Activate a canvas. Archives the owner's currently-active canvas (CA2). Works on
 * an archived canvas too (reactivation), clearing its archivedAt.
 */
export const activateCanvas = mutation({
  args: { canvasId: v.id("canvases") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const ownerId = await requireUserId(ctx);
    const canvas = await ctx.db.get(args.canvasId);
    if (!canvas) throw new Error("canvas not found");
    assertOwner(canvas, ownerId);

    const now = Date.now();
    if (canvas.status === "active") return null; // already active, no-op

    await demoteActive(ctx, ownerId, now, args.canvasId);
    await ctx.db.patch(args.canvasId, { status: "active", archivedAt: null });
    return null;
  },
});

/** Archive a canvas (read-only). Non-destructive; reactivable via activateCanvas. */
export const archiveCanvas = mutation({
  args: { canvasId: v.id("canvases") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const ownerId = await requireUserId(ctx);
    const canvas = await ctx.db.get(args.canvasId);
    if (!canvas) throw new Error("canvas not found");
    assertOwner(canvas, ownerId);
    if (canvas.status === "archived") return null; // already archived, no-op
    await ctx.db.patch(args.canvasId, { status: "archived", archivedAt: Date.now() });
    return null;
  },
});

/** Open/close placement (emergency freeze, F8). Independent of active/archived. */
export const setPlacementOpen = mutation({
  args: { canvasId: v.id("canvases"), open: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const ownerId = await requireUserId(ctx);
    const canvas = await ctx.db.get(args.canvasId);
    if (!canvas) throw new Error("canvas not found");
    assertOwner(canvas, ownerId);
    await ctx.db.patch(args.canvasId, { placementOpen: args.open });
    return null;
  },
});

/**
 * Worker → gallery discovery fields (F12 / FEN-33, ADR-0001). The persistence
 * worker maintains the discovery fields ON the canvas row, OFF the hot path
 * (G-A1): `lastActivityAt` (newest drained placement), `viewerCount` (periodic
 * presence flush), and `thumbnailStorageId`/`thumbnailVersion` (a preview blob
 * pre-rendered from a snapshot — never on the fly, G-Perf3).
 *
 * The worker addresses the row by its WS `canvasId`, which ADR-0001 fixes equal
 * to the F2 `slug` (enforced by `GATEWAY_CANVAS_ID`); we resolve it via the
 * `by_slug` index. `internalMutation` (FEN-86): only the trusted worker reaches
 * it, via the secret-guarded `worker:run` action — NOT the public `/convex/*`
 * route. (Was public `mutation`; that let anyone spoof viewerCount/lastActivityAt
 * for gallery-ranking manipulation and point the thumbnail at an attacker blob.)
 *
 * Ownership boundary: if no row matches the slug yet, this is a **no-op**, never
 * a create — F2 `createCanvas` is the sole creator of canvas rows. The merge is
 * idempotent and monotonic (`planGalleryFieldsPatch`), so out-of-order or
 * redelivered flushes can't regress gallery state; a superseded thumbnail blob
 * is freed from storage.
 */
export const setGalleryFields = internalMutation({
  args: {
    slug: v.string(),
    lastActivityAt: v.optional(v.number()),
    viewerCount: v.optional(v.number()),
    thumbnailStorageId: v.optional(v.id("_storage")),
    thumbnailVersion: v.optional(v.number()),
  },
  returns: v.object({ updated: v.boolean() }),
  handler: async (ctx, args): Promise<{ updated: boolean }> => {
    const canvas = await ctx.db
      .query("canvases")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (!canvas) return { updated: false }; // resolution-miss → no-op (ADR-0001)

    const { freeStorageId, ...fields } = planGalleryFieldsPatch(canvas, {
      lastActivityAt: args.lastActivityAt,
      viewerCount: args.viewerCount,
      thumbnailStorageId: args.thumbnailStorageId,
      thumbnailVersion: args.thumbnailVersion,
    });
    if (Object.keys(fields).length === 0) return { updated: false };

    await ctx.db.patch(canvas._id, fields as Partial<Doc<"canvases">>);
    if (freeStorageId) {
      // Best-effort: the durable patch is what matters; a leaked blob is
      // harmless, a thrown delete would needlessly fail the flush write.
      await ctx.storage.delete(freeStorageId as Id<"_storage">).catch(() => undefined);
    }
    return { updated: true };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Queries.
// ─────────────────────────────────────────────────────────────────────────────

/** The caller's canvases, newest first. */
export const listMyCanvases = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    return await ctx.db
      .query("canvases")
      .withIndex("by_owner_status", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .collect();
  },
});

/** Fetch a canvas by slug (public view / OBS). */
export const getCanvasBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("canvases")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
  },
});

/**
 * The placement contract (CA3 + CA4). Returns whether the *current caller* may
 * place a pixel on the given canvas right now, and a machine reason if not.
 * The WS gateway calls this when minting a place ticket.
 */
export const canPlace = query({
  args: { canvasId: v.id("canvases") },
  returns: v.object({
    allowed: v.boolean(),
    reason: v.optional(
      v.union(
        v.literal("canvas_archived"),
        v.literal("placement_closed"),
        v.literal("outside_event_window"),
        v.literal("canvas_not_found"),
      ),
    ),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ allowed: boolean; reason?: PlacementDenyReason | "canvas_not_found" }> => {
    const canvas = await ctx.db.get(args.canvasId);
    if (!canvas) return { allowed: false, reason: "canvas_not_found" };
    const userId = await optionalUserId(ctx);
    const decision: PlacementDecision = evaluatePlacement(toShape(canvas), {
      isOwner: userId !== null && userId === canvas.ownerId,
      now: Date.now(),
    });
    return decision;
  },
});
