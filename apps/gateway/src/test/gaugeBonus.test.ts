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
  IoredisGaugeGrantRunner,
  IoredisGaugePeekRunner,
  type ConvexQueryClient,
  type GaugeBonusSource,
} from "../gaugeBonus";
import { DEFAULT_GAUGE, userGaugeKey, type GaugeParams } from "@canvas/redis-scripts";

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

test("SessionGauge for an anonymous viewer (userId null) never queries the source (FEN-53)", async () => {
  // An anonymous read-only viewer has no durable bonus and never places; refresh
  // must stay at base and must NOT call the source (which only takes a real id).
  let calls = 0;
  const source: GaugeBonusSource = {
    async getGaugeBonus() {
      calls++;
      return 7;
    },
  };
  const g = new SessionGauge(source, null, 20);
  assert.equal(g.effectiveGaugeMax, 20);
  assert.equal(await g.refresh(), 0);
  assert.equal(g.effectiveGaugeMax, 20);
  assert.equal(calls, 0);
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

// ─────────────────────────────────────────────────────────────────────────────
// IoredisGaugeGrantRunner (tier claim, FEN-130) — the +1-charge grant seam.
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal fake exposing only the {script, evalsha} surface the runner uses. */
class FakeGrantRedis {
  loads = 0;
  calls: Array<{ numKeys: number; args: string[] }> = [];
  constructor(private readonly reply: unknown, private readonly failFirstWith?: string) {}
  async script(_sub: "LOAD", _lua: string): Promise<string> {
    this.loads++;
    return `sha-${this.loads}`;
  }
  async evalsha(_sha: string, numKeys: number, ...args: string[]): Promise<unknown> {
    this.calls.push({ numKeys, args });
    if (this.failFirstWith && this.calls.length === 1) throw new Error(this.failFirstWith);
    return this.reply;
  }
}

const GP: GaugeParams = { ...DEFAULT_GAUGE, gaugeMax: 21 };

test("grant runner forwards (gaugeKey, now, interval, amount, max, grant, ttl) and parses the snapshot", async () => {
  const fake = new FakeGrantRedis([21, 21, 0]);
  const runner = new IoredisGaugeGrantRunner(fake as never);
  const out = await runner.grant("user-Z", GP, 1, 1_700_000_000_000);
  assert.deepEqual(out, { charges: 21, max: 21, cooldownUntil: 0 });
  assert.equal(fake.loads, 1); // SCRIPT LOAD once
  assert.equal(fake.calls.length, 1);
  const [call] = fake.calls;
  assert.ok(call);
  assert.equal(call.numKeys, 1);
  // KEYS[1] = the per-user gauge hash; ARGV carries the effective max + grant.
  assert.equal(call.args[0], userGaugeKey("user-Z"));
  assert.deepEqual(call.args.slice(1), [
    "1700000000000", String(GP.refillIntervalMs), String(GP.refillAmount), "21", "1", String(GP.gaugeTtlMs),
  ]);
});

test("grant runner reloads the script once on NOSCRIPT and retries", async () => {
  const fake = new FakeGrantRedis([20, 21, 1_700_000_030_000], "NOSCRIPT No matching script");
  const runner = new IoredisGaugeGrantRunner(fake as never);
  const out = await runner.grant("user-Z", GP, 2, 1_700_000_000_000);
  assert.deepEqual(out, { charges: 20, max: 21, cooldownUntil: 1_700_000_030_000 });
  assert.equal(fake.loads, 2); // initial LOAD + reload on NOSCRIPT
  assert.equal(fake.calls.length, 2); // first throws, second succeeds
});

// ─────────────────────────────────────────────────────────────────────────────
// IoredisGaugePeekRunner (initial gauge frame on connect, FEN-184) — the
// read-only refill-peek seam. Same {script, evalsha} discipline as the grant
// runner; reuses FakeGrantRedis since the surface is identical.
// ─────────────────────────────────────────────────────────────────────────────

test("peek runner forwards (gaugeKey, now, interval, amount, max) and parses the snapshot", async () => {
  // A never-placed user reads as conceptually full at the effective max.
  const fake = new FakeGrantRedis([21, 21, 0]);
  const runner = new IoredisGaugePeekRunner(fake as never);
  const out = await runner.peek("user-Z", GP, 1_700_000_000_000);
  assert.deepEqual(out, { charges: 21, max: 21, cooldownUntil: 0 });
  assert.equal(fake.loads, 1); // SCRIPT LOAD once
  assert.equal(fake.calls.length, 1);
  const [call] = fake.calls;
  assert.ok(call);
  assert.equal(call.numKeys, 1);
  // KEYS[1] = the per-user gauge hash; ARGV = [now, interval, amount, effMax].
  // No consume/grant arg — the peek is read-only.
  assert.equal(call.args[0], userGaugeKey("user-Z"));
  assert.deepEqual(call.args.slice(1), [
    "1700000000000", String(GP.refillIntervalMs), String(GP.refillAmount), "21",
  ]);
});

test("peek runner reloads the script once on NOSCRIPT and retries", async () => {
  const fake = new FakeGrantRedis([3, 21, 1_700_000_030_000], "NOSCRIPT No matching script");
  const runner = new IoredisGaugePeekRunner(fake as never);
  const out = await runner.peek("user-Z", GP, 1_700_000_000_000);
  assert.deepEqual(out, { charges: 3, max: 21, cooldownUntil: 1_700_000_030_000 });
  assert.equal(fake.loads, 2); // initial LOAD + reload on NOSCRIPT
  assert.equal(fake.calls.length, 2); // first throws, second succeeds
});
