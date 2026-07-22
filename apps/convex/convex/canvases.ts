/**
 * Canvas lifecycle & configuration (F2 / FEN-12).
 *
 * Functions: createCanvas, updateCanvasConfig, activateCanvas, archiveCanvas,
 * setPlacementOpen, plus read queries and the `canPlace` placement contract used
 * by the WS gateway. All business rules live in ./lib/canvasRules (pure, tested);
 * the handlers below are thin I/O wrappers that also enforce ownership and the
 * "one active canvas per owner" invariant.
 */
import { internalAction, internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { ERRORS } from "./errors";
import { CANVAS_STATUS, canvasStatusValidator } from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { gatewayPost } from "./lib/gateway";

// RESERVED_SLUGS and isReservedSlug live in ./lib/canvasRules (pure); re-exported here for back-compat.
export { RESERVED_SLUGS, isReservedSlug } from "./lib/canvasRules";
import { requireUserId, optionalUserId } from "./lib/identity";
import { getProfileByAuthUserId } from "./lib/profiles";
import {
  DEFAULT_DIMENSION,
  assertOwner,
  assertResizeAllowed,
  assertValidDimensions,
  assertValidEventWindow,
  assertValidSlug,
  assertValidTitle,
  canvasesToDemote,
  countOutOfBounds,
  evaluatePlacement,
  isReservedSlug,
  latestCellsFromPlacements,
  matchesPersonalSlug,
  personalBaseSlug,
  slugify,
  type CanvasShape,
  type PlacementDecision,
  type PlacementDenyReason,
} from "./lib/canvasRules";
import { planGalleryFieldsPatch } from "./lib/gallery";
import { isUserBanned } from "./moderation";

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
    .withIndex("by_owner_status", (q) => q.eq("ownerId", ownerId).eq("status", CANVAS_STATUS.ACTIVE))
    .collect();
  const toDemote = canvasesToDemote(
    active.map((c) => ({ id: c._id, status: c.status })),
    exceptId ?? null,
  );
  for (const id of toDemote) {
    await ctx.db.patch(id as Id<"canvases">, { status: CANVAS_STATUS.ARCHIVED, archivedAt: now });
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
 * Defaults: 10×10, placement open, private.
 */
export const createCanvas = mutation({
  args: {
    title: v.optional(v.string()),
    slug: v.optional(v.string()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
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

    // Slug: validate explicit input; otherwise derive from login and de-dupe.
    let slug: string;
    if (args.slug !== undefined) {
      assertValidSlug(args.slug);
      if (isReservedSlug(args.slug)) {
        throw new ConvexError(ERRORS.SLUG_RESERVED);
      }
      const taken = await ctx.db
        .query("canvases")
        .withIndex("by_slug", (q) => q.eq("slug", args.slug as string))
        .first();
      if (taken) throw new ConvexError(ERRORS.SLUG_TAKEN);
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
      status: CANVAS_STATUS.ACTIVE,
      placementOpen: true,
      isPublic: args.isPublic ?? true,
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

type PersonalCanvasResult = { canvasId: Id<"canvases">; slug: string; created: boolean } | null;

/**
 * Shared core for `PREAUTH_ensurePersonalCanvas` and `ensurePersonalCanvas`.
 * Both look up the profile then delegate here; all personal-canvas creation
 * logic lives in one place (B3 edge cases, idempotence, demote-active).
 */
async function ensurePersonalCanvasCore(
  ctx: MutationCtx,
  ownerId: string,
  profile: { login: string; displayName?: string } | null,
): Promise<PersonalCanvasResult> {
  if (!profile || !profile.login) return null;

  const login = profile.login;
  const baseSlug = personalBaseSlug(login);

  // Idempotent: if this user already owns a canvas whose slug matches baseSlug
  // (exact or uniqueSlug numeric suffix), return it without creating a new one.
  const owned = await ctx.db
    .query("canvases")
    .withIndex("by_owner_status", (q) => q.eq("ownerId", ownerId))
    .collect();
  const existing = owned.find((c) => matchesPersonalSlug(c.slug, baseSlug));
  if (existing) return { canvasId: existing._id, slug: existing.slug, created: false };

  const slug = await uniqueSlug(ctx, baseSlug);
  const now = Date.now();
  await demoteActive(ctx, ownerId, now);
  const canvasId = await ctx.db.insert("canvases", {
    ownerId,
    slug,
    title: `${profile.displayName || login}'s canvas`,
    width: DEFAULT_DIMENSION,
    height: DEFAULT_DIMENSION,
    status: CANVAS_STATUS.ACTIVE,
    placementOpen: true,
    isPublic: true,
    eventStartAt: null,
    eventEndAt: null,
    createdAt: now,
    archivedAt: null,
    lastSnapshotAt: null,
    cellCount: 0,
    lastActivityAt: now,
    viewerCount: 0,
  });
  return { canvasId, slug, created: true };
}

/**
 * FEN-433 (AC-1) — idempotently ensure the personal canvas for a given user.
 * Called from the `account.onCreate` trigger (B1) and internally by the public
 * `ensurePersonalCanvas` safety-net mutation (B2). Uses a direct db.insert to
 * bypass `assertValidSlug`, which rejects underscores — Twitch logins allow
 * `[a-z0-9_]` (B3).
 *
 * If the login is reserved or empty, inserts with a suffixed slug (`login-2`,
 * `login-3`, …) so the account is never left without a canvas (B3 edge).
 */
export const PREAUTH_ensurePersonalCanvas = internalMutation({
  args: { authUserId: v.string() },
  returns: v.union(
    v.object({ canvasId: v.id("canvases"), slug: v.string(), created: v.boolean() }),
    v.null(),
  ),
  handler: async (ctx, { authUserId }) => {
    const profile = await getProfileByAuthUserId(ctx.db, authUserId);
    return ensurePersonalCanvasCore(ctx, authUserId, profile);
  },
});

/**
 * FEN-433 (AC-1 / B2) — public safety-net mutation: idempotently create the
 * caller's personal canvas. Called client-side after Convex confirms auth
 * (`isAuthenticated`) so that users who signed up before this feature, or
 * whose trigger failed, still get a canvas. Idempotent: a no-op if the slug
 * already exists for this owner. Returns `{ canvasId, slug, created }`.
 */
export const ensurePersonalCanvas = mutation({
  args: {},
  returns: v.union(
    v.object({ canvasId: v.id("canvases"), slug: v.string(), created: v.boolean() }),
    v.null(),
  ),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const profile = await getProfileByAuthUserId(ctx.db, ownerId);
    return ensurePersonalCanvasCore(ctx, ownerId, profile);
  },
});

/** Shape returned when the caller must confirm before a shrink destroys pixels. */
type ResizeConfirmation = {
  requiresConfirmation: true;
  outOfBoundsCount: number;
  width: number;
  height: number;
};

/**
 * Update a canvas's configuration. The canvas must be active (archived canvases
 * are read-only, CA3). All fields are optional; omitted fields are left unchanged.
 *
 * Resize behaviour (FEN-1798 / C-A):
 *  - Any dimension in the whitelist is accepted.
 *  - If shrinking would discard K>0 painted pixels outside the new frame AND
 *    `confirmDeleteOutOfBounds` is not true, returns
 *    `{requiresConfirmation:true, outOfBoundsCount:K, width, height}` with NO
 *    writes — the caller must re-invoke with `confirmDeleteOutOfBounds:true`.
 *  - Otherwise (K=0, enlargement, or confirmed): patches dims, deletes all
 *    placement rows (all versions) at x>=W' or y>=H', recalculates `cellCount`
 *    bounded to the new dims, then schedules a gateway `/internal/grid/resize` POST.
 */
export const updateCanvasConfig = mutation({
  args: {
    canvasId: v.id("canvases"),
    title: v.optional(v.string()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    isPublic: v.optional(v.boolean()),
    eventStartAt: v.optional(v.union(v.number(), v.null())),
    eventEndAt: v.optional(v.union(v.number(), v.null())),
    confirmDeleteOutOfBounds: v.optional(v.boolean()),
  },
  returns: v.union(
    v.null(),
    v.object({
      requiresConfirmation: v.literal(true),
      outOfBoundsCount: v.number(),
      width: v.number(),
      height: v.number(),
    }),
  ),
  handler: async (ctx, args): Promise<null | ResizeConfirmation> => {
    const ownerId = await requireUserId(ctx);
    const canvas = await ctx.db.get(args.canvasId);
    if (!canvas) throw new ConvexError(ERRORS.CANVAS_NOT_FOUND);
    assertOwner(canvas, ownerId);
    if (canvas.status === CANVAS_STATUS.ARCHIVED) {
      throw new ConvexError(ERRORS.CANVAS_ARCHIVED);
    }

    const patch: Partial<Doc<"canvases">> = {};

    if (args.title !== undefined) {
      assertValidTitle(args.title);
      patch.title = args.title;
    }

    const width = args.width ?? canvas.width;
    const height = args.height ?? canvas.height;
    if (args.width !== undefined || args.height !== undefined) {
      // Validates the whitelist; no longer throws on shrink of non-empty (FEN-1798).
      assertResizeAllowed(toShape(canvas), width, height);

      // Single scan: build latest-per-cell AND keep raw rows for deletion.
      const allPlacements = await ctx.db
        .query("placements")
        .withIndex("by_canvas_version", (q) => q.eq("canvasId", args.canvasId))
        .collect();
      const latestCells = latestCellsFromPlacements(allPlacements);

      const isShrink = width < canvas.width || height < canvas.height;
      const K = countOutOfBounds(latestCells, width, height);

      if (isShrink && K > 0 && !args.confirmDeleteOutOfBounds) {
        // No writes. The caller re-invokes with confirmDeleteOutOfBounds:true.
        return { requiresConfirmation: true, outOfBoundsCount: K, width, height };
      }

      // Apply: purge all placement rows (all versions) outside new bounds.
      for (const p of allPlacements) {
        if (p.x >= width || p.y >= height) {
          await ctx.db.delete(p._id);
        }
      }

      // Recompute cellCount bounded to the new dims (subsumes FEN-1787 reconcile).
      patch.cellCount = latestCells.filter(
        (c) => c.color > 0 && c.x < width && c.y < height,
      ).length;
      patch.width = width;
      patch.height = height;

      // Notify the gateway: re-layout Redis buffer + broadcast dimsChanged + fresh snapshot.
      await ctx.scheduler.runAfter(0, internal.canvases.UNAUTH_notifyGatewayResize, {
        canvasId: args.canvasId,
        width,
        height,
      });
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
    if (!canvas) throw new ConvexError(ERRORS.CANVAS_NOT_FOUND);
    assertOwner(canvas, ownerId);

    const now = Date.now();
    if (canvas.status === CANVAS_STATUS.ACTIVE) return null; // already active, no-op

    await demoteActive(ctx, ownerId, now, args.canvasId);
    await ctx.db.patch(args.canvasId, { status: CANVAS_STATUS.ACTIVE, archivedAt: null });
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
    if (!canvas) throw new ConvexError(ERRORS.CANVAS_NOT_FOUND);
    assertOwner(canvas, ownerId);
    if (canvas.status === CANVAS_STATUS.ARCHIVED) return null; // already archived, no-op
    await ctx.db.patch(args.canvasId, { status: CANVAS_STATUS.ARCHIVED, archivedAt: Date.now() });
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
    if (!canvas) throw new ConvexError(ERRORS.CANVAS_NOT_FOUND);
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
export const UNAUTH_setGalleryFields = internalMutation({
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

/** Shared validator for a canvas doc as exposed to queries (ownerId omitted from public view). */
const canvasPubValidator = v.object({
  _id: v.id("canvases"),
  _creationTime: v.number(),
  slug: v.string(),
  title: v.string(),
  width: v.number(),
  height: v.number(),
  status: canvasStatusValidator,
  placementOpen: v.boolean(),
  isPublic: v.boolean(),
  eventStartAt: v.union(v.number(), v.null()),
  eventEndAt: v.union(v.number(), v.null()),
  createdAt: v.number(),
  archivedAt: v.union(v.number(), v.null()),
  lastSnapshotAt: v.union(v.number(), v.null()),
  cellCount: v.number(),
  lastActivityAt: v.optional(v.number()),
  viewerCount: v.optional(v.number()),
  thumbnailStorageId: v.optional(v.id("_storage")),
  thumbnailVersion: v.optional(v.number()),
});

/** Strip ownerId before returning a canvas doc to callers (public projection). */
function stripOwnerId(canvas: Doc<"canvases">) {
  const { ownerId: _o, ...pub } = canvas;
  return pub;
}

/** The caller's canvases, newest first. ownerId is stripped (same projection as public queries). */
export const listMyCanvases = query({
  args: {},
  returns: v.array(canvasPubValidator),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const rows = await ctx.db
      .query("canvases")
      .withIndex("by_owner_status", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .collect();
    return rows.map(stripOwnerId);
  },
});

/**
 * Fetch a canvas by slug (public view / OBS).
 *
 * FEN-1785 — personal-slug redirect: when the requested slug is the owner's
 * canonical personal slug (exactly `login`, not `login-2` etc.) and the
 * matching canvas is archived, transparently return the owner's active canvas
 * instead. This makes `/<login>` always follow the active canvas while
 * per-canvas slugs (`/<login-2>`) are unaffected.
 */
export const getCanvasBySlug = query({
  args: { slug: v.string() },
  returns: v.union(v.null(), canvasPubValidator),
  handler: async (ctx, args) => {
    const canvas = await ctx.db
      .query("canvases")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (!canvas) return null;
    // Fast path: if the found canvas is already active, return it directly.
    if (canvas.status === CANVAS_STATUS.ACTIVE) return stripOwnerId(canvas);
    // Slow path: check whether this slug is the owner's canonical personal slug.
    const profile = await getProfileByAuthUserId(ctx.db, canvas.ownerId);
    if (profile?.login) {
      const baseSlug = personalBaseSlug(profile.login);
      if (args.slug === baseSlug) {
        const active = await ctx.db
          .query("canvases")
          .withIndex("by_owner_status", (q) =>
            q.eq("ownerId", canvas.ownerId).eq("status", CANVAS_STATUS.ACTIVE),
          )
          .first();
        if (active) return stripOwnerId(active);
      }
    }
    return stripOwnerId(canvas);
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
        v.literal("banned"),
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
    const isOwner = userId !== null && userId === canvas.ownerId;
    // F8 ban gate (FEN-132): a banned user is refused before the click. Owners
    // can't be banned from their own canvas, so skip the lookup for them.
    const isBanned = userId !== null && !isOwner && (await isUserBanned(ctx, canvas._id, userId));
    const decision: PlacementDecision = evaluatePlacement(toShape(canvas), {
      isOwner,
      isBanned,
      now: Date.now(),
    });
    return decision;
  },
});

/**
 * FEN-296 — viewer-facing author of the pixel currently shown at a cell, for the
 * read-only pixel-info panel (FEN-249, sub-task of FEN-248). Returns ONLY the
 * public Twitch login (the pseudo `/u/{login}` already exposes — FEN-22), never
 * the internal user id or any other profile field (security audit FEN-84). This
 * is the public-safe sibling of `moderation:authorAt`, which returns `{ userId }`
 * and is mod-gated for the crisis ban surface (FEN-159); `pixelAuthor` takes no
 * auth so any viewer (incl. anonymous) can resolve it.
 *
 * Reads only the top-of-stack placement via `placements.by_canvas_cell` (highest
 * `version`, single indexed row — no whole-canvas scan), then `authorOfTop`
 * yields `null` for an empty / currently-erased (color 0) / anonymous top. A
 * known author whose `profiles` row is somehow missing also returns `null`
 * rather than leaking the id. NOTE: the result reflects the durable `placements`
 * log, so a not-yet-flushed live placement can briefly read as its previous
 * author/`null`; this is read-only and never touches the pose hot-path.
 */
export const pixelAuthor = query({
  args: { canvasId: v.id("canvases"), x: v.number(), y: v.number() },
  returns: v.object({
    author: v.union(v.string(), v.null()),
    avatarUrl: v.union(v.string(), v.null()),
    ts: v.union(v.number(), v.null()),
  }),
  handler: async (
    ctx,
    a,
  ): Promise<{ author: string | null; avatarUrl: string | null; ts: number | null }> => {
    const top = await ctx.db
      .query("placements")
      .withIndex("by_canvas_cell", (q) =>
        q.eq("canvasId", a.canvasId).eq("x", a.x).eq("y", a.y),
      )
      .order("desc")
      .first();
    // Empty cell or erased top → no occupancy data.
    if (!top || top.color === 0) return { author: null, avatarUrl: null, ts: null };
    const { ts } = top;
    const userId = top.userId;
    // Anonymous placement: cell IS painted but placer had no account.
    if (!userId) return { author: null, avatarUrl: null, ts };
    const profile = await getProfileByAuthUserId(ctx.db, userId);
    // Prefer the exact Twitch login slug; fall back to displayName for profiles
    // where login is still "" (Helix backfill pending or failed, FEN-979). Both may
    // be "" on a freshly-created profile before triggers complete — return null in
    // that case so the panel honestly shows "author unavailable" rather than a blank
    // (FEN-839). avatarUrl/ts preserved from canonical read path.
    return {
      author: profile?.login || profile?.displayName || null,
      avatarUrl: profile?.avatarUrl ?? null,
      ts,
    };
  },
});

/**
 * FEN-1762 — gateway per-canvas geometry. The gateway resolves durable dims at
 * subscribe time via this lightweight query (identified by Convex _id, which is
 * the `canvasId` on the WS connection). Returns null when the row doesn't exist
 * yet (cold start / race); caller falls back to env dims.
 */
export const getCanvasDimsById = query({
  args: { canvasId: v.id("canvases") },
  returns: v.union(v.object({ width: v.number(), height: v.number() }), v.null()),
  handler: async (ctx, { canvasId }): Promise<{ width: number; height: number } | null> => {
    const canvas = await ctx.db.get(canvasId);
    if (!canvas) return null;
    return { width: canvas.width, height: canvas.height };
  },
});

/**
 * FEN-1798/C-B — trigger a full resize on the gateway after `updateCanvasConfig`
 * commits new dims. The gateway re-layouts the Redis buffer (row-major crop/pad),
 * purges the coalescer, updates the dims cache, broadcasts `dimsChanged`, and
 * pushes a fresh binary snapshot to every connected client. Degrades gracefully
 * when GATEWAY_INTERNAL_URL is unset (local / anon smoke).
 */
export const UNAUTH_notifyGatewayResize = internalAction({
  args: { canvasId: v.id("canvases"), width: v.number(), height: v.number() },
  returns: v.null(),
  handler: async (_ctx, { canvasId, width, height }): Promise<null> => {
    await gatewayPost("/internal/grid/resize", { canvasId, width, height }).catch((err: unknown) => {
      console.warn(`[canvases] notifyGatewayResize failed (non-fatal): ${(err as Error).message}`);
    });
    return null;
  },
});
