/**
 * pointsRules — thin re-export of the shared pure business rules.
 *
 * The canonical implementation lives in `@canvas/points-rules` (shared package)
 * so both this Convex app and the gateway process consume the same source of
 * truth without duplicating the formula (FEN-2001).
 *
 * All existing Convex imports (`./lib/pointsRules`, `../lib/pointsRules`) keep
 * working unchanged — this file is the stable local surface; the package holds
 * the logic.
 */
export {
  type PointsConfig,
  DEFAULT_POINTS_CONFIG,
  type PointsRuleCode,
  PointsRuleError,
  pointsForPlacements,
  effectiveGaugeMax,
  nextUpgradeCost,
  tierThreshold,
  tiersEarned,
  type TierStatsShape,
  type TierClaimDecision,
  evaluateTierClaim,
} from "@canvas/points-rules";
