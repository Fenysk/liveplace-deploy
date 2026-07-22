/**
 * Acceptance tests for the F6 points & gauge-upgrade rules (FEN-18).
 * Runs under Node's built-in test runner with native TS type-stripping —
 * no Convex runtime, no dependency install required:
 *
 *   node --test apps/convex/convex/lib/pointsRules.test.ts
 *
 * Covers cahier §F6 acceptance criteria CA1–CA3 + Lot D tier claim.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_POINTS_CONFIG,
  pointsForPlacements,
  effectiveGaugeMax,
  nextUpgradeCost,
  tierThreshold,
  tiersEarned,
  evaluateTierClaim,
  PointsRuleError,
  type PointsConfig,
} from "./pointsRules.ts";

// ─────────────────────────────────────────────────────────────────────────────
// CA1 — 10 colored placements = 10 points.
// ─────────────────────────────────────────────────────────────────────────────

test("CA1 — 10 colored placements yield exactly 10 points (default config)", () => {
  assert.equal(pointsForPlacements(10), 10);
  assert.equal(DEFAULT_POINTS_CONFIG.pointsPerPlacement, 1);
});

test("CA1 — accrual is linear and zero-safe", () => {
  assert.equal(pointsForPlacements(0), 0);
  assert.equal(pointsForPlacements(1), 1);
  assert.equal(pointsForPlacements(250), 250);
});

test("CA1 — rejects nonsense placement counts (no silent corruption)", () => {
  assert.throws(() => pointsForPlacements(-1), PointsRuleError);
  assert.throws(() => pointsForPlacements(1.5), PointsRuleError);
});

// ─────────────────────────────────────────────────────────────────────────────
// CA2 — spending raises the effective max gauge.
// ─────────────────────────────────────────────────────────────────────────────

test("CA2 — effective max gauge is base + purchased bonus", () => {
  assert.equal(effectiveGaugeMax(1, 0), 1); // no upgrade → base only
  assert.equal(effectiveGaugeMax(1, 3), 4); // three upgrades → +3
  assert.equal(effectiveGaugeMax(5, 30), 35); // capped bonus on a larger base
});

// ─────────────────────────────────────────────────────────────────────────────
// CA3 — increasing cost curve (drives tier thresholds).
// ─────────────────────────────────────────────────────────────────────────────

test("CA3 — cost curve is baseCost × n (the n-th upgrade)", () => {
  assert.equal(nextUpgradeCost(0), 50); // 1st upgrade
  assert.equal(nextUpgradeCost(1), 100); // 2nd
  assert.equal(nextUpgradeCost(2), 150); // 3rd
  assert.equal(nextUpgradeCost(29), 1500); // 30th (last allowed)
});

// ─────────────────────────────────────────────────────────────────────────────
// Config overridability (per-canvas tuning later; defaults stay D1).
// ─────────────────────────────────────────────────────────────────────────────

test("config overrides are honored without touching defaults", () => {
  const cfg: PointsConfig = { pointsPerPlacement: 2, baseUpgradeCost: 10, gaugeMaxBonusCap: 2 };
  assert.equal(pointsForPlacements(10, cfg), 20);
  assert.equal(nextUpgradeCost(1, cfg), 20);
  assert.equal(tierThreshold(2, cfg), 30); // 10·(1+2)
});

// ─────────────────────────────────────────────────────────────────────────────
// Tier claim (Lot D / FEN-130) — board-locked viewer progression.
// ─────────────────────────────────────────────────────────────────────────────

test("tierThreshold is the cumulative upgrade-cost curve (baseUpgradeCost·n(n+1)/2)", () => {
  // default baseUpgradeCost = 50.
  assert.equal(tierThreshold(0), 0);
  assert.equal(tierThreshold(1), 50); // 50·1
  assert.equal(tierThreshold(2), 150); // 50·(1+2)
  assert.equal(tierThreshold(3), 300); // 50·(1+2+3)
  assert.equal(tierThreshold(4), 500); // 50·(1+2+3+4)
});

test("tiersEarned inverts the threshold curve and is capped at gaugeMaxBonusCap", () => {
  assert.equal(tiersEarned(0), 0);
  assert.equal(tiersEarned(49), 0);
  assert.equal(tiersEarned(50), 1); // exactly on the threshold counts
  assert.equal(tiersEarned(149), 1);
  assert.equal(tiersEarned(150), 2);
  assert.equal(tiersEarned(299), 2);
  assert.equal(tiersEarned(300), 3);
  assert.equal(tiersEarned(500), 4);
  // Far past the last tier → capped at the bonus cap (30), never beyond.
  assert.equal(tiersEarned(10_000_000), DEFAULT_POINTS_CONFIG.gaugeMaxBonusCap);
  // Garbage / negative → no tiers (defensive; pointsEarned never goes negative).
  assert.equal(tiersEarned(-5), 0);
});

test("claimTier applies the next earned tier: +1 bonus, +1 charge granted", () => {
  // pointsEarned 300 ⇒ earned 3; confirmed 0 ⇒ claim tier 1 is a first application.
  const d = evaluateTierClaim({ pointsEarned: 300, gaugeMaxBonus: 0 }, 1);
  assert.equal(d.ok, true);
  assert.equal(d.noop, false);
  assert.equal(d.newBonus, 1);
  assert.equal(d.granted, 1); // board default: +1 usable charge per tier
});

test("claimTier refuses a tier not yet earned (tierIndex > earned)", () => {
  const d = evaluateTierClaim({ pointsEarned: 300, gaugeMaxBonus: 0 }, 4); // earned = 3
  assert.equal(d.ok, false);
  assert.equal(d.noop, false);
  assert.equal(d.reason, "tier_not_earned");
  assert.equal(d.newBonus, 0); // no write
  assert.equal(d.granted, 0);
});

test("claimTier is idempotent by index: tierIndex ≤ confirmed is a safe no-op", () => {
  const d = evaluateTierClaim({ pointsEarned: 300, gaugeMaxBonus: 2 }, 1); // already applied
  assert.equal(d.ok, false);
  assert.equal(d.noop, true);
  assert.equal(d.newBonus, 2);
  assert.equal(d.granted, 0);
  // Re-applying the just-confirmed index is also a no-op.
  const same = evaluateTierClaim({ pointsEarned: 300, gaugeMaxBonus: 2 }, 2);
  assert.equal(same.noop, true);
  assert.equal(same.newBonus, 2);
});

test("claimTier is order-insensitive: a higher index advances to it, granting the delta", () => {
  // confirmed 1, earned 3, claim tier 3 directly (gap / out-of-order arrival).
  const jump = evaluateTierClaim({ pointsEarned: 300, gaugeMaxBonus: 1 }, 3);
  assert.equal(jump.ok, true);
  assert.equal(jump.newBonus, 3); // target-level
  assert.equal(jump.granted, 2); // tiers 2 and 3 both encashed → +2 charges
  // The skipped lower index, arriving afterwards, is then a no-op (no double-count).
  const late = evaluateTierClaim({ pointsEarned: 300, gaugeMaxBonus: 3 }, 2);
  assert.equal(late.noop, true);
  assert.equal(late.granted, 0);
});

test("claimTier rejects a non-positive / non-integer index as invalid_config", () => {
  for (const bad of [0, -1, 1.5]) {
    const d = evaluateTierClaim({ pointsEarned: 300, gaugeMaxBonus: 0 }, bad);
    assert.equal(d.ok, false);
    assert.equal(d.reason, "invalid_config");
    assert.equal(d.granted, 0);
  }
});
