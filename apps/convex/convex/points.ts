/**
 * Points & gauge-max upgrade (F6 / FEN-18).
 *
 * `points` is a cumulative progression score, scoped per (user, canvas) and
 * distinct from the gauge. Its only MVP sink is `purchaseGaugeUpgrade`: spend
 * points to permanently raise the player's max gauge on a canvas.
 *
 * Layering: Convex is the durable source of truth for points and the gauge-max
 * bonus. The Redis hot path stays authoritative for the live token bucket; the
 * gateway applies the bonus by passing `effectiveGaugeMax = baseGaugeMax +
 * gaugeMaxBonus` as the script's `maxCharges` — it reads the bonus via
 * `getGaugeBonus` (no Convex→Redis write; see
 * docs/contracts/points-gauge-upgrade.md and the gateway-integration child issue).
 *
 * Pure rules (cost curve, cap, accrual) live in ./lib/pointsRules.ts and are
 * unit-tested there; the functions below are thin transactional I/O wrappers.
 */
import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireUserId } from "./lib/auth";
import {
  DEFAULT_POINTS_CONFIG,
  evaluatePurchase,
  pointsForPlacements,
  PointsRuleError,
} from "./lib/pointsRules";

/** Zeroed view of a user's stats on a canvas (used before the first placement). */
const ZERO_STATS = {
  points: 0,
  pointsEarned: 0,
  pixelsPlaced: 0,
  gaugeMaxBonus: 0,
  bestRank: null as number | null,
  lastPlacedAt: null as number | null,
};

const statsView = v.object({
  canvasId: v.id("canvases"),
  userId: v.string(),
  points: v.number(),
  pointsEarned: v.number(),
  pixelsPlaced: v.number(),
  gaugeMaxBonus: v.number(),
  bestRank: v.union(v.number(), v.null()),
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
    bestRank: row?.bestRank ?? null,
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

/** The signed-in user's stats on a canvas (zeros if they have never placed). */
export const getMyCanvasStats = query({
  args: { canvasId: v.id("canvases") },
  returns: statsView,
  handler: async (ctx, { canvasId }) => {
    const userId = await requireUserId(ctx);
    const row = await ctx.db
      .query("userCanvasStats")
      .withIndex("by_canvas_user", (q) => q.eq("canvasId", canvasId).eq("userId", userId))
      .unique();
    return toView(canvasId, userId, row);
  },
});

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
 * Award points for `count` colored placements by a user on a canvas (CA1:
 * +1 point / colored placement by default). Internal: invoked once per drained
 * Redis batch by the persistence worker, which owns at-least-once dedup at the
 * stream level (flushState). Upserts the (user, canvas) row.
 */
export const awardPlacementPoints = internalMutation({
  args: {
    canvasId: v.id("canvases"),
    userId: v.string(),
    count: v.number(),
    now: v.number(),
  },
  returns: v.object({ points: v.number(), pointsEarned: v.number(), pixelsPlaced: v.number() }),
  handler: async (ctx, { canvasId, userId, count, now }) => {
    if (!Number.isInteger(count) || count <= 0) {
      throw new PointsRuleError("invalid_config", `count must be a positive integer; got ${count}.`);
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
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Spend (CA2/CA3/CA4) — the only MVP sink.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Buy one permanent +1 to the signed-in user's max gauge on a canvas.
 *
 * Transactional: the whole read-decide-write runs in one Convex mutation, so a
 * rejected purchase never debits (CA4) and concurrent purchases serialize (no
 * double-spend). The n-th upgrade costs `baseUpgradeCost × n` (CA3) and is
 * refused at `gaugeMaxBonusCap` (CA3).
 *
 * After success the caller must refresh the gateway so the new effective max
 * reaches Redis (see getGaugeBonus / the contract doc).
 */
export const purchaseGaugeUpgrade = mutation({
  args: { canvasId: v.id("canvases") },
  returns: v.object({
    gaugeMaxBonus: v.number(),
    points: v.number(),
    cost: v.number(),
  }),
  handler: async (ctx, { canvasId }) => {
    const userId = await requireUserId(ctx);

    const canvas = await ctx.db.get(canvasId);
    if (!canvas) throw new Error("canvas_not_found: unknown canvas.");

    const row = await findStats(ctx, canvasId, userId);
    const current = row
      ? { points: row.points, gaugeMaxBonus: row.gaugeMaxBonus }
      : { points: 0, gaugeMaxBonus: 0 };

    const decision = evaluatePurchase(current, DEFAULT_POINTS_CONFIG);
    if (!decision.ok) {
      // No write happens — the row is left exactly as it was (CA4 / CA3).
      throw new PointsRuleError(
        decision.reason!,
        decision.reason === "cap_reached"
          ? `Gauge max bonus is already at the cap (${DEFAULT_POINTS_CONFIG.gaugeMaxBonusCap}).`
          : `Not enough points: need ${decision.cost}, have ${current.points}.`,
      );
    }

    const now = Date.now();
    if (row) {
      await ctx.db.patch(row._id, {
        points: decision.newPoints,
        gaugeMaxBonus: decision.newBonus,
        updatedAt: now,
      });
    } else {
      // First interaction is a purchase only when points were granted out-of-band;
      // with a zero balance evaluatePurchase already rejected above.
      await ctx.db.insert("userCanvasStats", {
        userId,
        canvasId,
        points: decision.newPoints,
        pointsEarned: 0,
        pixelsPlaced: 0,
        gaugeMaxBonus: decision.newBonus,
        updatedAt: now,
      });
    }

    return { gaugeMaxBonus: decision.newBonus, points: decision.newPoints, cost: decision.cost };
  },
});
