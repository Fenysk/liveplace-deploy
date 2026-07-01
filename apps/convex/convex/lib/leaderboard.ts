/**
 * Leaderboard read-model — the per-canvas ranking behind the F10 leaderboard UI
 * (FEN-30, on top of the frozen `userCanvasStats` aggregate / `by_canvas_points`
 * index). See the durable schema in `apps/convex/convex/schema.ts`.
 *
 * Pure and framework-free (no Convex imports) so it can be unit-tested without a
 * Convex runtime and reused by the query layer and any future SSR path — the same
 * pattern as `lib/publicProfile.ts` and `lib/gallery.ts`.
 *
 * It is also a **CA2-style allow-list boundary**: it receives a stat row plus the
 * player's public profile row and returns ONLY public fields (login, display
 * name, avatar, the two public counters). The Better Auth user id (`userId`),
 * timestamps, gauge bonus and any column added later are never surfaced — the
 * projection is allow-list, not deny-list, so a future private column can't leak.
 *
 * Ranking is by **points** (the F10 score and the `by_canvas_points` index), with
 * `pixelsPlaced` exposed for display. The Convex query already `order("desc")`s
 * on the index, so the caller passes rows already sorted points-descending; this
 * module assigns the human ranks (with tie handling) and projects each row.
 */

/** One `userCanvasStats` aggregate row (the subset the leaderboard reads). */
export interface LeaderboardStatRow {
  userId: string; // Better Auth user id — used to join the profile; NEVER surfaced
  points: number; // F10 score — the ranking key
  pixelsPlaced: number; // lifetime colored placements — displayed alongside
  [key: string]: unknown;
}

/** App-owned public identity mirror (`profiles` table), joined on `userId`. */
export interface LeaderboardProfileRow {
  login: string;
  displayName: string;
  avatarUrl?: string | null;
  [key: string]: unknown;
}

/** Public, render-ready leaderboard entry. No internal ids or private fields. */
export interface LeaderboardEntry {
  /** 1-based rank; ties share a rank (standard competition ranking: 1,2,2,4). */
  rank: number;
  login: string;
  displayName: string;
  avatarUrl: string | null;
  points: number;
  pixelsPlaced: number;
}

/** Leaderboard page size: default and hard ceiling (clamp like flush:getPlacementsSince). */
export const DEFAULT_LEADERBOARD_LIMIT = 20;
export const MAX_LEADERBOARD_LIMIT = 100;

/**
 * Clamp a requested page size to `[1, MAX_LEADERBOARD_LIMIT]`, defaulting when
 * absent or not a finite positive integer. Mirrors the durable-read clamp used by
 * `flush:getPlacementsSince` so an unbounded/garbage `take` can never hit the db.
 */
export function clampLeaderboardLimit(
  requested?: number,
  opts: { def?: number; max?: number } = {},
): number {
  const def = opts.def ?? DEFAULT_LEADERBOARD_LIMIT;
  const max = opts.max ?? MAX_LEADERBOARD_LIMIT;
  if (typeof requested !== "number" || !Number.isFinite(requested)) return def;
  const n = Math.floor(requested);
  if (n < 1) return 1;
  if (n > max) return max;
  return n;
}

/**
 * Allow-list projection of a stat row (+ its joined profile) to a public
 * leaderboard entry. (CA2)
 *
 * `profile` may be `null` when the player's profile has not been synced yet (or
 * was deleted): the entry still ranks, falling back to a stable, non-identifying
 * placeholder rather than dropping a real ranked player from the board.
 */
export function toLeaderboardEntry(
  rank: number,
  row: LeaderboardStatRow,
  profile: LeaderboardProfileRow | null,
): LeaderboardEntry {
  return {
    rank,
    login: profile?.login ?? "—",
    displayName: profile?.displayName ?? "Anonymous",
    avatarUrl: profile?.avatarUrl ?? null,
    points: row.points,
    pixelsPlaced: row.pixelsPlaced,
  };
}

/**
 * Assign standard competition ranks (1, 2, 2, 4) to rows **already sorted
 * points-descending**, projecting each through `toLeaderboardEntry`. Equal
 * `points` share a rank; the next distinct score skips the tied positions.
 *
 * `profileOf` resolves the joined profile for a row's `userId` (or `null`). It is
 * the caller's bounded lookup — the query joins at most `take` rows, so there is
 * no unbounded N+1.
 */
export function rankLeaderboard(
  rows: LeaderboardStatRow[],
  profileOf: (userId: string) => LeaderboardProfileRow | null,
): LeaderboardEntry[] {
  const entries: LeaderboardEntry[] = [];
  let prevPoints: number | null = null;
  let rank = 0;
  rows.forEach((row, i) => {
    // New (lower) score → rank jumps to this 1-based position; a tie keeps the
    // previous rank. Rows must arrive pre-sorted by points desc.
    if (prevPoints === null || row.points !== prevPoints) {
      rank = i + 1;
      prevPoints = row.points;
    }
    entries.push(toLeaderboardEntry(rank, row, profileOf(row.userId)));
  });
  return entries;
}
