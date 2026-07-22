/**
 * Pure reduction of a flushed placement batch into per-user placement counts
 * (FEN-17 / FEN-47, ADR-0001). Kept free of Convex/_generated imports so the
 * exactly-once counting contract is unit-testable without a live backend (mirrors
 * the worker's stream assembly). The DB upsert in `worker:applyFlush` stays a thin
 * shell over this + the shared CA1 accrual (`accruePlacementPoints`).
 *
 * Idempotency contract: the caller MUST pass only the placements it actually
 * inserted this transaction (dup-skipped redeliveries excluded), so the returned
 * counts feed `userCanvasStats` (points / pixelsPlaced) exactly once under the
 * at-least-once flush stream (R2).
 */

/** Minimal placement shape needed to attribute a count to a user. */
export interface PlacementLite {
  userId?: string;
  /** Other placement fields (x/y/color/version/ts) are irrelevant to the count. */
  [key: string]: unknown;
}

/** One user's freshly-inserted placement count in a flush batch (always >= 1). */
export interface UserPlacementCount {
  userId: string;
  count: number;
}

/**
 * Reduce newly-inserted placements into one count per identified user.
 *
 * Anonymous placements (no `userId` / empty string) are ignored — they have no
 * profile/leaderboard identity and earn no points (CA1). Order is the first-seen
 * order of each user in the batch (deterministic for tests).
 */
export function aggregatePlacementCounts(
  placements: readonly PlacementLite[],
): UserPlacementCount[] {
  const byUser = new Map<string, UserPlacementCount>();
  for (const p of placements) {
    if (p.userId === undefined || p.userId === "") continue;
    const existing = byUser.get(p.userId);
    if (existing) existing.count += 1;
    else byUser.set(p.userId, { userId: p.userId, count: 1 });
  }
  return [...byUser.values()];
}

/**
 * Change in distinct occupied cell count for a single cell transition.
 *   empty→filled  (prevColor=0, color>0) → +1
 *   filled→empty  (prevColor>0, color=0) → −1
 *   filled→filled (prevColor>0, color>0) →  0  (repaint)
 *   empty→empty   (prevColor=0, color=0) →  0  (noop)
 *
 * Used by `applyFlush` for incremental tracking and extractable for tests.
 */
export function cellCountDelta(prevColor: number, color: number): number {
  if (prevColor === 0 && color > 0) return 1;
  if (prevColor > 0 && color === 0) return -1;
  return 0;
}

