/**
 * Unit tests for the per-socket inbound rate limiter (../rateLimiter.ts, G-I2).
 * Time is injected so the token-bucket refill is deterministic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TokenBucket } from "../rateLimiter";

test("allows up to `capacity` messages back-to-back, then throttles", () => {
  const t0 = 1_000_000;
  const b = new TokenBucket(3, 1, t0); // burst 3, 1 msg/s
  assert.equal(b.tryRemove(t0), true);
  assert.equal(b.tryRemove(t0), true);
  assert.equal(b.tryRemove(t0), true);
  assert.equal(b.tryRemove(t0), false, "4th in the same instant is dropped");
});

test("refills at refillPerSec over elapsed time", () => {
  const t0 = 2_000_000;
  const b = new TokenBucket(5, 10, t0); // 10 tokens/s
  for (let i = 0; i < 5; i++) b.tryRemove(t0); // drain
  assert.equal(b.tryRemove(t0), false);
  // 200 ms later → 2 tokens back.
  assert.equal(b.tryRemove(t0 + 200), true);
  assert.equal(b.tryRemove(t0 + 200), true);
  assert.equal(b.tryRemove(t0 + 200), false);
});

test("refill never exceeds capacity", () => {
  const t0 = 3_000_000;
  const b = new TokenBucket(4, 100, t0);
  b.tryRemove(t0); // 3 left
  // A long idle gap would refill far past capacity — must clamp at 4, so exactly
  // 4 are then available.
  assert.equal(b.tryRemove(t0 + 10_000), true);
  assert.equal(b.tryRemove(t0 + 10_000), true);
  assert.equal(b.tryRemove(t0 + 10_000), true);
  assert.equal(b.tryRemove(t0 + 10_000), true);
  assert.equal(b.tryRemove(t0 + 10_000), false, "capacity is the ceiling, not capacity+refill");
});

test("a non-advancing/backwards clock does not add tokens", () => {
  const t0 = 4_000_000;
  const b = new TokenBucket(2, 1, t0);
  b.tryRemove(t0);
  b.tryRemove(t0);
  assert.equal(b.tryRemove(t0 - 5), false, "clock skew backwards must not refill");
});
