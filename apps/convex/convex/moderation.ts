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
import { v, ConvexError } from "convex/values";
import { ERRORS } from "./errors";
import { AUDIT_ACTIONS, MOD_SOURCES } from "./schema";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { optionalUserId, requireUserId } from "./lib/identity";
import { forceFlush, gatewayPost, type DispatchResult } from "./lib/gateway";
import { getProfileByAuthUserId } from "./lib/profiles";
import { authorOfTop, groupCellsAt, planDelete, planWipe, planModeratorSync, removalCells } from "./lib/moderation";
import type { PlacementRow, RemovalPlan } from "./lib/moderation";
import { TWITCH_CLIENT_ID } from "./env";

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers (query/mutation ctx).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single source of truth for owner+mod authority. Returns the canvas (or null
 * when not found) and whether `userId` is authorised to moderate it.
 */
async function resolveModAuthority(
  ctx: QueryCtx,
  canvasId: Id<"canvases">,
  userId: string,
): Promise<{ canvas: Doc<"canvases"> | null; authorized: boolean }> {
  const canvas = await ctx.db.get(canvasId);
  if (!canvas) return { canvas: null, authorized: false };
  if (canvas.ownerId === userId) return { canvas, authorized: true };
  const mod = await ctx.db
    .query("canvasModerators")
    .withIndex("by_canvas_user", (q) => q.eq("canvasId", canvasId).eq("userId", userId))
    .unique();
  return { canvas, authorized: !!mod && mod.active };
}

/** Owner OR active delegated moderator may act; otherwise throw. Returns the canvas. */
async function assertCanModerate(
  ctx: QueryCtx,
  canvasId: Id<"canvases">,
  userId: string,
): Promise<Doc<"canvases">> {
  const { canvas, authorized } = await resolveModAuthority(ctx, canvasId, userId);
  if (!canvas) throw new ConvexError(ERRORS.CANVAS_NOT_FOUND);
  if (!authorized) throw new ConvexError(ERRORS.FORBIDDEN);
  return canvas;
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

/** Whole durable placement log for a canvas (off hot-path; mass actions only). */
async function loadPlacements(ctx: QueryCtx, canvasId: Id<"canvases">): Promise<PlacementRow[]> {
  const rows = await ctx.db
    .query("placements")
    .withIndex("by_canvas_version", (q) => q.eq("canvasId", canvasId))
    .collect();
  return rows.map((r) => ({
    x: r.x,
    y: r.y,
    color: r.color,
    version: r.version,
    userId: r.userId,
    ts: r.ts,
  }));
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
  cells: v.array(v.object({ x: v.number(), y: v.number(), color: v.number() })),
  auditId: v.id("auditLog"),
});

const metaValidator = v.object({
  slug: v.string(),
  width: v.number(),
  height: v.number(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal authz + record mutations/queries.
// ─────────────────────────────────────────────────────────────────────────────

/** Authorise + return the dispatch meta (slug/geometry) without mutating. */
export const PREAUTH_getActionMeta = internalQuery({
  args: { canvasId: v.id("canvases"), actorUserId: v.string() },
  returns: metaValidator,
  handler: async (ctx, a) => {
    const canvas = await assertCanModerate(ctx, a.canvasId, a.actorUserId);
    return {
      slug: canvas.slug,
      width: canvas.width,
      height: canvas.height,
    };
  },
});

/** F8.1 — upsert the ban + record removals for the author's wiped pixels. */
export const PREAUTH_prepareBanWipe = internalMutation({
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
      action: AUDIT_ACTIONS.BAN_WIPE,
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
      cells: removalCells(plans),
      auditId,
    };
  },
});

/** F8.1 unban — keep the row, flip inactive; returns slug for the gateway ban push. */
export const PREAUTH_unbanMut = internalMutation({
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
      action: AUDIT_ACTIONS.UNBAN,
      actorUserId: a.actorUserId,
      targetUserId: a.targetUserId,
      cellsAffected: 0,
      now: a.now,
    });
    return { slug: canvas.slug, auditId, changed };
  },
});

/** F8.2 — record removals for unit/group deletes. */
export const PREAUTH_prepareDelete = internalMutation({
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
      action: AUDIT_ACTIONS.DELETE,
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
      cells: removalCells(plans),
      auditId,
    };
  },
});

/**
 * S8.4 (gap G2) — record removals for the "simultaneous batch" of the author of
 * the pixel at (x,y). Resolves the group from the durable log via `groupCellsAt`
 * (post-flush, since this runs inside `runCellRewrite`), then reuses `planDelete`
 * so the reveal-underneath semantics and `pixelModeration` overlay are identical
 * to a manual group delete. No actionable author at the cell ⇒ an empty batch
 * (audited with 0 cells; the dispatch is a `no_cells` no-op).
 */
export const PREAUTH_prepareGroupDelete = internalMutation({
  args: {
    canvasId: v.id("canvases"),
    actorUserId: v.string(),
    x: v.number(),
    y: v.number(),
    reason: v.optional(v.string()),
    now: v.number(),
  },
  returns: preparedValidator,
  handler: async (ctx, a) => {
    const canvas = await assertCanModerate(ctx, a.canvasId, a.actorUserId);
    const placements = await loadPlacements(ctx, a.canvasId);
    const { cells } = groupCellsAt(placements, { x: a.x, y: a.y });
    const plans = planDelete(placements, cells);

    const auditId = await writeAudit(ctx, {
      canvasId: a.canvasId,
      action: AUDIT_ACTIONS.DELETE,
      actorUserId: a.actorUserId,
      cellsAffected: plans.length,
      reason: a.reason,
      detail: "group_dispatch_pending",
      now: a.now,
    });
    await recordRemovals(ctx, { canvasId: a.canvasId, modActionId: auditId, plans, reason: a.reason, now: a.now });

    return {
      slug: canvas.slug,
      width: canvas.width,
      height: canvas.height,
      cells: removalCells(plans),
      auditId,
    };
  },
});

/** F8.3 — re-apply the removed colours of an action's cells; mark them restored. */
export const PREAUTH_prepareRestore = internalMutation({
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
      action: AUDIT_ACTIONS.RESTORE,
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
      cells: pending.map((r) => ({ x: r.x, y: r.y, color: r.removedColor })),
      auditId,
    };
  },
});

/** F8.4 — freeze toggle: patch the durable mirror + audit, return slug. */
export const PREAUTH_prepareFreeze = internalMutation({
  args: { canvasId: v.id("canvases"), actorUserId: v.string(), frozen: v.boolean(), now: v.number() },
  returns: v.object({ slug: v.string(), auditId: v.id("auditLog") }),
  handler: async (ctx, a) => {
    const canvas = await assertCanModerate(ctx, a.canvasId, a.actorUserId);
    // `placementOpen === false` is the durable mirror of the Redis freeze flag.
    await ctx.db.patch(a.canvasId, { placementOpen: !a.frozen });
    const auditId = await writeAudit(ctx, {
      canvasId: a.canvasId,
      action: a.frozen ? AUDIT_ACTIONS.FREEZE : AUDIT_ACTIONS.UNFREEZE,
      actorUserId: a.actorUserId,
      cellsAffected: 0,
      now: a.now,
    });
    return { slug: canvas.slug, auditId };
  },
});

/** Stamp the dispatch outcome (+ optional bumped version) after the gateway call. */
export const UNAUTH_finalizeModerate = internalMutation({
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
// The `gatewayPost` envelope is shared with points.ts via ./lib/gateway (1g).
// `forceFlush` is shared with account.ts via ./lib/gateway (N5).
// ─────────────────────────────────────────────────────────────────────────────

/** Apply a computed cell batch via the hot-path engine (the gateway builds moderateArgs). */
async function dispatchModerate(batch: {
  canvasId: Id<"canvases">;
  slug: string;
  width: number;
  height: number;
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

/** The prepared cell batch every cell-rewriting moderation action produces. */
type PreparedBatch = {
  slug: string;
  width: number;
  height: number;
  cells: Array<{ x: number; y: number; color: number }>;
  auditId: Id<"auditLog">;
};

/**
 * The shared cell-rewriting moderation pipeline (audit 3b). Every mass action
 * that rewrites cells runs the same five steps: authorise + read canvas meta,
 * `forceFlush` the Redis stream so the durable log reflects pre-action state
 * before the mass read/write, run the action-specific `prepare` mutation,
 * dispatch the atomic Redis rewrite, then finalise the audit row (stamping the
 * overwrite version). banAndWipe / deletePixels / restore differ only in their
 * `prepare` step, so it lives here once.
 *
 * `restore` was the one hand-copied variant that dropped the `forceFlush`
 * (audit 3b latent bug) — routing it through this path restores it. The
 * overwriteVersion stamp is a harmless no-op for restore (its audit row owns no
 * `pixelModeration` rows under `by_modAction`), so one path is safe for all three.
 */
async function runCellRewrite(
  ctx: ActionCtx,
  canvasId: Id<"canvases">,
  actorUserId: string,
  prepare: () => Promise<PreparedBatch>,
): Promise<ActionResult> {
  const meta = await ctx.runQuery(internal.moderation.PREAUTH_getActionMeta, { canvasId, actorUserId });
  await forceFlush(canvasId, meta.slug); // mass action: flush before reading/writing state
  const batch = await prepare();
  // FEN-1933: thread the Convex `_id` — the gateway routes Redis keys AND the
  // delta fan-out channel off `body.canvasId`; `batch.slug` alone lands on the
  // gateway's default canvas (dead namespace since FEN-1613).
  const result = await dispatchModerate({
    canvasId,
    slug: batch.slug,
    width: batch.width,
    height: batch.height,
    cells: batch.cells,
  });
  await ctx.runMutation(internal.moderation.UNAUTH_finalizeModerate, {
    auditId: batch.auditId,
    detail: result.detail,
    overwriteVersion: result.version,
  });
  return { cellsAffected: batch.cells.length, dispatched: result.dispatched, detail: result.detail };
}

/** F8.1 — ban an author and wipe their pixels (reveal what was underneath, CA1). */
export const banAndWipe = action({
  args: { canvasId: v.id("canvases"), targetUserId: v.string(), reason: v.optional(v.string()) },
  returns: actionResult,
  handler: async (ctx, a): Promise<ActionResult> => {
    const actorUserId = await requireUserId(ctx);
    return runCellRewrite(ctx, a.canvasId, actorUserId, () =>
      ctx.runMutation(internal.moderation.PREAUTH_prepareBanWipe, {
        canvasId: a.canvasId,
        targetUserId: a.targetUserId,
        actorUserId,
        reason: a.reason,
        now: Date.now(),
      }),
    );
  },
});

/**
 * F8.1 — lift a ban (gateway re-allows the user; CA6 audit).
 * Ops seam (D6): no ban-lift UI yet — kept for DevOps/mod tooling; do not remove.
 */
export const unban = action({
  args: { canvasId: v.id("canvases"), targetUserId: v.string() },
  returns: v.object({ changed: v.boolean(), dispatched: v.boolean(), detail: v.string() }),
  handler: async (ctx, a): Promise<{ changed: boolean; dispatched: boolean; detail: string }> => {
    const actorUserId = await requireUserId(ctx);
    const r = await ctx.runMutation(internal.moderation.PREAUTH_unbanMut, {
      canvasId: a.canvasId,
      targetUserId: a.targetUserId,
      actorUserId,
      now: Date.now(),
    });
    const result = await gatewayPost("/internal/ban", {
      canvasId: a.canvasId, // FEN-1933: gateway routes off canvasId, not slug
      slug: r.slug,
      userId: a.targetUserId,
      banned: false,
    });
    await ctx.runMutation(internal.moderation.UNAUTH_finalizeModerate, { auditId: r.auditId, detail: result.detail });
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
    return runCellRewrite(ctx, a.canvasId, actorUserId, () =>
      ctx.runMutation(internal.moderation.PREAUTH_prepareDelete, {
        canvasId: a.canvasId,
        actorUserId,
        cells: a.cells,
        reason: a.reason,
        now: Date.now(),
      }),
    );
  },
});

/**
 * S8.4 (gap G2) — delete the whole simultaneous batch the pixel at (x,y) belongs
 * to (every currently-visible cell its author placed in the same burst). Resolves
 * the group server-side from the post-flush durable log so the client only sends
 * the clicked coordinate — never a free cell list (the issue's "PAS une marquee
 * libre"). Shares the `runCellRewrite` pipeline (flush → record → dispatch →
 * finalise) with the unit delete; differs only in its `prepare` step.
 */
export const deleteGroupAt = action({
  args: {
    canvasId: v.id("canvases"),
    x: v.number(),
    y: v.number(),
    reason: v.optional(v.string()),
  },
  returns: actionResult,
  handler: async (ctx, a): Promise<ActionResult> => {
    const actorUserId = await requireUserId(ctx);
    return runCellRewrite(ctx, a.canvasId, actorUserId, () =>
      ctx.runMutation(internal.moderation.PREAUTH_prepareGroupDelete, {
        canvasId: a.canvasId,
        actorUserId,
        x: a.x,
        y: a.y,
        reason: a.reason,
        now: Date.now(),
      }),
    );
  },
});

/** F8.3 — restore every cell a prior moderation action removed (idempotent). */
export const restore = action({
  args: { canvasId: v.id("canvases"), modActionId: v.id("auditLog") },
  returns: actionResult,
  handler: async (ctx, a): Promise<ActionResult> => {
    const actorUserId = await requireUserId(ctx);
    // Now goes through the shared pipeline → gains the pre-action forceFlush it
    // previously skipped (audit 3b), so the restore reads/writes post-flush state.
    return runCellRewrite(ctx, a.canvasId, actorUserId, () =>
      ctx.runMutation(internal.moderation.PREAUTH_prepareRestore, {
        canvasId: a.canvasId,
        actorUserId,
        modActionId: a.modActionId,
        now: Date.now(),
      }),
    );
  },
});

/** F8.4 — emergency freeze / unfreeze: SET/DEL `canvas:frozen` via the gateway. */
export const setFrozen = action({
  args: { canvasId: v.id("canvases"), frozen: v.boolean() },
  returns: v.object({ frozen: v.boolean(), dispatched: v.boolean(), detail: v.string() }),
  handler: async (ctx, a): Promise<{ frozen: boolean; dispatched: boolean; detail: string }> => {
    const actorUserId = await requireUserId(ctx);
    const { slug, auditId } = await ctx.runMutation(internal.moderation.PREAUTH_prepareFreeze, {
      canvasId: a.canvasId,
      actorUserId,
      frozen: a.frozen,
      now: Date.now(),
    });
    const result = await gatewayPost("/internal/freeze", {
      canvasId: a.canvasId, // FEN-1933: gateway routes off canvasId, not slug
      slug,
      frozen: a.frozen,
    });
    await ctx.runMutation(internal.moderation.UNAUTH_finalizeModerate, { auditId, detail: result.detail });
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
export const PREAUTH_prepareTwitchSync = internalQuery({
  args: { canvasId: v.id("canvases"), actorUserId: v.string() },
  returns: v.object({ broadcasterId: v.string() }),
  handler: async (ctx, a) => {
    const canvas = await assertCanModerate(ctx, a.canvasId, a.actorUserId);
    const profile = await getProfileByAuthUserId(ctx.db, canvas.ownerId);
    if (!profile || !profile.twitchId) {
      throw new ConvexError(ERRORS.OWNER_TWITCH_UNKNOWN);
    }
    return { broadcasterId: profile.twitchId };
  },
});

/** Upsert the synced roster, deactivating `twitch_sync` mods no longer present (CA5). */
export const PREAUTH_applyTwitchSync = internalMutation({
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
    const activeRows = await ctx.db
      .query("canvasModerators")
      .withIndex("by_canvas_active", (q) => q.eq("canvasId", a.canvasId).eq("active", true))
      .collect();
    const { toUpsert, toDeactivate } = planModeratorSync(activeRows, a.mods);
    const deactivateSet = new Set(toDeactivate);

    // Parallelize the two reads per mod (profile + existing row) before writing.
    const upsertLookups = await Promise.all(
      toUpsert.map(async (m) => ({
        m,
        profile: await ctx.db
          .query("profiles")
          .withIndex("by_twitchId", (q) => q.eq("twitchId", m.twitchId))
          .unique(),
        existing: await ctx.db
          .query("canvasModerators")
          .withIndex("by_canvas_twitch", (q) => q.eq("canvasId", a.canvasId).eq("twitchId", m.twitchId))
          .unique(),
      })),
    );
    for (const { m, profile, existing } of upsertLookups) {
      const fields = {
        userId: profile?.authUserId,
        login: m.login,
        displayName: m.displayName,
        source: MOD_SOURCES.TWITCH_SYNC,
        active: true,
        syncedAt: a.now,
      };
      if (existing) await ctx.db.patch(existing._id, fields);
      else await ctx.db.insert("canvasModerators", { canvasId: a.canvasId, twitchId: m.twitchId, ...fields });
    }

    // Owner-granted (`source === "manual"`) rows are never touched by sync.
    for (const row of activeRows) {
      if (deactivateSet.has(row.twitchId)) {
        await ctx.db.patch(row._id, { active: false, syncedAt: a.now });
      }
    }

    await writeAudit(ctx, {
      canvasId: a.canvasId,
      action: AUDIT_ACTIONS.MOD_SYNC,
      actorUserId: a.actorUserId,
      cellsAffected: 0,
      detail: `twitch sync: ${toUpsert.length} active, ${toDeactivate.length} removed`,
      now: a.now,
    });

    return { active: toUpsert.length, deactivated: toDeactivate.length };
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
    const { broadcasterId } = await ctx.runQuery(internal.moderation.PREAUTH_prepareTwitchSync, {
      canvasId: a.canvasId,
      actorUserId,
    });

    const { accessToken } = await ctx.runAction(internal.auth.PREAUTH_getTwitchAccessToken, {});
    if (!accessToken) throw new ConvexError(ERRORS.TWITCH_TOKEN_UNAVAILABLE);
    const clientId = TWITCH_CLIENT_ID;
    if (!clientId) throw new ConvexError(ERRORS.TWITCH_CLIENT_ID_UNSET);

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
        throw new ConvexError(`${ERRORS.TWITCH_HELIX_FAILED}: ${res.status} ${text}`.trim());
      }
      const body = (await res.json()) as { data?: TwitchModerator[]; pagination?: { cursor?: string } };
      for (const m of body.data ?? []) {
        mods.push({ twitchId: m.user_id, login: m.user_login, displayName: m.user_name });
      }
      cursor = body.pagination?.cursor;
      if (!cursor) break;
    }

    return ctx.runMutation(internal.moderation.PREAUTH_applyTwitchSync, {
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

/**
 * Whether a user is banned on a canvas — gateway placement gate.
 * Internal: the gateway queries this via Convex internal API; it is NOT a
 * public surface (no anonymous call surface). Keep as `internalQuery` so it
 * remains callable by the gateway worker but not from the browser.
 */
export const isBanned = internalQuery({
  args: { canvasId: v.id("canvases"), userId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, a) => isUserBanned(ctx, a.canvasId, a.userId),
});

/**
 * S8.1 / S8.2 — whether the CURRENT viewer may moderate this canvas, as a
 * non-throwing boolean the pixel-click moderation panel gates on (anonymous ⇒
 * false, never an error). Same authority as `assertCanModerate`: the owner, or an
 * `active` row in `canvasModerators` (owner-granted `manual` mods AND Twitch
 * channel mods synced by `syncTwitchMods`, S8.1). NOTE: the Twitch sync is not
 * yet auto-triggered, so until it runs only the owner + manual mods resolve here
 * (tracked as the S8.1 sub-gap).
 */
export const canModerate = query({
  args: { canvasId: v.id("canvases") },
  returns: v.boolean(),
  handler: async (ctx, a) => {
    const userId = await optionalUserId(ctx);
    if (!userId) return false;
    const { authorized } = await resolveModAuthority(ctx, a.canvasId, userId);
    return authorized;
  },
});

/**
 * True SSI le viewer courant est l'owner STRICT du canvas (non-throwing).
 * Distinct de `canModerate` (qui inclut les mods) — garde AC3.6 studio.
 * R1 : ne jamais utiliser `canModerate` ni `canvasModerators` ici.
 */
export const amOwner = query({
  args: { canvasId: v.id("canvases") },
  returns: v.boolean(),
  handler: async (ctx, a) => {
    const userId = await optionalUserId(ctx);
    if (!userId) return false;
    const canvas = await ctx.db.get(a.canvasId);
    return !!canvas && canvas.ownerId === userId;
  },
});

/**
 * Active bans on a canvas (owner/mod dashboard).
 * Ops seam (D6): ban list UI not yet built — kept for DevOps/mod tooling; do not remove.
 */
export const listBans = query({
  args: { canvasId: v.id("canvases") },
  returns: v.array(v.object({
    _id: v.id("bans"),
    _creationTime: v.number(),
    canvasId: v.id("canvases"),
    userId: v.string(),
    bannedBy: v.string(),
    reason: v.optional(v.string()),
    active: v.boolean(),
    createdAt: v.number(),
    liftedAt: v.optional(v.number()),
    liftedBy: v.optional(v.string()),
  })),
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
    const mods = await ctx.db
      .query("canvasModerators")
      .withIndex("by_canvas_active", (q) => q.eq("canvasId", a.canvasId).eq("active", true))
      .collect();
    return Promise.all(
      mods.map(async (mod) => {
        const profile = await ctx.db
          .query("profiles")
          .withIndex("by_twitchId", (q) => q.eq("twitchId", mod.twitchId))
          .unique();
        return { ...mod, registeredOnLivePlace: profile !== null };
      }),
    );
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

// ─────────────────────────────────────────────────────────────────────────────
// Crisis "ban an author" surface (FEN-159, backs FEN-157 §2 + §4).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FEN-159 — resolve the current visible author at a cell so the crisis ban flow
 * can turn a pointed-at pixel into a `banAndWipe({ canvasId, targetUserId })`.
 * Reads only the top-of-stack placement via `placements.by_canvas_cell` (highest
 * `version`, single indexed row — no whole-canvas scan), then `authorOfTop`
 * applies the ban-target rules: `null` for an empty / currently-erased / anonymous
 * top, otherwise `{ userId, displayName? }` (display name joined from `profiles`).
 * Mod-authorised via `assertCanModerate` (owner / active mod only). Note the
 * report reflects the durable log; a not-yet-flushed live placement can lag, but
 * `banAndWipe` force-flushes before it acts, so the eventual wipe stays correct.
 */
export const authorAt = query({
  args: { canvasId: v.id("canvases"), x: v.number(), y: v.number() },
  returns: v.union(
    v.object({ userId: v.string(), displayName: v.optional(v.string()) }),
    v.null(),
  ),
  handler: async (ctx, a) => {
    const actorUserId = await requireUserId(ctx);
    await assertCanModerate(ctx, a.canvasId, actorUserId);
    const top = await ctx.db
      .query("placements")
      .withIndex("by_canvas_cell", (q) =>
        q.eq("canvasId", a.canvasId).eq("x", a.x).eq("y", a.y),
      )
      .order("desc")
      .first();
    const author = authorOfTop(top);
    if (!author) return null;
    const profile = await getProfileByAuthUserId(ctx.db, author.userId);
    return { userId: author.userId, displayName: profile?.displayName };
  },
});

/**
 * FEN-159 (nice-to-have, FEN-157 §4) — ban blast-radius preview: how many of
 * `targetUserId`'s pixels `banAndWipe` would remove, computed by `planWipe` over
 * the durable log with NO mutation, so the confirm can show "N pixels will be
 * removed". This is an estimate against the last-flushed `placements` log (no
 * forced flush — preview must stay side-effect-free); the actual `banAndWipe`
 * flushes first, so the committed count may differ slightly. Mod-authorised.
 */
export const banBlastRadius = query({
  args: { canvasId: v.id("canvases"), targetUserId: v.string() },
  returns: v.object({ pixels: v.number() }),
  handler: async (ctx, a) => {
    const actorUserId = await requireUserId(ctx);
    await assertCanModerate(ctx, a.canvasId, actorUserId);
    const plans = planWipe(await loadPlacements(ctx, a.canvasId), a.targetUserId);
    return { pixels: plans.length };
  },
});

