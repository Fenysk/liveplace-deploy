/**
 * Live `TierSource` bridge (Lot D / FEN-142) — the PURE (React-free, Convex-free)
 * half of the Convex-backed "claim de palier" wiring. It binds the inert seam
 * from {@link TierClaim} / `tierClaim.ts` (FEN-116) to the landed server contract
 * (FEN-130, docs/contracts/tier-claim.md), but owns none of the Convex hooks — the
 * React container ({@link CanvasViewLive}) pumps `getMyTierProgress` snapshots in
 * via {@link LiveTierSource.push} and supplies the bound `claimTier` action.
 *
 * Kept dependency-free on purpose so the subscriber fan-out, the latest-snapshot
 * replay, and the `ClaimOp → action args` mapping are unit-testable without a
 * renderer (see liveTierSource.test.ts).
 */
import type { ClaimOp, TierProgress, TierSource } from "./tierClaim.js";

/** The Convex `points.claimTier` action signature, once bound by the client. */
export type ClaimTierFn = (args: {
  canvasId: string;
  tierIndex: number;
}) => Promise<{ gaugeMaxBonus: number }>;

/** A {@link TierSource} fed by pushed Convex snapshots (the React container pumps them in). */
export interface LiveTierSource extends TierSource {
  /** Forward a fresh server snapshot, or `undefined`/`null` while the query is loading/skipped. */
  push(progress: TierProgress | undefined | null): void;
}

export interface LiveTierSourceDeps {
  /**
   * Resolve the current Convex canvas id, or `null` until auth + canvas resolve.
   * Read lazily on every `claim` so a late-arriving id (auth completes after mount)
   * is honoured without rebuilding the source.
   */
  getCanvasId: () => string | null;
  /** The bound Convex `points.claimTier` action. */
  claimTier: ClaimTierFn;
  /** Error sink for a failed claim dispatch (defaults to `console.warn`). */
  onError?: (err: unknown) => void;
}

/**
 * Pure live-source bridge: subscriber fan-out + idempotent claim mapping, with no
 * React dependency. Snapshots arrive via {@link LiveTierSource.push}; the latest
 * is cached and replayed to any late subscriber so a subscription that attaches
 * after the first Convex tick still seats the controller immediately.
 */
export function createLiveTierSource(deps: LiveTierSourceDeps): LiveTierSource {
  const subscribers = new Set<(p: TierProgress) => void>();
  let latest: TierProgress | null = null;
  const onError =
    deps.onError ??
    ((err: unknown) =>
      console.warn(`[tier] claim dispatch failed: ${(err as Error)?.message ?? String(err)}`));

  return {
    push(progress) {
      if (!progress) return; // loading / "skip" / auth-gated: nothing to fold yet.
      // Forward verbatim; TierClaim.sync owns the monotonic clamping + invariants.
      latest = { earned: progress.earned, confirmed: progress.confirmed };
      for (const cb of subscribers) cb(latest);
    },
    subscribe(onProgress) {
      subscribers.add(onProgress);
      if (latest) onProgress(latest); // replay last snapshot to a late subscriber.
      return () => {
        subscribers.delete(onProgress);
      };
    },
    claim(op: ClaimOp) {
      const canvasId = deps.getCanvasId();
      if (canvasId == null) return; // no real canvas yet → graceful no-op (degrades like inert).
      // Idempotent by index: a transient failure (or a reconnect replay of the same
      // index) is safe — the server applies each tier at most once — so we only log.
      return deps.claimTier({ canvasId, tierIndex: op.tierIndex }).then(
        () => {},
        (err) => onError(err),
      );
    },
  };
}
