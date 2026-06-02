/**
 * Unit tests for the F6 gauge-bonus application layer (FEN-27). Covers the
 * effective-max formula, the Convex/static sources, and the per-session cache
 * with mid-session refresh (the post-`purchaseGaugeUpgrade` path).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  effectiveGaugeMax,
  ConvexGaugeBonusSource,
  StaticGaugeBonusSource,
  SessionGauge,
  type ConvexQueryClient,
  type GaugeBonusSource,
} from "../gaugeBonus";

test("effectiveGaugeMax = base + bonus (mirrors pointsRules)", () => {
  assert.equal(effectiveGaugeMax(20, 0), 20); // no upgrade → base only
  assert.equal(effectiveGaugeMax(20, 3), 23); // three upgrades → +3
  assert.equal(effectiveGaugeMax(20, 30), 50); // capped bonus on the D1 base
});

test("StaticGaugeBonusSource returns its bonus and floors junk to 0", async () => {
  assert.equal(await new StaticGaugeBonusSource(0).getGaugeBonus(), 0);
  assert.equal(await new StaticGaugeBonusSource(5).getGaugeBonus(), 5);
  assert.equal(await new StaticGaugeBonusSource(-3).getGaugeBonus(), 0); // never negative
  assert.equal(await new StaticGaugeBonusSource().getGaugeBonus(), 0); // default
});

test("ConvexGaugeBonusSource queries points.getGaugeBonus with (canvasId, userId)", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: ConvexQueryClient = {
    async query(name, args) {
      calls.push({ name, args });
      return { gaugeMaxBonus: 4 };
    },
  };
  const source = new ConvexGaugeBonusSource(client, "canvas123");
  assert.equal(await source.getGaugeBonus("user-A"), 4);
  assert.deepEqual(calls, [{ name: "points:getGaugeBonus", args: { canvasId: "canvas123", userId: "user-A" } }]);
});

test("ConvexGaugeBonusSource defaults to 0 for a missing row or garbage", async () => {
  const nullClient: ConvexQueryClient = { async query() { return null; } };
  assert.equal(await new ConvexGaugeBonusSource(nullClient, "c").getGaugeBonus("u"), 0);

  const junkClient: ConvexQueryClient = { async query() { return { gaugeMaxBonus: "nope" }; } };
  assert.equal(await new ConvexGaugeBonusSource(junkClient, "c").getGaugeBonus("u"), 0);
});

test("SessionGauge starts at base, then applies the bonus on refresh (CA2)", async () => {
  const source = new StaticGaugeBonusSource(3);
  const g = new SessionGauge(source, "user-A", 20);

  // Before resolve a racing placement is budgeted at the base only — never over.
  assert.equal(g.bonus, 0);
  assert.equal(g.effectiveGaugeMax, 20);

  const bonus = await g.refresh();
  assert.equal(bonus, 3);
  assert.equal(g.bonus, 3);
  assert.equal(g.effectiveGaugeMax, 23); // base 20 + 3 upgrades → stores 23 (CA2)
});

test("SessionGauge.refresh picks up a mid-session purchase (FEN-27 #3)", async () => {
  // A mutable source models Convex after a purchaseGaugeUpgrade raised the bonus.
  let current = 1;
  const source: GaugeBonusSource = { async getGaugeBonus() { return current; } };
  const g = new SessionGauge(source, "user-A", 20);

  await g.refresh();
  assert.equal(g.effectiveGaugeMax, 21);

  current = 2; // user buys another upgrade; gateway is poked to refresh
  await g.refresh();
  assert.equal(g.effectiveGaugeMax, 22);
});

test("SessionGauge.refresh keeps the last known bonus when the source fails", async () => {
  let fail = false;
  const source: GaugeBonusSource = {
    async getGaugeBonus() {
      if (fail) throw new Error("convex down");
      return 5;
    },
  };
  const g = new SessionGauge(source, "user-A", 20);
  await g.refresh();
  assert.equal(g.effectiveGaugeMax, 25);

  // A transient blip must not drop the paid-for ceiling: value is retained,
  // and the error is surfaced to the caller (the gateway logs it).
  fail = true;
  await assert.rejects(() => g.refresh(), /convex down/);
  assert.equal(g.effectiveGaugeMax, 25);
});
