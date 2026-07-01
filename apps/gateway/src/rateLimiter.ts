/**
 * TokenBucket — a tiny per-connection inbound-message rate limiter (guardrail
 * G-I2 / F4).
 *
 * The gauge (D1) already caps how often a viewer can *successfully place*, but it
 * lives behind a Redis round-trip and only governs accepted placements. A hostile
 * or buggy client can still flood the socket with messages (malformed frames,
 * out-of-bounds places, pings) the gauge never sees — wasting CPU, Redis calls
 * and fan-out work. This bucket is the cheap, in-process first line: it bounds the
 * raw message rate per socket before any work is done, independent of whether a
 * message would have been accepted.
 *
 * Classic token bucket: `capacity` tokens, refilled continuously at
 * `refillPerSec`. Each inbound message costs one token; a message that finds the
 * bucket empty is dropped (the caller answers `rate_limited`). `capacity` is the
 * burst a client may send back-to-back; `refillPerSec` the sustained rate.
 *
 * Time is injected (`now`, epoch ms) so it is deterministic under test. Refill is
 * lazy — computed from elapsed time on each `tryRemove`, so there is no timer.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    nowMs: number,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = nowMs;
  }

  /**
   * Try to spend one token at time `nowMs`. Returns true if a token was available
   * (message allowed), false if the bucket was empty (message should be dropped).
   */
  tryRemove(nowMs: number): boolean {
    this.refill(nowMs);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  private refill(nowMs: number): void {
    const elapsedMs = nowMs - this.lastRefillMs;
    if (elapsedMs <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsedMs / 1000) * this.refillPerSec);
    this.lastRefillMs = nowMs;
  }
}
