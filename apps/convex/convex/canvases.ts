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

// ─────────────────────────────────────────────────────────────────────────────
// Reserved slugs (FEN-433 / AC-4). Single source of truth — kept in sync with
// RESERVED_SEGMENTS in apps/web/src/routes.ts. Slugs that match any of these
// may not be claimed by users; attempts are rejected server-side (B6).
// ─────────────────────────────────────────────────────────────────────────────

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "api", "healthz", "health", "metrics", "status",
  "auth", "login", "logout", "signin", "signup", "oauth", "callback",
  "c", "u",
  "admin", "settings", "account", "me", "dashboard", "explore",
  "home", "about", "terms", "privacy", "legal", "help", "support",
  "og", "embed", "overlay", "obs",
  "gallery", "studio", "states", "leaderboard",
  "static", "assets", "public", "_next",
  "favicon.ico", "robots.txt", "sitemap.xml", "manifest.json",
  "404", "500", "well-known", ".well-known",
  // FEN-479 (AC-2): mirrors RESERVED_SEGMENTS — "default" is the internal
  // gateway fallback canvas id and must not be a user-claimable slug.
  "default",
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}
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
  matchesPersonalSlug,
  slugify,
  type CanvasShape,
  type PlacementDecision,
  type PlacementDenyReason,
} from "./lib/canvasRules";
import { planGalleryFieldsPatch } from "./lib/gallery";
import { authorOfTop } from "./lib/moderation";
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
      if (isReservedSlug(args.slug)) {
        throw new Error(`slug "${args.slug}" is reserved and cannot be used.`);
      }
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
 * FEN-433 (AC-1) — idempotently ensure the personal canvas for a given user.
 * Called from the `account.onCreate` trigger (B1) and internally by the public
 * `ensurePersonalCanvas` safety-net mutation (B2). Uses a direct db.insert to
 * bypass `assertValidSlug`, which rejects underscores — Twitch logins allow
 * `[a-z0-9_]` (B3). Resolves the palette from the system default.
 *
 * If the login is reserved or empty, inserts with a suffixed slug (`login-2`,
 * `login-3`, …) so the account is never left without a canvas (B3 edge).
 */
export const ensurePersonalCanvasInternal = internalMutation({
  args: { authUserId: v.string() },
  returns: v.union(
    v.object({ canvasId: v.id("canvases"), slug: v.string(), created: v.boolean() }),
    v.null(),
  ),
  handler: async (ctx, { authUserId }) => {
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_authUserId", (q) => q.eq("authUserId", authUserId))
      .unique();
    if (!profile || !profile.login) return null;

    const login = profile.login;
    // Use suffixed slug if login itself is reserved.
    const baseSlug = isReservedSlug(login) ? `${login}-canvas` : login;

    // Idempotent: if this user already owns a canvas whose slug matches baseSlug
    // (exact or uniqueSlug numeric suffix), return it without creating a new one.
    const owned = await ctx.db
      .query("canvases")
      .withIndex("by_owner_status", (q) => q.eq("ownerId", authUserId))
      .collect();
    const existing = owned.find((c) => matchesPersonalSlug(c.slug, baseSlug));
    if (existing) return { canvasId: existing._id, slug: existing.slug, created: false };

    const defPalette = await ctx.db
      .query("palettes")
      .withIndex("by_owner", (q) => q.eq("ownerId", null))
      .first();
    if (!defPalette) return null; // palette seed not yet run — caller can retry

    const slug = await uniqueSlug(ctx, baseSlug);
    const now = Date.now();
    await demoteActive(ctx, authUserId, now);
    const canvasId = await ctx.db.insert("canvases", {
      ownerId: authUserId,
      slug,
      title: `${profile.displayName || login}'s canvas`,
      width: DEFAULT_DIMENSION,
      height: DEFAULT_DIMENSION,
      paletteId: defPalette._id,
      status: "active",
      placementOpen: true,
      isPublic: false,
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
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_authUserId", (q) => q.eq("authUserId", ownerId))
      .unique();
    if (!profile || !profile.login) return null;

    const login = profile.login;
    const baseSlug = isReservedSlug(login) ? `${login}-canvas` : login;

    // Idempotent: if this user already owns a canvas whose slug matches baseSlug
    // (exact or uniqueSlug numeric suffix), return it without creating a new one.
    const owned = await ctx.db
      .query("canvases")
      .withIndex("by_owner_status", (q) => q.eq("ownerId", ownerId))
      .collect();
    const existing = owned.find((c) => matchesPersonalSlug(c.slug, baseSlug));
    if (existing) return { canvasId: existing._id, slug: existing.slug, created: false };

    const defPalette = await ctx.db
      .query("palettes")
      .withIndex("by_owner", (q) => q.eq("ownerId", null))
      .first();
    if (!defPalette) return null;

    const slug = await uniqueSlug(ctx, baseSlug);
    const now = Date.now();
    await demoteActive(ctx, ownerId, now);
    const canvasId = await ctx.db.insert("canvases", {
      ownerId,
      slug,
      title: `${profile.displayName || login}'s canvas`,
      width: DEFAULT_DIMENSION,
      height: DEFAULT_DIMENSION,
      paletteId: defPalette._id,
      status: "active",
      placementOpen: true,
      isPublic: false,
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
  returns: v.object({ author: v.union(v.string(), v.null()) }),
  handler: async (ctx, a): Promise<{ author: string | null }> => {
    const top = await ctx.db
      .query("placements")
      .withIndex("by_canvas_cell", (q) =>
        q.eq("canvasId", a.canvasId).eq("x", a.x).eq("y", a.y),
      )
      .order("desc")
      .first();
    const author = authorOfTop(top);
    if (!author) return { author: null };
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_authUserId", (q) => q.eq("authUserId", author.userId))
      .unique();
    return { author: profile?.login ?? null };
  },
});
