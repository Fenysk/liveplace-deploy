/**
 * Public profile read query behind the `/u/{login}` page (F11 / FEN-22, FEN-30).
 *
 * Durable-mirror read, NOT on the hot path: the live state lives in Redis; Convex
 * is the durable source of truth the UI reads. Writes to `profiles` (auth sync,
 * FEN-11) and `userCanvasStats` (points accrual `points.ts`; persistence worker
 * FEN-17) are owned elsewhere — this file only reads.
 *
 * Thin I/O wrapper over the pure, unit-tested `./lib/publicProfile.ts`; the
 * allow-list projection there is the CA2 boundary (no email/tokens/internal ids).
 * Contract: docs/contracts/profile-read.md. Lineage/schema reconciliation that
 * unblocked this query in project-primary: docs/adr/0001-repo-lineage-reconciliation.md
 * (FEN-37).
 *
 * Field-naming note (lineage reconciliation): the canonical project-primary
 * `profiles` row keys the Better Auth user id as `authUserId`, while the frozen
 * read-model's `ProfileRow`/`StatRow` use `userId` (== the same value, §6.1). The
 * mapping below adapts the row to the read-model — the schema column name stays
 * `authUserId` per the committed F2/F11 schema.
 */
import { query } from "./_generated/server";
import { v } from "convex/values";
import { buildPublicProfile } from "./lib/publicProfile";

/**
 * Build the public profile for a Twitch `login`, or `null` if no such player
 * (the page renders not-found).
 *
 * Anonymous-safe: no auth required and only allow-listed public fields are ever
 * surfaced (CA2). `login` is matched case-insensitively against the lowercased
 * `by_login` index. The per-canvas join is bounded by the player's joined
 * canvases (one `get` per distinct canvas, memoised) — no unbounded N+1.
 */
export const getPublicProfile = query({
  args: { login: v.string() },
  handler: async (ctx, { login }) => {
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_login", (q) => q.eq("login", login.trim().toLowerCase()))
      .unique();
    if (!profile) return null; // page renders not-found

    const stats = await ctx.db
      .query("userCanvasStats")
      .withIndex("by_user", (q) => q.eq("userId", profile.authUserId))
      .collect();

    // Memoise canvas metadata so repeated canvasIds resolve once.
    const canvasCache = new Map<
      string,
      { _id: string; slug: string; title: string } | null
    >();
    for (const s of stats) {
      const id = s.canvasId as unknown as string;
      if (!canvasCache.has(id)) {
        const c = await ctx.db.get(s.canvasId);
        canvasCache.set(
          id,
          c ? { _id: id, slug: c.slug, title: c.title } : null,
        );
      }
    }

    return buildPublicProfile({
      // Adapt the canonical `authUserId` column to the read-model's `userId`.
      profile: {
        userId: profile.authUserId,
        login: profile.login,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl ?? null,
        createdAt: profile.createdAt,
      },
      stats: stats.map((s) => ({
        canvasId: s.canvasId as unknown as string,
        pixelsPlaced: s.pixelsPlaced,
        points: s.points,
        lastPlacedAt: s.lastPlacedAt,
      })),
      canvasOf: (id) => canvasCache.get(id) ?? null,
    });
  },
});
