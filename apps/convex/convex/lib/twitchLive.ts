/**
 * Pure helpers for the Twitch live-status refresh (FEN-1868 / S1).
 *
 * Framework-free so the transition logic can be unit-tested without a Convex
 * runtime. The Convex action/mutation layer (twitchLive.ts) wraps these.
 */

/** Current persisted state for one twitchId row (subset of streamStatus). */
export interface StreamStatusState {
  isLive: boolean;
  startedAt?: number;
}

/**
 * The patch to apply when a transition occurs.
 * `null` means no write needed (same state — transition-only invariant).
 */
export interface StreamStatusPatch {
  isLive: boolean;
  startedAt?: number;
  updatedAt: number;
}

/**
 * Compute the patch for a single twitchId. Returns `null` when the persisted
 * state already matches `isLive` (no transition → no write).
 *
 * Rules:
 * - New row (`existing === null`): always write.
 * - Transition (isLive flips): write with new `updatedAt`.
 * - Same state: return `null` (no write — transition-only invariant).
 * - `startedAt` is set when going live, omitted when going offline.
 */
export function planStatusPatch(
  existing: StreamStatusState | null,
  isLive: boolean,
  startedAt: number | undefined,
  now: number,
): StreamStatusPatch | null {
  if (existing !== null && existing.isLive === isLive) return null;
  const patch: StreamStatusPatch = { isLive, updatedAt: now };
  if (isLive && startedAt !== undefined) patch.startedAt = startedAt;
  return patch;
}
