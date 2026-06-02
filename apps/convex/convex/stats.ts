/**
 * UI-oriented read queries over the frozen aggregate tables (FEN-30).
 *
 * These are durable-mirror reads, NOT on the hot path: the live canvas state and
 * token bucket live in Redis; Convex is the durable source of truth the UI reads
 * for leaderboards, profiles and the gallery. Writes to `userCanvasStats` are
 * owned elsewhere (points accrual: `points.ts`; the persistence worker, FEN-17) —
 * this file only reads.
 *
 * Per the FEN-30 architecture note these queries live here, NOT in `canvases.ts`
 * (the frozen durable-write API). Business rules / projection live in the pure,
 * unit-tested `./lib/leaderboard.ts`; the handler below is a thin I/O wrapper.
 *
 * Scope landed here: the **leaderboard** query, which is fully served by the
 * frozen schema (`userCanvasStats.by_canvas_points` + `profiles.by_authUserId`).
 * The **profile** (`profiles.getPublicProfile`) and **gallery (thumbnails)**
 * queries need frozen-schema additions (`profiles.by_login` index; the
 * `thumbnails` table) owned by the Founding Engineer (FEN-29) — see that ticket.
 */
import { query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { clampLeaderboardLimit, rankLeaderboard } from "./lib/leaderboard";

/** Public leaderboard entry validator (mirror of `LeaderboardEntry`). */
const leaderboardEntry = v.object({
  rank: v.number(),
  login: v.string(),
  displayName: v.string(),
  avatarUrl: v.union(v.string(), v.null()),
  points: v.number(),
  pixelsPlaced: v.number(),
});

/**
 * Top-N players on a canvas, ranked by `points` (the F10 score), most first.
 *
 * Anonymous-safe: no auth required and only public fields are surfaced (allow-list
 * projection, CA2). The page size is clamped to a hard ceiling so a garbage/huge
 * `limit` can never scan the table, and the profile join is bounded by that same
 * `take` (at most `limit` point lookups → no unbounded N+1).
 */
export const leaderboard = query({
  args: {
    canvasId: v.id("canvases"),
    limit: v.optional(v.number()),
  },
  returns: v.array(leaderboardEntry),
  handler: async (ctx, { canvasId, limit }) => {
    const take = clampLeaderboardLimit(limit);

    // `by_canvas_points` = [canvasId, points]; eq(canvasId) + order desc ranks by
    // points within the canvas. `take` bounds the read to one page.
    const rows: Doc<"userCanvasStats">[] = await ctx.db
      .query("userCanvasStats")
      .withIndex("by_canvas_points", (q) => q.eq("canvasId", canvasId))
      .order("desc")
      .take(take);

    // Join each ranked row to its public profile (bounded by `take`). `userId`
    // here is the Better Auth user id; the `profiles` mirror keys it as
    // `authUserId` (§6.1: same value).
    const profilePairs = await Promise.all(
      rows.map(async (row) => {
        const profile = await ctx.db
          .query("profiles")
          .withIndex("by_authUserId", (q) => q.eq("authUserId", row.userId))
          .unique();
        return [row.userId, profile] as const;
      }),
    );
    const profileByUserId = new Map(profilePairs);

    return rankLeaderboard(
      rows.map((r) => ({ userId: r.userId, points: r.points, pixelsPlaced: r.pixelsPlaced })),
      (userId) => profileByUserId.get(userId) ?? null,
    );
  },
});
