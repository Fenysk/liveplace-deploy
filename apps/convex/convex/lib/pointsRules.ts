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

export type PointsRuleCode = "cap_reached" | "insufficient_points" | "invalid_config";

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
