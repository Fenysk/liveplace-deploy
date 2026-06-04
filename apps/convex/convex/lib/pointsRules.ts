/**
 * pointsRules — pure business rules for F6 (points & gauge-max upgrade).
 *
 * Like canvasRules, this module has NO Convex imports on purpose: every rule
 * from cahier §F6 + decision D1 is a pure function so it can be unit-tested in
 * isolation (see pointsRules.test.ts) and reused without a Convex runtime.
 *
 * The Convex functions in ../points.ts are thin I/O wrappers that call into
 * these helpers, then read/write the durable `userCanvasStats` table.
 *
 * Spec: FEN-18 / cahier §F6. Defaults: decision D1 (FEN-9).
 *
 * Model
 * -----
 * `points` is a *cumulative progression score, distinct from the gauge*. The
 * only MVP sink is buying permanent +1 increments to a player's max gauge on a
 * given canvas. Score and upgrades are scoped per (user, canvas).
 *
 * Cost curve: the n-th upgrade costs `baseUpgradeCost × n` (the 1st = ×1). The
 * bonus is capped at `gaugeMaxBonusCap`; the effective max a player's gauge can
 * reach is `baseGaugeMax + gaugeMaxBonus`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Defaults — decision D1 (FEN-9). Overridable per canvas later; these are the
// MVP defaults baked in by F6.
// ─────────────────────────────────────────────────────────────────────────────

export interface PointsConfig {
  /** Points awarded per colored placement (CA1). */
  pointsPerPlacement: number;
  /** Base cost; the n-th gauge upgrade costs `baseUpgradeCost × n` (CA3). */
  baseUpgradeCost: number;
  /** Hard cap on the purchasable gauge-max bonus (CA3). */
  gaugeMaxBonusCap: number;
}

export const DEFAULT_POINTS_CONFIG: PointsConfig = {
  pointsPerPlacement: 1, // §F6: +1 point / colored placement
  baseUpgradeCost: 50, // D1 default
  gaugeMaxBonusCap: 30, // D1 default
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared shapes. Mirror the durable `userCanvasStats` row but stay
// dependency-free so the rules run over plain objects in tests and over Convex
// docs in production.
// ─────────────────────────────────────────────────────────────────────────────

/** The subset of a `userCanvasStats` doc the rules need to reason about. */
export interface StatsShape {
  /** Current spendable balance (earned − spent). Governs CA1/CA4. */
  points: number;
  /** Permanent +max increments already bought on this canvas (0..cap). */
  gaugeMaxBonus: number;
}

export type PointsRuleCode =
  | "cap_reached"
  | "insufficient_points"
  | "invalid_config"
  | "tier_not_earned";

export class PointsRuleError extends Error {
  readonly code: PointsRuleCode;
  constructor(code: PointsRuleCode, message: string) {
    super(message);
    this.name = "PointsRuleError";
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Accrual (CA1).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Points earned for `placements` colored poses. Linear in the MVP, so 10 colored
 * placements yield exactly `10 × pointsPerPlacement` points (CA1).
 */
export function pointsForPlacements(placements: number, cfg: PointsConfig = DEFAULT_POINTS_CONFIG): number {
  if (!Number.isInteger(placements) || placements < 0) {
    throw new PointsRuleError("invalid_config", `placements must be a non-negative integer; got ${placements}.`);
  }
  return placements * cfg.pointsPerPlacement;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gauge max (CA2).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Effective max gauge for a user = the canvas base max plus their purchased
 * bonus. This is the value the gateway must pass to the place-pixel script as
 * `maxCharges` so the hot path honors the upgrade (see
 * docs/contracts/points-gauge-upgrade.md).
 */
export function effectiveGaugeMax(baseGaugeMax: number, gaugeMaxBonus: number): number {
  return baseGaugeMax + gaugeMaxBonus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Upgrade cost & purchase decision (CA2/CA3/CA4).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cost of the *next* upgrade given the bonus already owned. The n-th upgrade
 * (taking bonus from n−1 to n) costs `baseUpgradeCost × n` (CA3), so buying from
 * a bonus of `currentBonus` costs `baseUpgradeCost × (currentBonus + 1)`.
 */
export function nextUpgradeCost(currentBonus: number, cfg: PointsConfig = DEFAULT_POINTS_CONFIG): number {
  if (!Number.isInteger(currentBonus) || currentBonus < 0) {
    throw new PointsRuleError("invalid_config", `currentBonus must be a non-negative integer; got ${currentBonus}.`);
  }
  return cfg.baseUpgradeCost * (currentBonus + 1);
}

export interface PurchaseDecision {
  /** Whether the purchase is allowed. When false, no debit must occur (CA4). */
  ok: boolean;
  /** Set when `ok` is false. */
  reason?: Extract<PointsRuleCode, "cap_reached" | "insufficient_points">;
  /** Cost of the attempted upgrade (the next one). */
  cost: number;
  /** Bonus after the purchase (== current bonus when `ok` is false). */
  newBonus: number;
  /** Spendable balance after the purchase (== current points when `ok` is false). */
  newPoints: number;
}

/**
 * Decide a single gauge-max upgrade purchase. PURE: callers (the Convex
 * mutation) apply the result inside one transaction, so a rejected purchase
 * leaves the row untouched — there is never a partial debit (CA4).
 *
 *  - CA3: refuse once `gaugeMaxBonus` has reached `gaugeMaxBonusCap`.
 *  - CA4: refuse when the balance cannot cover the (increasing) cost.
 */
export function evaluatePurchase(stats: StatsShape, cfg: PointsConfig = DEFAULT_POINTS_CONFIG): PurchaseDecision {
  const { points, gaugeMaxBonus } = stats;
  if (gaugeMaxBonus >= cfg.gaugeMaxBonusCap) {
    return { ok: false, reason: "cap_reached", cost: 0, newBonus: gaugeMaxBonus, newPoints: points };
  }
  const cost = nextUpgradeCost(gaugeMaxBonus, cfg);
  if (points < cost) {
    return { ok: false, reason: "insufficient_points", cost, newBonus: gaugeMaxBonus, newPoints: points };
  }
  return { ok: true, cost, newBonus: gaugeMaxBonus + 1, newPoints: points - cost };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier claim (Lot D / FEN-130) — the board-locked viewer-facing progression.
//
// The board (Alexis, 2026-06-03, FEN-83 ux-spec §V2.2) replaced the *spend*
// model above (no points/no shop for the viewer) with a **claim de palier**: the
// viewer only ever sees their gauge; playing accrues `pointsEarned` (leaderboard,
// untouched) and crossing a tier threshold makes a +1-max claim available, which
// the viewer encashes with an explicit gesture. Contract: docs/contracts/tier-claim.md.
//
// The tier threshold curve REUSES the cumulative upgrade-cost curve so the
// economy stays continuous with F6: tier n is earned once `pointsEarned` reaches
// the sum of the first n upgrade costs, `Σ_{i=1..n} baseUpgradeCost·i =
// baseUpgradeCost · n(n+1)/2`. Capped at `gaugeMaxBonusCap`. The pure
// purchase/cost helpers above are retained because they *define* that curve
// (`nextUpgradeCost`) and remain unit-tested; only the viewer-facing spend sink
// (`purchaseGaugeUpgrade`) is gone from points.ts.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cumulative `pointsEarned` required to have earned tier `n` (1-based):
 * `Σ_{i=1..n} baseUpgradeCost·i = baseUpgradeCost · n(n+1)/2`. `tierThreshold(0)`
 * is 0 (no play needed for "zero tiers earned"). Monotonic strictly increasing
 * in `n`, which is what makes `tiersEarned` a clean inverse.
 */
export function tierThreshold(n: number, cfg: PointsConfig = DEFAULT_POINTS_CONFIG): number {
  if (!Number.isInteger(n) || n < 0) {
    throw new PointsRuleError("invalid_config", `tier index must be a non-negative integer; got ${n}.`);
  }
  return (cfg.baseUpgradeCost * n * (n + 1)) / 2;
}

/**
 * Number of tiers a user has *earned* by playing, derived from their lifetime
 * `pointsEarned`: the largest `n` with `tierThreshold(n) ≤ pointsEarned`, capped
 * at `gaugeMaxBonusCap`. Monotonic in `pointsEarned` (it only ever grows, like
 * the underlying counter), so the returned `earned` is itself monotonic — the
 * client relies on that to never roll its claim cursor back.
 */
export function tiersEarned(pointsEarned: number, cfg: PointsConfig = DEFAULT_POINTS_CONFIG): number {
  if (!Number.isFinite(pointsEarned) || pointsEarned < 0) return 0;
  let n = 0;
  while (n < cfg.gaugeMaxBonusCap && tierThreshold(n + 1, cfg) <= pointsEarned) n++;
  return n;
}

/** The minimal stats the tier-claim decision reasons about. */
export interface TierStatsShape {
  /** Lifetime points earned (leaderboard signal). Drives `earned`. */
  pointsEarned: number;
  /** Tiers already applied to the gauge max (== `confirmed`). 0..cap. */
  gaugeMaxBonus: number;
}

export interface TierClaimDecision {
  /** True when this claim must WRITE (first application of `tierIndex`). */
  ok: boolean;
  /** True when the claim is a safe no-op (`tierIndex ≤ confirmed`, already applied). */
  noop: boolean;
  /** Set only when the claim is REJECTED (a hard error — `tierIndex > earned`). */
  reason?: Extract<PointsRuleCode, "tier_not_earned" | "invalid_config">;
  /** `gaugeMaxBonus` after applying (== current bonus on a no-op or reject). */
  newBonus: number;
  /** Charges to push to the live gauge = `newBonus − currentBonus` (board default: +1/tier). */
  granted: number;
}

/**
 * Decide a single `claimTier(tierIndex)` against the durable stats. PURE so the
 * Convex mutation applies it inside one transaction (idempotent by index — see
 * the contract). Three outcomes:
 *
 *  - **reject** (`ok:false, reason:"tier_not_earned"`): `tierIndex > earned` — the
 *    viewer cannot encash a tier they have not unlocked by playing.
 *  - **no-op** (`ok:false, noop:true`): `tierIndex ≤ confirmed` — already applied;
 *    a reconnect replaying the same index lands here and the caller returns the
 *    current bonus unchanged (idempotency).
 *  - **apply** (`ok:true`): `confirmed < tierIndex ≤ earned`. The bonus advances to
 *    `tierIndex` (target-level), granting `tierIndex − confirmed` charges. The
 *    client emits ops in ascending order so this is normally exactly +1; treating
 *    `tierIndex` as the target level (rather than a blind +1) keeps the result
 *    idempotent AND order-insensitive: a higher index advances; a lower one that
 *    arrives afterwards is a no-op — no tier is double-counted either way.
 */
export function evaluateTierClaim(
  stats: TierStatsShape,
  tierIndex: number,
  cfg: PointsConfig = DEFAULT_POINTS_CONFIG,
): TierClaimDecision {
  const confirmed = stats.gaugeMaxBonus;
  if (!Number.isInteger(tierIndex) || tierIndex < 1) {
    return { ok: false, noop: false, reason: "invalid_config", newBonus: confirmed, granted: 0 };
  }
  const earned = tiersEarned(stats.pointsEarned, cfg);
  if (tierIndex > earned) {
    return { ok: false, noop: false, reason: "tier_not_earned", newBonus: confirmed, granted: 0 };
  }
  if (tierIndex <= confirmed) {
    return { ok: false, noop: true, newBonus: confirmed, granted: 0 };
  }
  return { ok: true, noop: false, newBonus: tierIndex, granted: tierIndex - confirmed };
}
