/**
 * Acceptance tests for the F6 points & gauge-upgrade rules (FEN-18).
 * Runs under Node's built-in test runner with native TS type-stripping —
 * no Convex runtime, no dependency install required:
 *
 *   node --test apps/convex/convex/lib/pointsRules.test.ts
 *
 * Covers cahier §F6 acceptance criteria CA1–CA4.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_POINTS_CONFIG,
  pointsForPlacements,
  effectiveGaugeMax,
  nextUpgradeCost,
  evaluatePurchase,
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

test("CA2 — a successful purchase increments the bonus by exactly one", () => {
  const d = evaluatePurchase({ points: 50, gaugeMaxBonus: 0 });
  assert.equal(d.ok, true);
  assert.equal(d.newBonus, 1);
  assert.equal(effectiveGaugeMax(1, d.newBonus), 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// CA3 — increasing cost; purchase refused at the cap.
// ─────────────────────────────────────────────────────────────────────────────

test("CA3 — cost curve is baseCost × n (the n-th upgrade)", () => {
  assert.equal(nextUpgradeCost(0), 50); // 1st upgrade
  assert.equal(nextUpgradeCost(1), 100); // 2nd
  assert.equal(nextUpgradeCost(2), 150); // 3rd
  assert.equal(nextUpgradeCost(29), 1500); // 30th (last allowed)
});

test("CA3 — purchase is refused once the bonus reaches the cap", () => {
  const atCap = evaluatePurchase({ points: 1_000_000, gaugeMaxBonus: 30 });
  assert.equal(atCap.ok, false);
  assert.equal(atCap.reason, "cap_reached");
  // No debit / no further bonus even with a huge balance.
  assert.equal(atCap.newBonus, 30);
  assert.equal(atCap.newPoints, 1_000_000);
});

test("CA3 — the last upgrade (29→30) is allowed, the next (30→31) is not", () => {
  const last = evaluatePurchase({ points: 1500, gaugeMaxBonus: 29 });
  assert.equal(last.ok, true);
  assert.equal(last.newBonus, 30);
  const beyond = evaluatePurchase({ points: 1500, gaugeMaxBonus: 30 });
  assert.equal(beyond.ok, false);
  assert.equal(beyond.reason, "cap_reached");
});

// ─────────────────────────────────────────────────────────────────────────────
// CA4 — spending without balance fails with no partial debit.
// ─────────────────────────────────────────────────────────────────────────────

test("CA4 — insufficient balance is refused with the row untouched", () => {
  const d = evaluatePurchase({ points: 49, gaugeMaxBonus: 0 }); // needs 50
  assert.equal(d.ok, false);
  assert.equal(d.reason, "insufficient_points");
  assert.equal(d.cost, 50);
  assert.equal(d.newBonus, 0); // unchanged
  assert.equal(d.newPoints, 49); // unchanged — no partial debit
});

test("CA4 — exact-balance purchase succeeds and zeroes the balance", () => {
  const d = evaluatePurchase({ points: 50, gaugeMaxBonus: 0 });
  assert.equal(d.ok, true);
  assert.equal(d.newPoints, 0);
  assert.equal(d.newBonus, 1);
});

test("CA4 — second upgrade requires the higher cost; near-miss is refused", () => {
  // Owns 1 bonus already; the 2nd upgrade costs 100. With 99 points it fails.
  const d = evaluatePurchase({ points: 99, gaugeMaxBonus: 1 });
  assert.equal(d.ok, false);
  assert.equal(d.reason, "insufficient_points");
  assert.equal(d.cost, 100);
  assert.equal(d.newBonus, 1);
  assert.equal(d.newPoints, 99);
});

// ─────────────────────────────────────────────────────────────────────────────
// Config overridability (per-canvas tuning later; defaults stay D1).
// ─────────────────────────────────────────────────────────────────────────────

test("config overrides are honored without touching defaults", () => {
  const cfg: PointsConfig = { pointsPerPlacement: 2, baseUpgradeCost: 10, gaugeMaxBonusCap: 2 };
  assert.equal(pointsForPlacements(10, cfg), 20);
  assert.equal(nextUpgradeCost(1, cfg), 20);
  const capped = evaluatePurchase({ points: 100, gaugeMaxBonus: 2 }, cfg);
  assert.equal(capped.ok, false);
  assert.equal(capped.reason, "cap_reached");
});
