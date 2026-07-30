/**
 * Lot D claim-de-palier DoD ([FEN-116]). Exercises the {@link TierClaim} state
 * machine against the board-locked model and every edge case in the ux-spec
 * §V2.2 matrix: cooldown, in-batch non-intrusion, stacking, deferral, cap
 * recompute, and offline/reconnect idempotency by tier index.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TierClaim } from "./tierClaim.ts";

test("no progression → nothing claimable, no overlay", () => {
  const tc = new TierClaim();
  assert.equal(tc.pending, 0);
  assert.equal(tc.claimable, false);
  assert.equal(tc.optimisticBonus, 0);
  assert.equal(tc.claimNext(), null);
  assert.deepEqual(tc.claimAll(), []);
  assert.equal(tc.effectiveMax(5), 5);
  assert.equal(tc.effectiveCharges(3), 3);
});

test("a crossed tier becomes a pending claim (signalled, not auto-applied)", () => {
  const tc = new TierClaim({ earned: 1, confirmed: 0 });
  assert.equal(tc.pending, 1);
  assert.equal(tc.claimable, true);
  // Not auto-applied: the overlay stays 0 until the gesture fires.
  assert.equal(tc.optimisticBonus, 0);
  assert.equal(tc.effectiveMax(5), 5);
});

test("claiming encashes the tier: +1 max overlay immediately (optimistic)", () => {
  const tc = new TierClaim({ earned: 1, confirmed: 0 });
  const op = tc.claimNext();
  assert.deepEqual(op, { tierIndex: 1 });
  assert.equal(tc.pending, 0);
  assert.equal(tc.optimisticBonus, 1);
  assert.equal(tc.effectiveMax(5), 6); // réserve 5 → 6 the instant the gesture fires
});

test("board default: claim grants +1 immediately-usable charge (actionable mid-cooldown)", () => {
  const tc = new TierClaim({ earned: 1, confirmed: 0 });
  // Mid-cooldown the server reports 0 charges; the claim still encashes and the
  // celebration is actionable thanks to the +1 charge overlay.
  assert.equal(tc.effectiveCharges(0), 0);
  tc.claimNext();
  assert.equal(tc.effectiveCharges(0), 1);
});

test("server confirmation folds the overlay away continuously (no max jump)", () => {
  const tc = new TierClaim({ earned: 1, confirmed: 0 });
  tc.claimNext();
  assert.equal(tc.effectiveMax(5), 6); // overlay carries it
  // The gateway applied the upgrade: gauge frame max 5→6 AND confirmed 0→1 land
  // together. Overlay drops to 0, displayed max stays 6 — continuous.
  tc.sync({ earned: 1, confirmed: 1 });
  assert.equal(tc.optimisticBonus, 0);
  assert.equal(tc.effectiveMax(6), 6);
  assert.equal(tc.pending, 0);
});

test("stacked tiers: encash one-by-one (dopamine per palier)", () => {
  const tc = new TierClaim({ earned: 3, confirmed: 0 });
  assert.equal(tc.pending, 3);
  assert.deepEqual(tc.claimNext(), { tierIndex: 1 });
  assert.equal(tc.pending, 2);
  assert.equal(tc.optimisticBonus, 1);
  assert.deepEqual(tc.claimNext(), { tierIndex: 2 });
  assert.deepEqual(tc.claimNext(), { tierIndex: 3 });
  assert.equal(tc.pending, 0);
  assert.equal(tc.optimisticBonus, 3);
  assert.equal(tc.effectiveMax(5), 8);
});

test("stacked tiers: 'tout encaisser' claims all in ascending index order", () => {
  const tc = new TierClaim({ earned: 3, confirmed: 1 });
  // confirmed 1 already folded into the server max; 2 remain claimable.
  assert.equal(tc.pending, 2);
  assert.deepEqual(tc.claimAll(), [{ tierIndex: 2 }, { tierIndex: 3 }]);
  assert.equal(tc.pending, 0);
  assert.equal(tc.optimisticBonus, 2);
});

test("deferred / ignored claim persists across syncs and never auto-applies", () => {
  const tc = new TierClaim({ earned: 1, confirmed: 0 });
  // Several server refreshes arrive (gauge refills, etc.) — the claim must NOT
  // self-apply and must NOT expire.
  tc.sync({ earned: 1, confirmed: 0 });
  tc.sync({ earned: 1, confirmed: 0 });
  assert.equal(tc.pending, 1);
  assert.equal(tc.optimisticBonus, 0); // still un-applied
  // A new tier crossing simply stacks on the deferred one.
  tc.sync({ earned: 2, confirmed: 0 });
  assert.equal(tc.pending, 2);
});

test("in-batch non-intrusion: a pending (un-claimed) tier does not raise the cap", () => {
  // A palier crossed mid-batch is signalled but encashable only later; until the
  // gesture fires the batch cap (= effective charges) is unchanged.
  const tc = new TierClaim({ earned: 1, confirmed: 0 });
  const charges = 4;
  assert.equal(tc.effectiveCharges(charges), 4); // pending, not claimed → no change
  // After the gesture, the ceiling recomputes (+1 usable charge) → one more cell.
  tc.claimNext();
  assert.equal(tc.effectiveCharges(charges), 5);
});

test("cap recompute is predictable: each encashed tier adds exactly one", () => {
  const tc = new TierClaim({ earned: 2, confirmed: 0 });
  assert.equal(tc.effectiveCharges(2), 2);
  tc.claimNext();
  assert.equal(tc.effectiveCharges(2), 3);
  tc.claimNext();
  assert.equal(tc.effectiveCharges(2), 4);
});

test("offline → reconnect: resendUnconfirmed replays the same indices (idempotent)", () => {
  const tc = new TierClaim({ earned: 2, confirmed: 0 });
  // Claimed while offline; the mutations did not reach the server yet.
  tc.claimNext();
  tc.claimNext();
  assert.deepEqual(tc.resendUnconfirmed(), [{ tierIndex: 1 }, { tierIndex: 2 }]);
  // Reconnect: server confirms tier 1 only so far.
  tc.sync({ earned: 2, confirmed: 1 });
  assert.deepEqual(tc.resendUnconfirmed(), [{ tierIndex: 2 }]); // 1 no longer replayed
  assert.equal(tc.optimisticBonus, 1); // tier 2 still optimistic
  // Server confirms tier 2.
  tc.sync({ earned: 2, confirmed: 2 });
  assert.deepEqual(tc.resendUnconfirmed(), []);
  assert.equal(tc.optimisticBonus, 0);
});

test("idempotency: a tier confirmed elsewhere is never re-claimed", () => {
  const tc = new TierClaim({ earned: 3, confirmed: 0 });
  tc.claimNext(); // tier 1 locally
  // Meanwhile another device claimed tiers 1 and 2 → server confirms 2.
  tc.sync({ earned: 3, confirmed: 2 });
  assert.equal(tc.pending, 1); // only tier 3 remains
  assert.equal(tc.optimisticBonus, 0); // cursor pulled up to confirmed, no phantom overlay
  assert.deepEqual(tc.claimNext(), { tierIndex: 3 });
});

test("monotonic guard: a stale snapshot can never roll progress back", () => {
  const tc = new TierClaim({ earned: 3, confirmed: 2 });
  tc.claimNext(); // tier 3 → cursor 3
  tc.sync({ earned: 1, confirmed: 1 }); // out-of-order / stale frame
  assert.equal(tc.pending, 0);
  assert.equal(tc.optimisticBonus, 1); // cursor 3, confirmed still 2
  assert.equal(tc.effectiveMax(7), 8);
});
