/**
 * F8 moderation Convex layer (FEN-52) — implements the frozen contract
 * docs/contracts/moderation.md (FE sign-off 2026-06-02). It authorises a mod
 * action, derives *which cells + colours* to write from the durable `placements`
 * log, journals it (CA6), then triggers the shipped hot-path engine
 * (`moderate.lua`, FEN-19) to apply the bulk overwrite atomically. Convex never
 * touches Redis (G-A1) — the overwrite, the `canvas:frozen` flag and the
 * pre-action flush are dispatched over HTTP to the gateway's `/internal/*`
 * endpoints (Dev Backend; see docs/contracts/moderation-internal.md). Until those
 * exist / `GATEWAY_INTERNAL_URL` is set, the actions record durable state and
 * report the dispatch as `gateway_not_configured` (no throw), so this layer is
 * deployable and testable today.
 *
 * Restore model (the crux, F8.3): there is no dedicated event log. A removal
 * stores a `pixelModeration` row keyed to its `auditLog` action (`modActionId`);
 * restore re-applies `removedColor` for every cell that action touched
 * (`by_modAction`), idempotent on already-`restored` rows.
 *
 * Frozen mutation signatures: banAndWipe / unban / deletePixels / restore /
 * setFrozen / syncTwitchMods. Each authorises against `canvasModerators` (active
 * owner/mod), appends to `auditLog`, and forces a flush before any mass read.
 *
 * Convex env: GATEWAY_INTERNAL_URL, GATEWAY_INTERNAL_SECRET, TWITCH_CLIENT_ID.
 */
import { v } from "convex/values";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireUserId } from "./lib/identity";
import { planDelete, planWipe, removalCells } from "./lib/moderation";
import type { PlacementRow, RemovalPlan } from "./lib/moderation";

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers (query/mutation ctx).
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

/**
 * Whether `userId` is actively banned on `canvasId`. The single durable ban
 * lookup shared by the gateway-facing `isBanned` query and the `canPlace`
 * placement gate (`canvases.ts`), so the two never drift. A ban row is a point
 * record per `(canvasId, userId)`; only `active` rows deny.
 */
export async function isUserBanned(
  ctx: QueryCtx,
  canvasId: Id<"canvases">,
  userId: string,
): Promise<boolean> {
  const ban = await ctx.db
    .query("bans")
    .withIndex("by_canvas_user", (q) => q.eq("canvasId", canvasId).eq("userId", userId))
    .unique();
  return !!ban && ban.active;
}

/** Palette size (colour count) — the `paletteSize` the hot-path needs. */
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

/** Append an audit row (CA6); returns its id (the `modActionId` overlays link to). */
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

/** Insert the `pixelModeration` overlay rows for a removal action (CA2). */
async function recordRemovals(
  ctx: MutationCtx,
  args: {
    canvasId: Id<"canvases">;
    modActionId: Id<"auditLog">;
    plans: ReadonlyArray<RemovalPlan>;
    reason?: string;
    now: number;
  },
): Promise<void> {
  for (const p of args.plans) {
    await ctx.db.insert("pixelModeration", {
      canvasId: args.canvasId,
      x: p.x,
      y: p.y,
      removedUserId: p.removedUserId,
      removedColor: p.removedColor,
      removedVersion: p.removedVersion,
      underneathColor: p.underneathColor,
      modActionId: args.modActionId,
      reason: args.reason,
      restored: false,
      createdAt: args.now,
    });
  }
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

const metaValidator = v.object({
  slug: v.string(),
  width: v.number(),
  height: v.number(),
  paletteSize: v.number(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal authz + record mutations/queries.
// ─────────────────────────────────────────────────────────────────────────────

/** Authorise + return the dispatch meta (slug/geometry) without mutating. */
export const getActionMeta = internalQuery({
  args: { canvasId: v.id("canvases"), actorUserId: v.string() },
  returns: metaValidator,
  handler: async (ctx, a) => {
    const canvas = await assertCanModerate(ctx, a.canvasId, a.actorUserId);
    return {
      slug: canvas.slug,
      width: canvas.width,
      height: canvas.height,
      paletteSize: await paletteSizeOf(ctx, canvas),
    };
  },
});

/** F8.1 — upsert the ban + record removals for the author's wiped pixels. */
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
    const plans = planWipe(await loadPlacements(ctx, a.canvasId), a.targetUserId);

    const ban = await ctx.db
      .query("bans")
      .withIndex("by_canvas_user", (q) => q.eq("canvasId", a.canvasId).eq("userId", a.targetUserId))
      .unique();
    if (ban) {
      await ctx.db.patch(ban._id, {
        active: true,
        bannedBy: a.actorUserId,
        reason: a.reason,
        liftedAt: undefined,
        liftedBy: undefined,
      });
    } else {
      await ctx.db.insert("bans", {
        canvasId: a.canvasId,
        userId: a.targetUserId,
        bannedBy: a.actorUserId,
        reason: a.reason,
        active: true,
        createdAt: a.now,
      });
    }

    const auditId = await writeAudit(ctx, {
      canvasId: a.canvasId,
      action: "ban_wipe",
      actorUserId: a.actorUserId,
      targetUserId: a.targetUserId,
      cellsAffected: plans.length,
      reason: a.reason,
      detail: "dispatch_pending",
      now: a.now,
    });
    await recordRemovals(ctx, { canvasId: a.canvasId, modActionId: auditId, plans, reason: a.reason, now: a.now });

    return {
      slug: canvas.slug,
      width: canvas.width,
      height: canvas.height,
      paletteSize: await paletteSizeOf(ctx, canvas),
      cells: removalCells(plans),
      auditId,
    };
  },
});

/** F8.1 unban — keep the row, flip inactive; returns slug for the gateway ban push. */
export const unbanMut = internalMutation({
  args: { canvasId: v.id("canvases"), targetUserId: v.string(), actorUserId: v.string(), now: v.number() },
  returns: v.object({ slug: v.string(), auditId: v.id("auditLog"), changed: v.boolean() }),
  handler: async (ctx, a) => {
    const canvas = await assertCanModerate(ctx, a.canvasId, a.actorUserId);
    const ban = await ctx.db
      .query("bans")
      .withIndex("by_canvas_user", (q) => q.eq("canvasId", a.canvasId).eq("userId", a.targetUserId))
      .unique();
    let changed = false;
    if (ban && ban.active) {
      await ctx.db.patch(ban._id, { active: false, liftedAt: a.now, liftedBy: a.actorUserId });
      changed = true;
    }
    const auditId = await writeAudit(ctx, {
      canvasId: a.canvasId,
      action: "unban",
      actorUserId: a.actorUserId,
      targetUserId: a.targetUserId,
      cellsAffected: 0,
      now: a.now,
    });
    return { slug: canvas.slug, auditId, changed };
  },
});

/** F8.2 — record removals for unit/group deletes. */
export const prepareDelete = internalMutation({
  args: {
    canvasId: v.id("canvases"),
    actorUserId: v.string(),
    cells: v.array(v.object({ x: v.number(), y: v.number() })),
    reason: v.optional(v.string()),
    now: v.number(),
  },
  returns: preparedValidator,
  handler: async (ctx, a) => {
    const canvas = await assertCanModerate(ctx, a.canvasId, a.actorUserId);
    const plans = planDelete(await loadPlacements(ctx, a.canvasId), a.cells);

    const auditId = await writeAudit(ctx, {
      canvasId: a.canvasId,
      action: "delete",
      actorUserId: a.actorUserId,
      cellsAffected: plans.length,
      reason: a.reason,
      detail: "dispatch_pending",
      now: a.now,
    });
    await recordRemovals(ctx, { canvasId: a.canvasId, modActionId: auditId, plans, reason: a.reason, now: a.now });

    return {
      slug: canvas.slug,
      width: canvas.width,
      height: canvas.height,
      paletteSize: await paletteSizeOf(ctx, canvas),
      cells: removalCells(plans),
      auditId,
    };
  },
});

/** F8.3 — re-apply the removed colours of an action's cells; mark them restored. */
export const prepareRestore = internalMutation({
  args: {
    canvasId: v.id("canvases"),
    actorUserId: v.string(),
    modActionId: v.id("auditLog"),
    now: v.number(),
  },
  returns: preparedValidator,
  handler: async (ctx, a) => {
    const canvas = await assertCanModerate(ctx, a.canvasId, a.actorUserId);
    const rows = await ctx.db
      .query("pixelModeration")
      .withIndex("by_modAction", (q) => q.eq("modActionId", a.modActionId))
      .collect();
    const pending = rows.filter((r) => !r.restored && r.canvasId === a.canvasId);

    const auditId = await writeAudit(ctx, {
      canvasId: a.canvasId,
      action: "restore",
      actorUserId: a.actorUserId,
      cellsAffected: pending.length,
      detail: "dispatch_pending",
      now: a.now,
    });
    for (const r of pending) {
      await ctx.db.patch(r._id, { restored: true, restoredActionId: auditId });
    }

    return {
      slug: canvas.slug,
      width: canvas.width,
      height: canvas.height,
      paletteSize: await paletteSizeOf(ctx, canvas),
      cells: pending.map((r) => ({ x: r.x, y: r.y, color: r.removedColor })),
      auditId,
    };
  },
});

/** F8.4 — freeze toggle: patch the durable mirror + audit, return slug. */
export const prepareFreeze = internalMutation({
  args: { canvasId: v.id("canvases"), actorUserId: v.string(), frozen: v.boolean(), now: v.number() },
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

/** Stamp the dispatch outcome (+ optional bumped version) after the gateway call. */
export const finalizeModerate = internalMutation({
  args: { auditId: v.id("auditLog"), detail: v.string(), overwriteVersion: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, a) => {
    await ctx.db.patch(a.auditId, { detail: a.detail });
    if (a.overwriteVersion !== undefined) {
      const rows = await ctx.db
        .query("pixelModeration")
        .withIndex("by_modAction", (q) => q.eq("modActionId", a.auditId))
        .collect();
      for (const r of rows) await ctx.db.patch(r._id, { overwriteVersion: a.overwriteVersion });
    }
    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Gateway dispatch (HTTP; runs only inside actions).
// ─────────────────────────────────────────────────────────────────────────────

interface DispatchResult {
  dispatched: boolean;
  detail: string;
  version?: number;
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
  const json = (await res.json().catch(() => ({}))) as { version?: number };
  return { dispatched: true, detail: `gateway ${res.status} ${path}`, version: json.version };
}

/**
 * Force a Redis→Convex flush before a mass action (issue scope §7) so the durable
 * log reflects pre-action state. Best-effort: if the gateway isn't configured we
 * proceed on the already-flushed log; the gateway owns the buffer drain.
 */
async function forceFlush(slug: string): Promise<void> {
  await gatewayPost("/internal/flush", { slug }).catch(() => undefined);
}

/** Apply a computed cell batch via the hot-path engine (the gateway builds moderateArgs). */
async function dispatchModerate(batch: {
  slug: string;
  width: number;
  height: number;
  paletteSize: number;
  cells: Array<{ x: number; y: number; color: number }>;
}): Promise<DispatchResult> {
  if (batch.cells.length === 0) return { dispatched: false, detail: "no_cells" };
  return gatewayPost("/internal/moderate", batch);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public actions: authz → flush → record → dispatch → finalise.
// ─────────────────────────────────────────────────────────────────────────────

const actionResult = v.object({
  cellsAffected: v.number(),
  dispatched: v.boolean(),
  detail: v.string(),
});

type ActionResult = { cellsAffected: number; dispatched: boolean; detail: string };

/** F8.1 — ban an author and wipe their pixels (reveal what was underneath, CA1). */
export const banAndWipe = action({
  args: { canvasId: v.id("canvases"), targetUserId: v.string(), reason: v.optional(v.string()) },
  returns: actionResult,
  handler: async (ctx, a): Promise<ActionResult> => {
    const actorUserId = await requireUserId(ctx);
    const meta = await ctx.runQuery(internal.moderation.getActionMeta, { canvasId: a.canvasId, actorUserId });
    await forceFlush(meta.slug); // mass action: flush before reading state
    const batch = await ctx.runMutation(internal.moderation.prepareBanWipe, {
      canvasId: a.canvasId,
      targetUserId: a.targetUserId,
      actorUserId,
      reason: a.reason,
      now: Date.now(),
    });
    const result = await dispatchModerate(batch);
    await ctx.runMutation(internal.moderation.finalizeModerate, {
      auditId: batch.auditId,
      detail: result.detail,
      overwriteVersion: result.version,
    });
    return { cellsAffected: batch.cells.length, dispatched: result.dispatched, detail: result.detail };
  },
});

/** F8.1 — lift a ban (gateway re-allows the user; CA6 audit). */
export const unban = action({
  args: { canvasId: v.id("canvases"), targetUserId: v.string() },
  returns: v.object({ changed: v.boolean(), dispatched: v.boolean(), detail: v.string() }),
  handler: async (ctx, a): Promise<{ changed: boolean; dispatched: boolean; detail: string }> => {
    const actorUserId = await requireUserId(ctx);
    const r = await ctx.runMutation(internal.moderation.unbanMut, {
      canvasId: a.canvasId,
      targetUserId: a.targetUserId,
      actorUserId,
      now: Date.now(),
    });
    const result = await gatewayPost("/internal/ban", { slug: r.slug, userId: a.targetUserId, banned: false });
    await ctx.runMutation(internal.moderation.finalizeModerate, { auditId: r.auditId, detail: result.detail });
    return { changed: r.changed, dispatched: result.dispatched, detail: result.detail };
  },
});

/** F8.2 — delete a single cell or a group (reveal underneath, CA2/CA3). */
export const deletePixels = action({
  args: {
    canvasId: v.id("canvases"),
    cells: v.array(v.object({ x: v.number(), y: v.number() })),
    reason: v.optional(v.string()),
  },
  returns: actionResult,
  handler: async (ctx, a): Promise<ActionResult> => {
    const actorUserId = await requireUserId(ctx);
    const meta = await ctx.runQuery(internal.moderation.getActionMeta, { canvasId: a.canvasId, actorUserId });
    await forceFlush(meta.slug);
    const batch = await ctx.runMutation(internal.moderation.prepareDelete, {
      canvasId: a.canvasId,
      actorUserId,
      cells: a.cells,
      reason: a.reason,
      now: Date.now(),
    });
    const result = await dispatchModerate(batch);
    await ctx.runMutation(internal.moderation.finalizeModerate, {
      auditId: batch.auditId,
      detail: result.detail,
      overwriteVersion: result.version,
    });
    return { cellsAffected: batch.cells.length, dispatched: result.dispatched, detail: result.detail };
  },
});

/** F8.3 — restore every cell a prior moderation action removed (idempotent). */
export const restore = action({
  args: { canvasId: v.id("canvases"), modActionId: v.id("auditLog") },
  returns: actionResult,
  handler: async (ctx, a): Promise<ActionResult> => {
    const actorUserId = await requireUserId(ctx);
    const batch = await ctx.runMutation(internal.moderation.prepareRestore, {
      canvasId: a.canvasId,
      actorUserId,
      modActionId: a.modActionId,
      now: Date.now(),
    });
    const result = await dispatchModerate(batch);
    await ctx.runMutation(internal.moderation.finalizeModerate, { auditId: batch.auditId, detail: result.detail });
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
    await ctx.runMutation(internal.moderation.finalizeModerate, { auditId, detail: result.detail });
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

/** Resolve the canvas owner's Twitch broadcaster id (authz happens here). */
export const prepareTwitchSync = internalQuery({
  args: { canvasId: v.id("canvases"), actorUserId: v.string() },
  returns: v.object({ broadcasterId: v.string() }),
  handler: async (ctx, a) => {
    const canvas = await assertCanModerate(ctx, a.canvasId, a.actorUserId);
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

/** Upsert the synced roster, deactivating `twitch_sync` mods no longer present (CA5). */
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
        source: "twitch_sync" as const,
        active: true,
        syncedAt: a.now,
      };
      if (existing) await ctx.db.patch(existing._id, fields);
      else await ctx.db.insert("canvasModerators", { canvasId: a.canvasId, twitchId: m.twitchId, ...fields });
    }

    // Deactivate previously-synced Twitch mods who are no longer channel mods.
    // Owner-granted (`source === "manual"`) rows are never touched by sync.
    let deactivated = 0;
    const active = await ctx.db
      .query("canvasModerators")
      .withIndex("by_canvas_active", (q) => q.eq("canvasId", a.canvasId).eq("active", true))
      .collect();
    for (const row of active) {
      if (row.source === "twitch_sync" && !present.has(row.twitchId)) {
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
 * and Helix `GET /moderation/moderators` (needs the `moderation:read` scope
 * granted at sign-in). Paginates the full roster. A synced mod gains rights with
 * no owner action (CA5).
 */
export const syncTwitchMods = action({
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
      const body = (await res.json()) as { data?: TwitchModerator[]; pagination?: { cursor?: string } };
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
  handler: async (ctx, a) => isUserBanned(ctx, a.canvasId, a.userId),
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
      .withIndex("by_canvas_ts", (q) => q.eq("canvasId", a.canvasId))
      .order("desc")
      .take(limit);
  },
});
