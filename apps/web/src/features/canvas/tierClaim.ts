/**
 * Tier-claim controller — the "claim de palier" progression model (Lot D,
 * [FEN-116]). It is the client half of the board-locked **single-currency**
 * progression: the viewer ever sees only their gauge (réserve); playing accrues
 * an invisible score (`pointsEarned`) server-side which crosses **tiers**, and
 * each crossed tier becomes a **claim to encash** — never auto-applied. The
 * viewer encashes a tier with an explicit, celebrated gesture ("Réserve +1 !
 * [Agrandir]") which permanently raises the gauge max by 1 (and, by board
 * default, grants 1 immediately-usable charge).
 *
 * Why a standalone controller (no React, no canvas): the claim state machine —
 * stacking, deferral, optimistic application, idempotent reconnect replay — is
 * the genuine content of this lot and is testable in isolation. The UI
 * (CanvasView) renders `pending`/celebration and routes the gesture; the data
 * source (Convex `getMyTierProgress` / `claimTier`, ported by Dev Backend, see
 * docs/contracts/tier-claim.md) feeds `sync()` and applies the emitted ops.
 *
 * ── Model (board decision, FEN-83 ux-spec §V2.2) ──────────────────────────────
 * Two monotonic server counters drive everything:
 *   - `earned`    : tiers unlocked by playing (derived from `pointsEarned`
 *                   thresholds, server-side). Only ever grows.
 *   - `confirmed` : tiers already applied to the gauge max (== `gaugeMaxBonus`).
 *                   Only ever grows; always ≤ `earned`.
 * The client keeps a `cursor` ∈ [confirmed, earned] = how many tiers it has
 * **optimistically claimed**. Derived quantities:
 *   - `pending`        = earned − cursor   → claims available to encash (stackable).
 *   - `optimisticBonus` = cursor − confirmed → claimed-but-not-yet-confirmed; the
 *                         local overlay added to the server gauge max/charges so
 *                         the réserve grows the instant the gesture fires.
 *
 * ── Idempotency by tier index (offline / reconnect) ──────────────────────────
 * A claim op carries its 1-based `tierIndex`. The server mutation applies a given
 * index **at most once** (idempotent key = (canvas, user, tierIndex)). So an
 * un-confirmed claim re-sent after a reconnect (via {@link resendUnconfirmed})
 * with the SAME index applies exactly once — no tier is ever double-counted, and
 * none is lost on a blip. `sync()` folds server confirmation back in by advancing
 * `confirmed`, shrinking `optimisticBonus` continuously (the gauge frame that
 * carries the new max lands at the same time, so the displayed max never jumps).
 */

/** A snapshot of the viewer's tier progression on a canvas (from the server). */
export interface TierProgress {
  /** Tiers unlocked by playing (monotonic). Derived from `pointsEarned`. */
  earned: number;
  /** Tiers already applied to the gauge max (== `gaugeMaxBonus`, monotonic). */
  confirmed: number;
}

/** A single claim to send to the server. Idempotent by `tierIndex` (1-based). */
export interface ClaimOp {
  /** 1-based index of the tier being encashed; the server applies it once. */
  tierIndex: number;
}

export class TierClaim {
  /** Tiers unlocked by playing (server, monotonic). */
  private earned = 0;
  /** Tiers applied to the gauge max (server, monotonic). */
  private confirmed = 0;
  /** Optimistically-claimed count, ∈ [confirmed, earned]. */
  private cursor = 0;

  constructor(initial?: TierProgress) {
    if (initial) this.sync(initial);
  }

  /**
   * Ingest a fresh server snapshot. Both counters are monotonic, so we clamp
   * defensively (a stale/out-of-order frame can never roll progress back). The
   * cursor is re-seated into [confirmed, earned]:
   *   - never below `confirmed` — the server has applied that many, so they are
   *     no longer "claimable" (covers a claim confirmed here, or one made on
   *     another device);
   *   - never above `earned` — can't have optimistically claimed a tier not yet
   *     unlocked.
   */
  sync(p: TierProgress): void {
    this.earned = Math.max(this.earned, Math.max(0, Math.floor(p.earned)));
    this.confirmed = Math.max(this.confirmed, Math.max(0, Math.floor(p.confirmed)));
    if (this.confirmed > this.earned) this.earned = this.confirmed; // server invariant guard
    this.cursor = Math.min(Math.max(this.cursor, this.confirmed), this.earned);
  }

  /** Claims available to encash right now (stacked). 0 when nothing is pending. */
  get pending(): number {
    return this.earned - this.cursor;
  }

  /** True when at least one tier can be encashed. */
  get claimable(): boolean {
    return this.pending > 0;
  }

  /** Claimed-but-unconfirmed tiers — the local overlay on the server max/charges. */
  get optimisticBonus(): number {
    return this.cursor - this.confirmed;
  }

  /**
   * Encash the next pending tier. Advances the cursor by one and returns the op
   * to send to the server (or `null` when nothing is pending — claims are NEVER
   * applied automatically, this is only ever called from the user's gesture).
   */
  claimNext(): ClaimOp | null {
    if (this.pending <= 0) return null;
    this.cursor += 1;
    return { tierIndex: this.cursor };
  }

  /**
   * Encash every pending tier at once ("tout encaisser"). Returns one op per
   * tier in ascending index order ([] when nothing is pending).
   */
  claimAll(): ClaimOp[] {
    const ops: ClaimOp[] = [];
    let op: ClaimOp | null;
    while ((op = this.claimNext())) ops.push(op);
    return ops;
  }

  /**
   * Ops for every optimistically-claimed-but-unconfirmed tier, to replay after a
   * reconnect. Re-sends the SAME indices (confirmed, cursor] — the server applies
   * each at most once, so this is safe to call repeatedly.
   */
  resendUnconfirmed(): ClaimOp[] {
    const ops: ClaimOp[] = [];
    for (let i = this.confirmed + 1; i <= this.cursor; i++) ops.push({ tierIndex: i });
    return ops;
  }

  /** Server gauge max plus the optimistic overlay (so the réserve grows on claim). */
  effectiveMax(serverMax: number): number {
    return serverMax + this.optimisticBonus;
  }

  /**
   * Server charges plus the optimistic overlay. Board default: a claim grants 1
   * immediately-usable charge so the celebration is actionable even mid-cooldown
   * (ux-spec §V2.2). The overlay is reconciled away exactly when the matching
   * gauge frame (carrying the server-granted charge) lands alongside `confirmed`.
   */
  effectiveCharges(serverCharges: number): number {
    return serverCharges + this.optimisticBonus;
  }
}

/**
 * The progression data source the UI subscribes to and routes claims through.
 * Decoupled from any backend so CanvasView never imports Convex directly: the
 * live adapter (Convex `getMyTierProgress` subscription + `claimTier` mutation)
 * is wired by Dev Backend / Dev Full-stack once the server reframe lands
 * (docs/contracts/tier-claim.md, [FEN-116] backend child). Tests and the visual
 * capture script implement it over a scripted in-memory feed.
 */
export interface TierSource {
  /** Subscribe to server progression snapshots. Returns an unsubscribe fn. */
  subscribe(onProgress: (p: TierProgress) => void): () => void;
  /** Apply one encashed tier server-side. Idempotent by `op.tierIndex`. */
  claim(op: ClaimOp): void | Promise<void>;
}

/**
 * Inert source: no progression, claims are no-ops. The default until the backend
 * reframe is wired — the claim UI simply never appears, degrading gracefully.
 */
export const inertTierSource: TierSource = {
  subscribe() {
    return () => {};
  },
  claim() {},
};
