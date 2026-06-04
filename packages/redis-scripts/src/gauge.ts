/**
 * @canvas/redis-scripts/gauge — the pixel gauge (token bucket) per **decision D1**.
 *
 * This module is the single, unit-tested TypeScript source of truth for the
 * lazy-refill arithmetic. The two Lua scripts (`place.lua`, `refill-peek.lua`)
 * are a line-by-line mirror of {@link refillGauge}; keep them in sync. The Lua
 * is the *atomic authority* on the hot path (it runs inside Redis, single
 * threaded, so refill→check→consume cannot interleave — mitigation for R1).
 * This TS copy exists so the math is testable without Redis and so the gateway
 * can predict the gauge client-side between WS frames.
 *
 * D1 defaults (canvas-level, owner-overridable):
 *   gaugeMaxBase      = 20      pixels of burst reserve before bonus
 *   refillAmount      = 1       charges granted per tick
 *   refillIntervalSec = 30      one tick → 1 charge / 30 s in steady state
 *   init              = full    a viewer's first placement starts at the max
 *   eraser (color 0)  costs 1   same as a coloured placement
 *
 * **Effective max layering (decision D1 §1.3 + F6 contract).** This module is
 * told the *effective* max (`gaugeMax`) — already `base + upgrade bonus`. The
 * bonus is owned by Convex (points/upgrade, F6) and the gateway resolves it per
 * session via `points.getGaugeBonus`, computing `effectiveGaugeMax(base, bonus)`
 * and passing the result in. Convex never writes Redis; the gauge hash here
 * stays `{ c, ts }`. Raising the bonus lifts the ceiling immediately (D1 CA3) as
 * soon as the gateway passes the new max — no Redis schema for the bonus.
 */

export interface GaugeParams {
  /**
   * Effective gauge maximum for this call = canvas base + the user's upgrade
   * bonus (F6). The caller (gateway) computes the sum; this module just clamps
   * to it. DEFAULT_GAUGE uses the D1 base (20) with no bonus.
   */
  gaugeMax: number;
  /** Charges granted per refill tick (D1 `refillAmount`, default 1). */
  refillAmount: number;
  /** Length of one refill tick in ms (D1 `refillIntervalSec` × 1000, default 30 000). */
  refillIntervalMs: number;
  /** TTL (ms) applied to the gauge hash to reclaim idle viewers; 0 = never expire. */
  gaugeTtlMs: number;
}

/** D1 defaults for a brand-new canvas with no upgrade bonus. */
export const DEFAULT_GAUGE: GaugeParams = {
  gaugeMax: 20,
  refillAmount: 1,
  refillIntervalMs: 30_000,
  gaugeTtlMs: 24 * 60 * 60 * 1000,
};

/** Raw, persisted gauge as stored in the Redis hash (null = never placed). */
export interface StoredGauge {
  /** Charges remaining at the last touch. */
  charges: number;
  /** Refill clock: epoch ms of the last counted tick boundary. */
  ts: number;
}

/** Gauge after a lazy refill, ready to display or consume from. */
export interface GaugeState {
  /** Current charges (post-refill), clamped to [0, max]. */
  charges: number;
  /** Effective maximum in force this call. */
  max: number;
  /** Refill clock after this refill. */
  ts: number;
}

/**
 * Lazy token-bucket refill. **This is the canonical algorithm the Lua mirrors.**
 *
 * - First contact (`stored == null`): the viewer starts full at the effective
 *   max (D1 "init à la max à la première pose").
 * - Otherwise: grant `floor(elapsed / interval) * amount` charges, capped at the
 *   effective max, advancing the clock by whole ticks only so the sub-tick
 *   remainder is preserved across calls (correct cumulative refill, D1 CA4).
 * - When the gauge is full the refill clock is pinned to `now`: being full
 *   "pauses" regeneration, so the next charge after a consume is a *full*
 *   interval away rather than arriving early from leftover elapsed time.
 *
 * Pure and side-effect free; `nowMs` is injected so it is deterministic.
 */
export function refillGauge(
  stored: StoredGauge | null,
  nowMs: number,
  params: GaugeParams,
): GaugeState {
  const max = params.gaugeMax;

  if (stored === null) {
    // Never placed → arrive full. The clock starts now.
    return { charges: max, max, ts: nowMs };
  }

  let charges = stored.charges;
  let ts = stored.ts;

  let elapsed = nowMs - ts;
  if (elapsed < 0) elapsed = 0; // guard against clock skew / replay

  const ticks = Math.floor(elapsed / params.refillIntervalMs);
  if (ticks > 0) {
    charges = Math.min(max, charges + ticks * params.refillAmount);
    ts = ts + ticks * params.refillIntervalMs; // advance by whole ticks; keep remainder
  }

  // Full → regeneration is paused; pin the clock to now (D1 CA2: never exceed max).
  if (charges >= max) {
    charges = max;
    ts = nowMs;
  }

  return { charges, max, ts };
}

/**
 * Grant `grant` extra charges to a gauge after a lazy refill (tier claim, Lot D
 * / FEN-130). **This is the canonical algorithm grant.lua mirrors** — keep them
 * in sync, exactly as place.lua/refill-peek.lua mirror {@link refillGauge}.
 *
 * Order matters: refill to `now` first (so the grant lands on top of the current
 * earned balance, never replacing it), then add `grant`, clamped to the
 * effective `max`. `max` here is the *raised* max — the gateway resolves the new
 * `base + bonus` after the claim bumped `gaugeMaxBonus`, so a claim that lifts a
 * full gauge's ceiling also makes room for the granted charge.
 *
 * - A never-placed gauge (`stored == null`) is conceptually full at the raised
 *   max; the grant is clamped away, but the returned state materialises the gauge
 *   so the new ceiling/charge persist (grant.lua writes the hash too).
 * - `grant ≤ 0` is a pure refill (a harmless no-op on charges) — the no-op claim
 *   path never reaches here, but it stays well-defined.
 *
 * Pure and side-effect free; `nowMs` is injected so it is deterministic.
 */
export function grantCharges(
  stored: StoredGauge | null,
  nowMs: number,
  grant: number,
  params: GaugeParams,
): GaugeState {
  const add = Number.isFinite(grant) && grant > 0 ? grant : 0;
  const refilled = refillGauge(stored, nowMs, params);
  const max = params.gaugeMax;

  let charges = Math.min(max, refilled.charges + add);
  let ts = refilled.ts;
  // Full → pause regeneration (same rule as the refill / place.lua).
  if (charges >= max) {
    charges = max;
    ts = nowMs;
  }
  return { charges, max, ts };
}

/**
 * Epoch ms at which the next charge lands, or 0 when the gauge is full.
 * Drives the client countdown ("compte à rebours") and the F4 cooldown gate.
 */
export function nextRefillAt(state: GaugeState, params: GaugeParams): number {
  if (state.charges >= state.max) return 0;
  return state.ts + params.refillIntervalMs;
}
