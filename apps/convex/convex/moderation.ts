/**
 * F8 moderation Convex layer (FEN-52) — the "brain" that authorises a mod
 * action, decides *which cells and colours* to write, journals it (CA6), then
 * triggers the already-shipped hot-path engine (`moderate.lua`, FEN-19) to apply
 * the bulk overwrite atomically.
 *
 * Split of responsibilities:
 *  - Pure decision logic (the stack fold that reconstructs "what was underneath")
 *    lives in ./lib/moderation.ts and is unit-tested with no runtime.
 *  - DB authz + reads/writes (ban list, moderator roster, deleted-pixel overlay,
 *    audit) run in transactional mutations here.
 *  - The Redis side-effects (apply the bulkDelta, SET/DEL `canvas:frozen`, force a
 *    flush before a mass action) are NOT done from Convex — Convex never touches
 *    Redis (G-A1). They are dispatched over HTTP to the gateway's `/internal/*`
 *    endpoints (FEN-19, out of scope here). Until those endpoints exist /
 *    `GATEWAY_INTERNAL_URL` is configured, the action records durable state and
 *    reports the dispatch as `skipped` so this layer is deployable and testable
 *    today and live-wires when the gateway ships.
 *
 * Authorisation: the canvas owner is always a moderator; delegated mods come from
 * `canvasModerators` (Twitch channel-mod sync, F8.5). Every public entrypoint is
 * an `action` (it performs the gateway fetch); the authz + DB work is delegated
 * to internal mutations/queries it orchestrates.
 *
 * Convex deployment env consumed here: GATEWAY_INTERNAL_URL (base URL of the WS
 * gateway's internal API), GATEWAY_INTERNAL_SECRET (shared bearer for it),
 * TWITCH_CLIENT_ID (Helix Client-Id header for the mod sync).
 */
import { v } from "convex/values";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id, Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireUserId } from "./lib/identity";
import { computeDeleteCells, computeRestoreCells, computeWipeCells, groupByCell } from "./lib/moderation";
import type { ModerationCell, PlacementRow } from "./lib/moderation";

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers (run inside query/mutation ctx).
// ─────────────────────────────────────────────────────────────────────────────

/** Owner OR active delegated moderator may act; otherwise throw. Returns the canvas. */
async function assertCanModerate(
  ctx: QueryCtx,
  canvasId: Id<"canvases">,
  userId: string,
): Promise<Doc<"canvases">> {
  const canvas = await ctx.db.get(canvasId);
  if (!canvas) throw new Error("canvas_not_found: unknown canvas.");
  if (canvas.ownerId === userId) return canvas;
  const mod = await ctx.db
    .query("canvasModerators")
    .withIndex("by_canvas_user", (q) => q.eq("canvasId", canvasId).eq("userId", userId))
    .unique();
  if (mod && mod.active) return canvas;
  throw new Error("forbidden: only the canvas owner or a moderator may moderate.");
}

/** Palette size (colour count) for a canvas — the `paletteSize` the hot-path needs. */
async function paletteSizeOf(ctx: QueryCtx, canvas: Doc<"canvases">): Promise<number> {
  const palette = await ctx.db.get(canvas.paletteId);
  return palette ? palette.colors.length : 0;
}

/** Whole durable placement log for a canvas (off hot-path; mass actions only). */
async function loadPlacements(ctx: QueryCtx, canvasId: Id<"canvases">): Promise<PlacementRow[]> {
  const rows = await ctx.db
    .query("placements")
    .withIndex("by_canvas_version", (q) => q.eq("canvasId", canvasId))
    .collect();
  return rows.map((r) => ({ x: r.x, y: r.y, color: r.color, version: r.version, userId: r.userId }));
}

/** Current global write sequence (max version seen in the durable log). */
function maxVersion(placements: ReadonlyArray<PlacementRow>): number {
  let m = 0;
  for (const p of placements) if (p.version > m) m = p.version;
  return m;
}

/**
 * Upsert the deleted-pixel overlay for a moderated cell (CA2): keep it recorded
 * with author + reason even though it is invisible on the canvas.
 */
async function upsertOverlay(
  ctx: MutationCtx,
  row: {
    canvasId: Id<"canvases">;
    x: number;
    y: number;
    deleted: boolean;
    removedColor: number;
    removedUserId?: string;
    revealedColor: number;
    reason?: string;
    actorUserId: string;
    atVersion: number;
    now: number;
  },
): Promise<void> {
  const existing = await ctx.db
    .query("pixelModeration")
    .withIndex("by_canvas_cell", (q) => q.eq("canvasId", row.canvasId).eq("x", row.x).eq("y", row.y))
    .unique();
  const fields = {
    deleted: row.deleted,
    removedColor: row.removedColor,
    removedUserId: row.removedUserId,
    revealedColor: row.revealedColor,
    reason: row.reason,
    actorUserId: row.actorUserId,
    atVersion: row.atVersion,
    updatedAt: row.now,
  };
  if (existing) await ctx.db.patch(existing._id, fields);
  else await ctx.db.insert("pixelModeration", { canvasId: row.canvasId, x: row.x, y: row.y, ...fields });
}

/** Append an audit row (CA6); returns its id so the action can stamp the dispatch result. */
async function writeAudit(
  ctx: MutationCtx,
  row: {
    canvasId: Id<"canvases">;
    action: Doc<"auditLog">["action"];
    actorUserId: string;
    targetUserId?: string;
    cellsAffected: number;
    reason?: string;
    detail?: string;
    now: number;
  },
): Promise<Id<"auditLog">> {
  return ctx.db.insert("auditLog", {
    canvasId: row.canvasId,
    action: row.action,
    actorUserId: row.actorUserId,
    targetUserId: row.targetUserId,
    cellsAffected: row.cellsAffected,
    reason: row.reason,
    detail: row.detail,
    createdAt: row.now,
  });
}

// A prepared moderation batch the action dispatches to the gateway.
const preparedValidator = v.object({
  slug: v.string(),
  width: v.number(),
  height: v.number(),
  paletteSize: v.number(),
  cells: v.array(v.object({ x: v.number(), y: v.number(), color: v.number() })),
  auditId: v.id("auditLog"),
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal mutations: authorise, decide cells, record durable state.
// ─────────────────────────────────────────────────────────────────────────────

/** F8.1 — record the ban + overlay for the author's wiped pixels, return the batch. */
export const prepareBanWipe = internalMutation({
  args: {
    canvasId: v.id("canvases"),
    targetUserId: v.string(),
    actorUserId: v.string(),
    reason: v.optional(v.string()),
    now: v.number(),
  },
  returns: preparedValidator,
  handler: async (ctx, a) => {
    const canvas = await assertCanModerate(ctx, a.canvasId, a.actorUserId);
    const placements = await loadPlacements(ctx, a.canvasId);
    const cells = computeWipeCells(placements, a.targetUserId);
    const groups = groupByCell(placements);
    const version = maxVersion(placements);

    // Upsert / lift-aware ban row.
    const ban = await ctx.db
      .query("bans")
      .withIndex("by_canvas_user", (q) => q.eq("canvasId", a.canvasId).eq("userId", a.targetUserId))
      .unique();
    if (ban) {
      await ctx.db.patch(ban._id, { active: true, wiped: true, bannedBy: a.actorUserId, reason: a.reason });
    } else {
      await ctx.db.insert("bans", {
        canvasId: a.canvasId,
        userId: a.targetUserId,
        bannedBy: a.actorUserId,
        reason: a.reason,
        active: true,
        wiped: true,
        createdAt: a.now,
      });
    }

    // CA2 overlay for every wiped cell.
    for (const c of cells) {
      const stack = groups.get(`${c.x},${c.y}`);
      const top = stack ? stack[stack.length - 1] : undefined;
      await upsertOverlay(ctx, {
        canvasId: a.canvasId,
        x: c.x,
        y: c.y,
        deleted: true,
        removedColor: top?.color ?? 0,
        removedUserId: a.targetUserId,
        revealedColor: c.color,
        reason: a.reason,
        actorUserId: a.actorUserId,
        atVersion: version,
        now: a.now,
      });
    }

    const auditId = await writeAudit(ctx, {
      canvasId: a.canvasId,
      action: "wipe",
      actorUserId: a.actorUserId,
      targetUserId: a.targetUserId,
      cellsAffected: cells.length,
      reason: a.reason,
      detail: "dispatch_pending",
      now: a.now,
    });

    return {
      slug: canvas.slug,
      width: canvas.width,
      height: canvas.height,
      paletteSize: await paletteSizeOf(ctx, canvas),
      cells,
      auditId,
    };
  },
});

/** F8.2 — record the overlay for unit/group deletes, return the batch. */
export const prepareDelete = internalMutation({
  args: {
    canvasId: v.id("canvases"),
    actorUserId: v.string(),
    targets: v.array(v.object({ x: v.number(), y: v.number() })),
    reason: v.optional(v.string()),
    now: v.number(),
  },
  returns: preparedValidator,
  handler: async (ctx, a) => {
    const canvas = await assertCanModerate(ctx, a.canvasId, a.actorUserId);
    const placements = await loadPlacements(ctx, a.canvasId);
    const cells = computeDeleteCells(placements, a.targets);
    const groups = groupByCell(placements);
    const version = maxVersion(placements);

    for (const c of cells) {
      const stack = groups.get(`${c.x},${c.y}`);
      const top = stack ? stack[stack.length - 1] : undefined;
      await upsertOverlay(ctx, {
        canvasId: a.canvasId,
        x: c.x,
        y: c.y,
        deleted: true,
        removedColor: top?.color ?? 0,
        removedUserId: top?.userId,
        revealedColor: c.color,
        reason: a.reason,
        actorUserId: a.actorUserId,
        atVersion: version,
        now: a.now,
      });
    }

    const auditId = await writeAudit(ctx, {
      canvasId: a.canvasId,
      action: "delete",
      actorUserId: a.actorUserId,
      cellsAffected: cells.length,
      reason: a.reason,
      detail: "dispatch_pending",
      now: a.now,
    });

    return {
      slug: canvas.slug,
      width: canvas.width,
      height: canvas.height,
      paletteSize: await paletteSizeOf(ctx, canvas),
      cells,
      auditId,
    };
  },
});

/** F8.3 — rebuild targeted cells from the durable log; clear their overlay. */
export const prepareRestore = internalMutation({
  args: {
    canvasId: v.id("canvases"),
    actorUserId: v.string(),
    targets: v.array(v.object({ x: v.number(), y: v.number() })),
    reason: v.optional(v.string()),
    now: v.number(),
  },
  returns: preparedValidator,
  handler: async (ctx, a) => {
    const canvas = await assertCanModerate(ctx, a.canvasId, a.actorUserId);
    const placements = await loadPlacements(ctx, a.canvasId);
    const cells = computeRestoreCells(placements, a.targets);
    const version = maxVersion(placements);

    for (const c of cells) {
      const existing = await ctx.db
        .query("pixelModeration")
        .withIndex("by_canvas_cell", (q) => q.eq("canvasId", a.canvasId).eq("x", c.x).eq("y", c.y))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, {
          deleted: false,
          revealedColor: c.color,
          reason: a.reason,
          actorUserId: a.actorUserId,
          atVersion: version,
          updatedAt: a.now,
        });
      }
    }

    const auditId = await writeAudit(ctx, {
      canvasId: a.canvasId,
      action: "restore",
      actorUserId: a.actorUserId,
      cellsAffected: cells.length,
      reason: a.reason,
      detail: "dispatch_pending",
      now: a.now,
    });

    return {
      slug: canvas.slug,
      width: canvas.width,
      height: canvas.height,
      paletteSize: await paletteSizeOf(ctx, canvas),
      cells,
      auditId,
    };
  },
});

/** F8.4 — owner/mod freeze toggle: patch the durable mirror + audit, return slug. */
export const prepareFreeze = internalMutation({
  args: {
    canvasId: v.id("canvases"),
    actorUserId: v.string(),
    frozen: v.boolean(),
    now: v.number(),
  },
  returns: v.object({ slug: v.string(), auditId: v.id("auditLog") }),
  handler: async (ctx, a) => {
    const canvas = await assertCanModerate(ctx, a.canvasId, a.actorUserId);
    // `placementOpen === false` is the durable mirror of the Redis freeze flag.
    await ctx.db.patch(a.canvasId, { placementOpen: !a.frozen });
    const auditId = await writeAudit(ctx, {
      canvasId: a.canvasId,
      action: a.frozen ? "freeze" : "unfreeze",
      actorUserId: a.actorUserId,
      cellsAffected: 0,
      now: a.now,
    });
    return { slug: canvas.slug, auditId };
  },
});

/** Stamp the dispatch outcome onto an audit row after the gateway call resolves. */
export const finalizeAudit = internalMutation({
  args: { auditId: v.id("auditLog"), detail: v.string() },
  returns: v.null(),
  handler: async (ctx, a) => {
    await ctx.db.patch(a.auditId, { detail: a.detail });
    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Gateway dispatch (HTTP; runs only inside actions).
// ─────────────────────────────────────────────────────────────────────────────

interface DispatchResult {
  dispatched: boolean;
  detail: string;
}

/** POST a JSON body to a gateway `/internal/*` route; degrade gracefully if unset. */
async function gatewayPost(path: string, body: unknown): Promise<DispatchResult> {
  const base = process.env.GATEWAY_INTERNAL_URL;
  if (!base) return { dispatched: false, detail: "gateway_not_configured" };
  const secret = process.env.GATEWAY_INTERNAL_SECRET;
  const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`gateway_dispatch_failed ${path}: ${res.status} ${text}`.trim());
  }
  return { dispatched: true, detail: `gateway ${res.status} ${path}` };
}

/**
 * Force a Redis→Convex flush before a mass action (issue scope §7) so the
 * durable log reflects pre-action state. Best-effort: if the gateway isn't
 * configured we proceed on the already-flushed log. The gateway owns the actual
 * buffer drain (FEN-17/FEN-19).
 */
async function forceFlush(slug: string): Promise<DispatchResult> {
  return gatewayPost("/internal/flush", { slug });
}

/** Apply a computed cell batch via the hot-path engine (the gateway builds moderateArgs). */
async function dispatchModerate(batch: {
  slug: string;
  width: number;
  height: number;
  paletteSize: number;
  cells: ModerationCell[];
}): Promise<DispatchResult> {
  if (batch.cells.length === 0) return { dispatched: false, detail: "no_cells" };
  return gatewayPost("/internal/moderate", batch);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public actions: orchestrate authz/record → flush → dispatch → finalise.
// ─────────────────────────────────────────────────────────────────────────────

const actionResult = v.object({
  cellsAffected: v.number(),
  dispatched: v.boolean(),
  detail: v.string(),
});

/** F8.1 — ban an author and wipe their pixels (reveal what was underneath). */
export const banAndWipe = action({
  args: {
    canvasId: v.id("canvases"),
    targetUserId: v.string(),
    reason: v.optional(v.string()),
  },
  returns: actionResult,
  handler: async (ctx, a): Promise<{ cellsAffected: number; dispatched: boolean; detail: string }> => {
    const actorUserId = await requireUserId(ctx);
    const batch = await ctx.runMutation(internal.moderation.prepareBanWipe, {
      canvasId: a.canvasId,
      targetUserId: a.targetUserId,
      actorUserId,
      reason: a.reason,
      now: Date.now(),
    });
    await forceFlush(batch.slug).catch(() => undefined);
    const result = await dispatchModerate(batch);
    await ctx.runMutation(internal.moderation.finalizeAudit, { auditId: batch.auditId, detail: result.detail });
    return { cellsAffected: batch.cells.length, dispatched: result.dispatched, detail: result.detail };
  },
});

/** F8.2 — delete a single cell or a group. */
export const deletePixels = action({
  args: {
    canvasId: v.id("canvases"),
    targets: v.array(v.object({ x: v.number(), y: v.number() })),
    reason: v.optional(v.string()),
  },
  returns: actionResult,
  handler: async (ctx, a): Promise<{ cellsAffected: number; dispatched: boolean; detail: string }> => {
    const actorUserId = await requireUserId(ctx);
    const batch = await ctx.runMutation(internal.moderation.prepareDelete, {
      canvasId: a.canvasId,
      actorUserId,
      targets: a.targets,
      reason: a.reason,
      now: Date.now(),
    });
    await forceFlush(batch.slug).catch(() => undefined);
    const result = await dispatchModerate(batch);
    await ctx.runMutation(internal.moderation.finalizeAudit, { auditId: batch.auditId, detail: result.detail });
    return { cellsAffected: batch.cells.length, dispatched: result.dispatched, detail: result.detail };
  },
});

/** F8.3 — restore targeted cells from the durable log. */
export const restorePixels = action({
  args: {
    canvasId: v.id("canvases"),
    targets: v.array(v.object({ x: v.number(), y: v.number() })),
    reason: v.optional(v.string()),
  },
  returns: actionResult,
  handler: async (ctx, a): Promise<{ cellsAffected: number; dispatched: boolean; detail: string }> => {
    const actorUserId = await requireUserId(ctx);
    const batch = await ctx.runMutation(internal.moderation.prepareRestore, {
      canvasId: a.canvasId,
      actorUserId,
      targets: a.targets,
      reason: a.reason,
      now: Date.now(),
    });
    await forceFlush(batch.slug).catch(() => undefined);
    const result = await dispatchModerate(batch);
    await ctx.runMutation(internal.moderation.finalizeAudit, { auditId: batch.auditId, detail: result.detail });
    return { cellsAffected: batch.cells.length, dispatched: result.dispatched, detail: result.detail };
  },
});

/** F8.4 — emergency freeze / unfreeze: SET/DEL `canvas:frozen` via the gateway. */
export const setFrozen = action({
  args: { canvasId: v.id("canvases"), frozen: v.boolean() },
  returns: v.object({ frozen: v.boolean(), dispatched: v.boolean(), detail: v.string() }),
  handler: async (ctx, a): Promise<{ frozen: boolean; dispatched: boolean; detail: string }> => {
    const actorUserId = await requireUserId(ctx);
    const { slug, auditId } = await ctx.runMutation(internal.moderation.prepareFreeze, {
      canvasId: a.canvasId,
      actorUserId,
      frozen: a.frozen,
      now: Date.now(),
    });
    const result = await gatewayPost("/internal/freeze", { slug, frozen: a.frozen });
    await ctx.runMutation(internal.moderation.finalizeAudit, { auditId, detail: result.detail });
    return { frozen: a.frozen, dispatched: result.dispatched, detail: result.detail };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// F8.5 — Twitch channel-moderator sync (CA5): populate `canvasModerators`.
// ─────────────────────────────────────────────────────────────────────────────

interface TwitchModerator {
  user_id: string;
  user_login?: string;
  user_name?: string;
}

/** Resolve the canvas owner + their Twitch broadcaster id (authz happens here). */
export const prepareTwitchSync = internalQuery({
  args: { canvasId: v.id("canvases"), actorUserId: v.string() },
  returns: v.object({ broadcasterId: v.string() }),
  handler: async (ctx, a) => {
    const canvas = await assertCanModerate(ctx, a.canvasId, a.actorUserId);
    // The broadcaster is the canvas owner; sync reads THEIR channel mods.
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_authUserId", (q) => q.eq("authUserId", canvas.ownerId))
      .unique();
    if (!profile || !profile.twitchId) {
      throw new Error("owner_twitch_unknown: canvas owner has no Twitch id on file.");
    }
    return { broadcasterId: profile.twitchId };
  },
});

/** Upsert the synced moderator roster, deactivating mods no longer present (CA5). */
export const applyTwitchSync = internalMutation({
  args: {
    canvasId: v.id("canvases"),
    actorUserId: v.string(),
    mods: v.array(
      v.object({
        twitchId: v.string(),
        login: v.optional(v.string()),
        displayName: v.optional(v.string()),
      }),
    ),
    now: v.number(),
  },
  returns: v.object({ active: v.number(), deactivated: v.number() }),
  handler: async (ctx, a) => {
    const present = new Set(a.mods.map((m) => m.twitchId));

    // Upsert each present mod; link to the app user id when the profile exists.
    for (const m of a.mods) {
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_twitchId", (q) => q.eq("twitchId", m.twitchId))
        .unique();
      const existing = await ctx.db
        .query("canvasModerators")
        .withIndex("by_canvas_twitch", (q) => q.eq("canvasId", a.canvasId).eq("twitchId", m.twitchId))
        .unique();
      const fields = {
        userId: profile?.authUserId,
        login: m.login,
        displayName: m.displayName,
        source: "twitch" as const,
        active: true,
        syncedAt: a.now,
      };
      if (existing) await ctx.db.patch(existing._id, fields);
      else await ctx.db.insert("canvasModerators", { canvasId: a.canvasId, twitchId: m.twitchId, ...fields });
    }

    // Deactivate previously-synced Twitch mods who are no longer channel mods.
    let deactivated = 0;
    const synced = await ctx.db
      .query("canvasModerators")
      .withIndex("by_canvas_active", (q) => q.eq("canvasId", a.canvasId).eq("active", true))
      .collect();
    for (const row of synced) {
      if (row.source === "twitch" && !present.has(row.twitchId)) {
        await ctx.db.patch(row._id, { active: false, syncedAt: a.now });
        deactivated++;
      }
    }

    await writeAudit(ctx, {
      canvasId: a.canvasId,
      action: "mod_sync",
      actorUserId: a.actorUserId,
      cellsAffected: 0,
      detail: `twitch sync: ${a.mods.length} active, ${deactivated} removed`,
      now: a.now,
    });

    return { active: a.mods.length, deactivated };
  },
});

/**
 * F8.5 — sync the owner's Twitch channel moderators into `canvasModerators`.
 * Uses the owner's auto-refreshed Twitch token (CA4, `auth:getTwitchAccessToken`)
 * and the Helix `/moderation/moderators` endpoint (needs the `moderation:read`
 * scope already requested at sign-in). Paginates the full roster.
 */
export const syncTwitchModerators = action({
  args: { canvasId: v.id("canvases") },
  returns: v.object({ active: v.number(), deactivated: v.number() }),
  handler: async (ctx, a): Promise<{ active: number; deactivated: number }> => {
    const actorUserId = await requireUserId(ctx);
    const { broadcasterId } = await ctx.runQuery(internal.moderation.prepareTwitchSync, {
      canvasId: a.canvasId,
      actorUserId,
    });

    const { accessToken } = await ctx.runAction(internal.auth.getTwitchAccessToken, {});
    if (!accessToken) throw new Error("twitch_token_unavailable: re-authenticate with Twitch.");
    const clientId = process.env.TWITCH_CLIENT_ID;
    if (!clientId) throw new Error("twitch_client_id_unset.");

    const mods: Array<{ twitchId: string; login?: string; displayName?: string }> = [];
    let cursor: string | undefined;
    // Paginate Helix (100/page). Bounded loop guards against a runaway cursor.
    for (let page = 0; page < 100; page++) {
      const url = new URL("https://api.twitch.tv/helix/moderation/moderators");
      url.searchParams.set("broadcaster_id", broadcasterId);
      url.searchParams.set("first", "100");
      if (cursor) url.searchParams.set("after", cursor);
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${accessToken}`, "client-id": clientId },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`twitch_helix_failed: ${res.status} ${text}`.trim());
      }
      const body = (await res.json()) as {
        data?: TwitchModerator[];
        pagination?: { cursor?: string };
      };
      for (const m of body.data ?? []) {
        mods.push({ twitchId: m.user_id, login: m.user_login, displayName: m.user_name });
      }
      cursor = body.pagination?.cursor;
      if (!cursor) break;
    }

    return ctx.runMutation(internal.moderation.applyTwitchSync, {
      canvasId: a.canvasId,
      actorUserId,
      mods,
      now: Date.now(),
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Reads (dashboard).
// ─────────────────────────────────────────────────────────────────────────────

/** Whether a user is banned on a canvas — the gateway placement gate consults this. */
export const isBanned = query({
  args: { canvasId: v.id("canvases"), userId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, a) => {
    const ban = await ctx.db
      .query("bans")
      .withIndex("by_canvas_user", (q) => q.eq("canvasId", a.canvasId).eq("userId", a.userId))
      .unique();
    return !!ban && ban.active;
  },
});

/** Active bans on a canvas (owner/mod dashboard). */
export const listBans = query({
  args: { canvasId: v.id("canvases") },
  handler: async (ctx, a) => {
    const userId = await requireUserId(ctx);
    await assertCanModerate(ctx, a.canvasId, userId);
    return ctx.db
      .query("bans")
      .withIndex("by_canvas_active", (q) => q.eq("canvasId", a.canvasId).eq("active", true))
      .collect();
  },
});

/** Active moderators on a canvas (owner/mod dashboard). */
export const listModerators = query({
  args: { canvasId: v.id("canvases") },
  handler: async (ctx, a) => {
    const userId = await requireUserId(ctx);
    await assertCanModerate(ctx, a.canvasId, userId);
    return ctx.db
      .query("canvasModerators")
      .withIndex("by_canvas_active", (q) => q.eq("canvasId", a.canvasId).eq("active", true))
      .collect();
  },
});

/** Recent audit entries for a canvas, newest first (CA6 dashboard). */
export const listAuditLog = query({
  args: { canvasId: v.id("canvases"), limit: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const userId = await requireUserId(ctx);
    await assertCanModerate(ctx, a.canvasId, userId);
    const limit = Math.max(1, Math.min(a.limit ?? 50, 200));
    return ctx.db
      .query("auditLog")
      .withIndex("by_canvas_time", (q) => q.eq("canvasId", a.canvasId))
      .order("desc")
      .take(limit);
  },
});
