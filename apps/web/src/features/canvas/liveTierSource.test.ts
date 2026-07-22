/**
 * Live `TierSource` bridge DoD ([FEN-142]). Two halves of the web wiring:
 *   1. adapter mapping — `push`/`subscribe` fan-out + latest-snapshot replay, and
 *      the `ClaimOp → claimTier({ canvasId, tierIndex })` mapping (incl. the inert
 *      no-op while no canvas is resolved);
 *   2. an integration pass on the optimistic→confirmed fold — driving the real
 *      {@link TierClaim} controller through the bridge to prove the réserve max
 *      never jumps as the server `confirmed` count catches up with a claim.
 *
 * Pure (no React/Convex): the bridge is dependency-free by design, so node:test
 * exercises it directly — the React hook is the only untested shell.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLiveTierSource } from "./liveTierSource.ts";
import { TierClaim, type ClaimOp } from "./tierClaim.ts";

/** A claim spy whose calls are recorded and whose result is configurable. */
function claimSpy(bonus = 1): {
  fn: (a: { canvasId: string; tierIndex: number }) => Promise<{ gaugeMaxBonus: number }>;
  calls: Array<{ canvasId: string; tierIndex: number }>;
} {
  const calls: Array<{ canvasId: string; tierIndex: number }> = [];
  return {
    calls,
    fn: async (a) => {
      calls.push(a);
      return { gaugeMaxBonus: bonus };
    },
  };
}

test("push fans a snapshot out to current subscribers", () => {
  const spy = claimSpy();
  const src = createLiveTierSource({ getCanvasId: () => "cv1", claimTier: spy.fn });
  const seen: Array<{ earned: number; confirmed: number }> = [];
  src.subscribe((p) => seen.push(p));
  src.push({ earned: 2, confirmed: 1 });
  assert.deepEqual(seen, [{ earned: 2, confirmed: 1 }]);
});

test("a late subscriber is replayed the latest snapshot immediately", () => {
  const spy = claimSpy();
  const src = createLiveTierSource({ getCanvasId: () => "cv1", claimTier: spy.fn });
  src.push({ earned: 3, confirmed: 2 });
  const seen: Array<{ earned: number; confirmed: number }> = [];
  src.subscribe((p) => seen.push(p)); // subscribes AFTER the first push
  assert.deepEqual(seen, [{ earned: 3, confirmed: 2 }]);
});

test("undefined/null snapshots (loading / skip) are ignored", () => {
  const spy = claimSpy();
  const src = createLiveTierSource({ getCanvasId: () => "cv1", claimTier: spy.fn });
  const seen: unknown[] = [];
  src.subscribe((p) => seen.push(p));
  src.push(undefined);
  src.push(null);
  assert.deepEqual(seen, []);
});

test("unsubscribe stops further notifications", () => {
  const spy = claimSpy();
  const src = createLiveTierSource({ getCanvasId: () => "cv1", claimTier: spy.fn });
  const seen: unknown[] = [];
  const unsub = src.subscribe((p) => seen.push(p));
  src.push({ earned: 1, confirmed: 0 });
  unsub();
  src.push({ earned: 2, confirmed: 0 });
  assert.equal(seen.length, 1);
});

test("claim maps the op to claimTier({ canvasId, tierIndex }) with the live id", async () => {
  const spy = claimSpy();
  let id: string | null = "cv-A";
  const src = createLiveTierSource({ getCanvasId: () => id, claimTier: spy.fn });
  await src.claim({ tierIndex: 1 });
  // A late-arriving canvas id (auth completes after mount) is honoured without rebuild.
  id = "cv-B";
  await src.claim({ tierIndex: 2 });
  assert.deepEqual(spy.calls, [
    { canvasId: "cv-A", tierIndex: 1 },
    { canvasId: "cv-B", tierIndex: 2 },
  ]);
});

test("claim is an inert no-op while no canvas is resolved", async () => {
  const spy = claimSpy();
  const src = createLiveTierSource({ getCanvasId: () => null, claimTier: spy.fn });
  const r = src.claim({ tierIndex: 1 });
  assert.equal(r, undefined); // synchronous no-op, nothing dispatched
  assert.deepEqual(spy.calls, []);
});

test("a failed claim is swallowed (idempotent reconnect replay applies once)", async () => {
  const errors: unknown[] = [];
  const src = createLiveTierSource({
    getCanvasId: () => "cv1",
    claimTier: async () => {
      throw new Error("network blip");
    },
    onError: (e) => errors.push(e),
  });
  // Must not reject — a transient failure resolves on the next reconnect replay.
  await assert.doesNotReject(async () => {
    await src.claim({ tierIndex: 1 });
  });
  assert.equal(errors.length, 1);
});

test("integration: optimistic→confirmed fold never jumps the réserve max", async () => {
  // Wire the real controller to the live source exactly as CanvasView does.
  const spy = claimSpy();
  const canvasId: string | null = "cv1";
  const src = createLiveTierSource({ getCanvasId: () => canvasId, claimTier: spy.fn });
  const tier = new TierClaim();
  src.subscribe((p) => tier.sync(p));

  // Server: one tier earned by playing, none applied yet. serverMax starts at 5.
  let serverMax = 5;
  src.push({ earned: 1, confirmed: 0 });
  assert.equal(tier.pending, 1, "the crossed tier signals a claim");
  assert.equal(tier.effectiveMax(serverMax), 5, "no overlay before the gesture");

  // Viewer gesture: encash the tier. Optimistic overlay lifts the réserve instantly.
  const op: ClaimOp | null = tier.claimNext();
  assert.deepEqual(op, { tierIndex: 1 });
  await src.claim(op!);
  assert.deepEqual(spy.calls, [{ canvasId: "cv1", tierIndex: 1 }]);
  assert.equal(tier.optimisticBonus, 1);
  assert.equal(tier.effectiveMax(serverMax), 6, "optimistic réserve 5 → 6 on the gesture");

  // Server confirms: `confirmed` bumps AND the gateway gauge frame carries the new
  // durable max together (the contract guarantee). The displayed max must stay 6.
  serverMax = 6; // gauge frame applied the durable +1
  src.push({ earned: 1, confirmed: 1 });
  assert.equal(tier.optimisticBonus, 0, "overlay resorbed as confirmed caught up");
  assert.equal(tier.effectiveMax(serverMax), 6, "displayed réserve stays 6 — no visible jump");
  assert.equal(tier.pending, 0, "nothing left to claim");
});
