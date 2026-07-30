/**
 * Unit tests for the stream-status transition logic (FEN-1868).
 *
 *   node --test apps/convex/convex/lib/twitchLive.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planStatusPatch } from "./twitchLive.ts";

const NOW = 9_000;

test("new row (null existing) → always write", () => {
  assert.deepEqual(planStatusPatch(null, true, 1000, NOW), {
    isLive: true,
    startedAt: 1000,
    updatedAt: NOW,
  });
  assert.deepEqual(planStatusPatch(null, false, undefined, NOW), {
    isLive: false,
    updatedAt: NOW,
  });
});

test("transition offline → live → write with startedAt", () => {
  assert.deepEqual(
    planStatusPatch({ isLive: false }, true, 2000, NOW),
    { isLive: true, startedAt: 2000, updatedAt: NOW },
  );
});

test("transition live → offline → write without startedAt", () => {
  assert.deepEqual(
    planStatusPatch({ isLive: true, startedAt: 2000 }, false, undefined, NOW),
    { isLive: false, updatedAt: NOW },
  );
});

test("same state live=live → null (no write, transition-only invariant)", () => {
  assert.equal(planStatusPatch({ isLive: true, startedAt: 2000 }, true, 2000, NOW), null);
});

test("same state offline=offline → null (no write)", () => {
  assert.equal(planStatusPatch({ isLive: false }, false, undefined, NOW), null);
});

test("going live without startedAt → write without startedAt field", () => {
  const p = planStatusPatch({ isLive: false }, true, undefined, NOW);
  assert.deepEqual(p, { isLive: true, updatedAt: NOW });
  assert.ok(p !== null && !("startedAt" in p));
});
