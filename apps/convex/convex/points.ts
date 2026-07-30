/**
 * Points, gauge-max bonus & tier claim (F6 / FEN-18 → reframed for Lot D / FEN-130).
 *
 * `pointsEarned` is a cumulative, never-decremented progression score scoped per
 * (user, canvas), distinct from the gauge — it is the leaderboard signal and the
 * source of the tier curve. `points` (spendable) is no longer a viewer-facing
 * sink: the board-locked model (Alexis, 2026-06-03, FEN-83 ux-spec §V2.2) shows
 * the viewer ONLY their gauge — no points, no shop. The old `purchaseGaugeUpgrade`
 * SPEND sink is replaced by a **claim de palier**: crossing a `pointsEarned` tier
 * threshold makes a +1-max claim available, which the viewer encashes with an
 * explicit gesture (no debit). Contract: docs/contracts/tier-claim.md.
 *
 * Layering: Convex is the durable source of truth for the gauge-max bonus. The
 * Redis hot path stays authoritative for the live token bucket; the gateway
 * applies the bonus by passing `effectiveGaugeMax = baseGaugeMax + gaugeMaxBonus`
 * as the script's `maxCharges`, reading it via `getGaugeBonus` (no Convex→Redis
 * write). The tier claim additionally asks the gateway over `/internal/gauge/claim`
 * to hand the viewer the board-default +1 usable charge and push a `gauge` frame,
 * so the celebration is actionable mid-cooldown.
 *
 * Pure rules (tier curve, cap, accrual) live in ./lib/pointsRules.ts and are
 * unit-tested there; the functions below are thin transactional I/O wrappers.
 */
import { query, internalMutation, action } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { ERRORS } from "./errors";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUserId } from "./lib/identity";
import { gatewayPost } from "./lib/gateway";
import {
  DEFAULT_POINTS_CONFIG,
  evaluateTierClaim,
  tiersEarned,
  pointsForPlacements,
} from "./lib/pointsRules";

/** Zeroed view of a user's stats on a canvas (used before the first placement). */
const ZERO_STATS = {
  points: 0,
  pointsEarned: 0,
  pixelsPlaced: 0,
  gaugeMaxBonus: 0,
  lastPlacedAt: null as number | null,
};

const statsView = v.object({
  canvasId: v.id("canvases"),
  userId: v.string(),
  points: v.number(),
  pointsEarned: v.number(),
  pixelsPlaced: v.number(),
  gaugeMaxBonus: v.number(),
  lastPlacedAt: v.union(v.number(), v.null()),
});

function toView(canvasId: Id<"canvases">, userId: string, row: Doc<"userCanvasStats"> | null) {
  const s = row ?? ZERO_STATS;
  return {
    canvasId,
    userId,
    points: s.points,
    pointsEarned: s.pointsEarned,
    pixelsPlaced: s.pixelsPlaced,
    gaugeMaxBonus: s.gaugeMaxBonus,
    lastPlacedAt: row?.lastPlacedAt ?? null,
  };
}

async function findStats(
  ctx: MutationCtx,
  canvasId: Id<"canvases">,
  userId: string,
): Promise<Doc<"userCanvasStats"> | null> {
  return ctx.db
    .query("userCanvasStats")
    .withIndex("by_canvas_user", (q) => q.eq("canvasId", canvasId).eq("userId", userId))
    .unique();
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gateway-pull contract: the purchased gauge-max bonus for a (user, canvas).
 * The gateway adds this to the canvas base max to get the effective `maxCharges`
 * it passes to the place-pixel script. Returns 0 when the user has no row.
 */
export const getGaugeBonus = query({
  args: { canvasId: v.id("canvases"), userId: v.string() },
  returns: v.object({ gaugeMaxBonus: v.number() }),
  handler: async (ctx, { canvasId, userId }) => {
    const row = await ctx.db
      .query("userCanvasStats")
      .withIndex("by_canvas_user", (q) => q.eq("canvasId", canvasId).eq("userId", userId))
      .unique();
    return { gaugeMaxBonus: row?.gaugeMaxBonus ?? 0 };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Accrual (CA1) — called by the persistence worker (FEN-17).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shared CA1 accrual: award `count` colored placements by a user on a canvas
 * (+1 point / placement by default) and bump `pixelsPlaced` / `lastPlacedAt`,
 * upserting the (user, canvas) row. Single-sourced here so the internal
 * `awardPlacementPoints` entry and the persistence worker's batch flush
 * (`worker:applyFlush`, FEN-47 / ADR-0001) accrue identically.
 *
 * `count` must be a positive integer. The caller owns at-least-once dedup at the
 * stream level (flushState + placements idempotency), so each placement feeds
 * this exactly once (R2). `now` is the flush time, used for `lastPlacedAt`.
 */
export async function accruePlacementPoints(
  ctx: MutationCtx,
  args: { canvasId: Id<"canvases">; userId: string; count: number; now: number },
): Promise<{ points: number; pointsEarned: number; pixelsPlaced: number }> {
  const { canvasId, userId, count, now } = args;
  if (!Number.isInteger(count) || count <= 0) {
    throw new ConvexError(ERRORS.INVALID_CONFIG);
  }
  const earned = pointsForPlacements(count, DEFAULT_POINTS_CONFIG);
  const row = await findStats(ctx, canvasId, userId);
  if (row) {
    const points = row.points + earned;
    const pointsEarned = row.pointsEarned + earned;
    const pixelsPlaced = row.pixelsPlaced + count;
    await ctx.db.patch(row._id, { points, pointsEarned, pixelsPlaced, lastPlacedAt: now, updatedAt: now });
    return { points, pointsEarned, pixelsPlaced };
  }
  await ctx.db.insert("userCanvasStats", {
    userId,
    canvasId,
    points: earned,
    pointsEarned: earned,
    pixelsPlaced: count,
    gaugeMaxBonus: 0,
    lastPlacedAt: now,
    updatedAt: now,
  });
  return { points: earned, pointsEarned: earned, pixelsPlaced: count };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier claim (Lot D / FEN-130) — the board-locked viewer-facing progression.
//
// Replaces the spend sink. Two monotonic counters per (user, canvas) drive the
// client (docs/contracts/tier-claim.md): `earned` (tiers unlocked by playing,
// derived from `pointsEarned`) and `confirmed` (tiers already applied to the
// gauge max = `gaugeMaxBonus`). `claimTier` encashes one earned tier, idempotent
// by index, with NO debit of any spendable balance.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The signed-in viewer's tier progression on a canvas: `earned` (tiers unlocked
 * by playing) and `confirmed` (== `gaugeMaxBonus`, tiers already applied). A live
 * `useQuery` subscription on the client: when a claim confirms, `confirmed` bumps
 * and the client's optimistic overlay folds back (the gateway pushes the matching
 * `gauge` frame at the same time). Both are monotonic; zeros before any play.
 */
export const getMyTierProgress = query({
  args: { canvasId: v.id("canvases") },
  returns: v.object({ earned: v.number(), confirmed: v.number() }),
  handler: async (ctx, { canvasId }) => {
    const userId = await requireUserId(ctx);
    const row = await ctx.db
      .query("userCanvasStats")
      .withIndex("by_canvas_user", (q) => q.eq("canvasId", canvasId).eq("userId", userId))
      .unique();
    const earned = tiersEarned(row?.pointsEarned ?? 0, DEFAULT_POINTS_CONFIG);
    const confirmed = row?.gaugeMaxBonus ?? 0;
    return { earned, confirmed };
  },
});

/**
 * Apply one tier claim transactionally (internal — the `claimTier` action calls
 * it, then dispatches the live-charge grant to the gateway). The whole
 * read-decide-write runs in one Convex mutation, so concurrent claims serialize
 * and the bonus is raised at most once per index:
 *
 *  - `tier_not_earned` (tierIndex > earned) → throw; nothing written.
 *  - already-applied (tierIndex ≤ confirmed) → no-op, returns current bonus,
 *    `applied:false` (idempotent reconnect replay).
 *  - otherwise → `gaugeMaxBonus` advances to `tierIndex`; `granted` = the delta of
 *    charges the gateway should hand out (board default +1/tier). NO `points`
 *    debit; `pointsEarned` is left untouched (leaderboard).
 */
export const PREAUTH_applyTierClaim = internalMutation({
  args: { canvasId: v.id("canvases"), userId: v.string(), tierIndex: v.number() },
  returns: v.object({ gaugeMaxBonus: v.number(), granted: v.number(), applied: v.boolean() }),
  handler: async (ctx, { canvasId, userId, tierIndex }) => {
    const canvas = await ctx.db.get(canvasId);
    if (!canvas) throw new ConvexError(ERRORS.CANVAS_NOT_FOUND);

    const row = await findStats(ctx, canvasId, userId);
    const stats = {
      pointsEarned: row?.pointsEarned ?? 0,
      gaugeMaxBonus: row?.gaugeMaxBonus ?? 0,
    };

    const decision = evaluateTierClaim(stats, tierIndex, DEFAULT_POINTS_CONFIG);
    if (decision.reason) {
      // Hard reject — nothing is written (the row is left exactly as it was).
      throw new ConvexError(decision.reason);
    }
    if (!decision.ok) {
      // No-op: tierIndex ≤ confirmed (already applied). Idempotent replay.
      return { gaugeMaxBonus: stats.gaugeMaxBonus, granted: 0, applied: false };
    }

    const now = Date.now();
    if (row) {
      // Only the bonus moves — no `points` debit, `pointsEarned` untouched (CA: no
      // spendable viewer balance; leaderboard intact).
      await ctx.db.patch(row._id, { gaugeMaxBonus: decision.newBonus, updatedAt: now });
    } else {
      // Unreachable in practice (no row ⇒ pointsEarned 0 ⇒ earned 0 ⇒ rejected
      // above), but materialise defensively so the invariant `confirmed ≤ earned`
      // can never be violated by a row that should exist.
      await ctx.db.insert("userCanvasStats", {
        userId,
        canvasId,
        points: 0,
        pointsEarned: 0,
        pixelsPlaced: 0,
        gaugeMaxBonus: decision.newBonus,
        updatedAt: now,
      });
    }

    return { gaugeMaxBonus: decision.newBonus, granted: decision.granted, applied: true };
  },
});

/**
 * Encash a single earned tier for the signed-in viewer. Idempotent by
 * `(canvas, user, tierIndex)` — a reconnect replaying the same index applies it
 * at most once. On a first application it raises the durable `gaugeMaxBonus` by
 * the tier delta and asks the gateway to hand the viewer the board-default +1
 * usable charge + push a `gauge` frame (so the celebration is actionable
 * mid-cooldown). An action (not a mutation) because the gateway dispatch is an
 * HTTP `fetch`, which only actions may do; the durable write is delegated to the
 * `applyTierClaim` mutation so it stays transactional.
 *
 * The gateway dispatch is BEST-EFFORT (mirrors the moderation seam): if
 * `GATEWAY_INTERNAL_URL` is unset or the gateway is unreachable, the durable
 * bonus is still applied and takes effect on the viewer's next placement /
 * reconnect (the gateway pulls the bonus via `getGaugeBonus`); only the immediate
 * extra charge is skipped.
 */
export const claimTier = action({
  args: { canvasId: v.id("canvases"), tierIndex: v.number() },
  returns: v.object({ gaugeMaxBonus: v.number() }),
  handler: async (ctx, { canvasId, tierIndex }): Promise<{ gaugeMaxBonus: number }> => {
    const userId = await requireUserId(ctx);
    const r = await ctx.runMutation(internal.points.PREAUTH_applyTierClaim, { canvasId, userId, tierIndex });
    if (r.applied && r.granted > 0) {
      await dispatchGaugeClaim(userId, canvasId, r.granted).catch((err) => {
        // Best-effort: the durable bonus is already applied; only the live charge
        // push is lost. Log and return success so the claim is not retried as a
        // failure (which a reconnect replay would no-op anyway).
        console.warn(`[points] gauge claim dispatch failed for ${userId}: ${(err as Error).message}`);
      });
    }
    return { gaugeMaxBonus: r.gaugeMaxBonus };
  },
});

/**
 * POST the live-charge grant to the gateway's `/internal/gauge/claim` seam.
 * Degrades gracefully when `GATEWAY_INTERNAL_URL` is unset (local/anon smoke):
 * `gatewayPost` returns `dispatched:false` and the durable bonus alone is then
 * the whole effect. Shares the POST envelope with moderation via ./lib/gateway.
 */
async function dispatchGaugeClaim(userId: string, canvasId: string, charges: number): Promise<void> {
  // `canvasId` scopes the live-charge grant to the canvas the tier was claimed on
  // (FEN-1616): the gauge is per-(user, canvas), so the gateway must grant on that
  // canvas's bucket, not on every canvas the user has open.
  await gatewayPost("/internal/gauge/claim", { userId, canvasId, charges });
}
