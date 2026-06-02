/**
 * Unit tests for the D1 gauge math (../src/gauge.ts), the source of truth the
 * place.lua / refill-peek.lua scripts mirror. Run with `node --test`.
 *
 * Coverage maps to the F5 / D1 acceptance criteria:
 *   CA1 — refills refillAmount every refillIntervalSec after emptying
 *   CA2 — never exceeds the effective max
 *   CA3 — raising the effective max (base + bonus) lifts the ceiling immediately
 *   CA4 — cumulative refill after a long absence is correct and capped
 * Plus: init-to-max on first contact, eraser parity (consume == 1, see the Redis
 * integration test), clock skew, owner overrides.
 *
 * The effective max here is whatever the gateway passes as `gaugeMax`
 * (= canvas base + F6 upgrade bonus); this module never computes the bonus.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  refillGauge,
  nextRefillAt,
  DEFAULT_GAUGE,
  type GaugeParams,
  type StoredGauge,
} from "../src/gauge.ts";

const P = DEFAULT_GAUGE; // gaugeMax 20, amount 1, interval 30_000 ms
const withMax = (gaugeMax: number): GaugeParams => ({ ...P, gaugeMax });
const T0 = 1_000_000_000_000; // fixed epoch base for determinism
const stored = (charges: number, ts: number): StoredGauge => ({ charges, ts });

test("D1 defaults match the decision", () => {
  assert.equal(P.gaugeMax, 20);
  assert.equal(P.refillAmount, 1);
  assert.equal(P.refillIntervalMs, 30_000);
});

test("init: first contact arrives full at the effective max", () => {
  const s = refillGauge(null, T0, P);
  assert.equal(s.charges, 20);
  assert.equal(s.max, 20);
  assert.equal(s.ts, T0);
  assert.equal(nextRefillAt(s, P), 0); // full → no countdown
});

test("CA1: after emptying, one charge returns every interval", () => {
  // Empty gauge, clock anchored at T0.
  let s = refillGauge(stored(0, T0), T0, P);
  assert.equal(s.charges, 0);
  assert.equal(nextRefillAt(s, P), T0 + 30_000);

  // Just before the tick — still empty.
  s = refillGauge(stored(0, T0), T0 + 29_999, P);
  assert.equal(s.charges, 0);

  // Exactly at the tick — exactly one charge.
  s = refillGauge(stored(0, T0), T0 + 30_000, P);
  assert.equal(s.charges, 1);

  // Two intervals → two charges.
  s = refillGauge(stored(0, T0), T0 + 60_000, P);
  assert.equal(s.charges, 2);
});

test("CA2: refill never exceeds the effective max", () => {
  // 19/20, wait far longer than needed to top off.
  const s = refillGauge(stored(19, T0), T0 + 10 * 30_000, P);
  assert.equal(s.charges, 20);
  assert.equal(s.max, 20);
  // Already full input stays clamped.
  const full = refillGauge(stored(20, T0), T0 + 5 * 30_000, P);
  assert.equal(full.charges, 20);
});

test("CA3: raising the effective max lifts the ceiling immediately (same instant)", () => {
  // Full at base max 20, clock fresh (gateway passes base only).
  const beforeBonus = refillGauge(stored(20, T0), T0, withMax(20));
  assert.equal(beforeBonus.max, 20);
  assert.equal(nextRefillAt(beforeBonus, withMax(20)), 0); // full

  // After an upgrade the gateway passes max 25 at the SAME instant: the ceiling
  // is 25 now, but no free charges are gifted (charges stay 20, refill over time).
  const afterBonus = refillGauge(stored(20, T0), T0, withMax(25));
  assert.equal(afterBonus.max, 25);
  assert.equal(afterBonus.charges, 20);
  assert.equal(nextRefillAt(afterBonus, withMax(25)), T0 + 30_000); // now below max

  // The 5 new charges refill at the normal rate, capped at 25.
  assert.equal(refillGauge(stored(20, T0), T0 + 30_000, withMax(25)).charges, 21);
  assert.equal(refillGauge(stored(20, T0), T0 + 5 * 30_000, withMax(25)).charges, 25);
  assert.equal(refillGauge(stored(20, T0), T0 + 100 * 30_000, withMax(25)).charges, 25);
});

test("CA4: cumulative refill after a long absence is correct and capped", () => {
  // From 3 charges, away for 50 minutes (100 ticks) → capped at max, not 103.
  const s = refillGauge(stored(3, T0), T0 + 100 * 30_000, P);
  assert.equal(s.charges, 20);

  // Sub-tick remainder is preserved across calls (no lost time).
  // Start empty; 70s elapsed = 2 ticks + 10s remainder.
  const partial = refillGauge(stored(0, T0), T0 + 70_000, P);
  assert.equal(partial.charges, 2);
  // Clock advanced by 2 whole ticks (60s), so the next charge is 20s away, not 30.
  assert.equal(partial.ts, T0 + 60_000);
  assert.equal(nextRefillAt(partial, P), T0 + 90_000);
});

test("full gauge pins the clock so the next charge after a consume is a full interval", () => {
  // A viewer sits full and idle for 10 min, then the gauge is refreshed.
  const s = refillGauge(stored(20, T0), T0 + 600_000, P);
  assert.equal(s.charges, 20);
  assert.equal(s.ts, T0 + 600_000); // clock pinned to "now", remainder discarded
  // Simulate a consume (place.lua): charges 19, ts unchanged → next charge a full
  // interval away, not arriving early.
  const afterConsume = { ...s, charges: 19 };
  assert.equal(nextRefillAt(afterConsume, P), T0 + 600_000 + 30_000);
});

test("clock skew (negative elapsed) grants nothing", () => {
  const s = refillGauge(stored(5, T0), T0 - 60_000, P);
  assert.equal(s.charges, 5);
});

test("custom canvas config (owner override) is honoured", () => {
  const fast: GaugeParams = { gaugeMax: 10, refillAmount: 2, refillIntervalMs: 10_000, gaugeTtlMs: 0 };
  // First contact full at 10.
  assert.equal(refillGauge(null, T0, fast).charges, 10);
  // From 0, after 10s → +2.
  assert.equal(refillGauge(stored(0, T0), T0 + 10_000, fast).charges, 2);
  // Capped at 10.
  assert.equal(refillGauge(stored(0, T0), T0 + 100_000, fast).charges, 10);
});
