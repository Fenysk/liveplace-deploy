/**
 * Per-canvas geometry resolution (FEN-1762).
 *
 * The gateway used a single global `cfg.width/height` (512×512 env default) for
 * all canvases. After FEN-1712 canvases have durable dimensions [10,20,50,100];
 * using the wrong size corrupts offsets, snapshot sizes, and bounds guards.
 *
 * This module resolves and caches per-canvas dims from Convex
 * (`canvases:getCanvasDimsById`). It falls back to the env dims on any failure
 * so existing single-canvas deploys work unchanged.
 *
 * Design choices documented in docs/adr/0004-canvas-dimension-contract-512.md
 * (addendum: "per-canvas resolution in gateway").
 */

export interface CanvasDims {
  width: number;
  height: number;
}

/**
 * Async source for durable canvas dims.  A structural interface so the gateway
 * has no compile-time dependency on the `convex` package; the concrete client is
 * constructed at the entrypoint. Matches `ConvexQueryClient` in gaugeBonus.ts.
 */
export interface CanvasDimsQueryClient {
  query(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Timeout on a single Convex dims fetch (ms). Keeps the hot-path fast. */
const FETCH_TIMEOUT_MS = 3_000;
/**
 * How long a successfully resolved entry is considered fresh.
 * Kept short (30 s) so a canvas resize propagates quickly to new connections
 * even when the Convex-push invalidation (FEN-1790) is delayed or missing.
 */
const DIMS_TTL_MS = 30_000; // 30 seconds

interface CacheEntry {
  dims: CanvasDims;
  expiresAt: number;
}

/**
 * In-memory cache of per-canvas dims. Deduplicates concurrent resolves for the
 * same canvas and falls back to the env dims on failure or timeout. Injected
 * into Gateway so local tests run with a static fallback (no Convex).
 *
 * Implements `CanvasDimsProvider` so placement.ts can read dims synchronously
 * from the cache on the hot path (canvas is subscribed before any placement).
 */
export class CanvasDimsCache {
  private readonly cache = new Map<string, CacheEntry>();
  /** Inflight fetches, keyed by canvasId — deduplicate concurrent callers. */
  private readonly inflight = new Map<string, Promise<CanvasDims>>();

  constructor(
    /** Convex HTTP client; null = local smoke / tests (always returns fallback). */
    private readonly client: CanvasDimsQueryClient | null,
    /** Fallback dims (cfg.width / cfg.height from env). */
    readonly fallback: CanvasDims,
    private readonly ttlMs = DIMS_TTL_MS,
    private readonly clock = Date.now,
  ) {}

  /**
   * Resolve dims for a canvas. Returns a cached value when fresh. Deduplicates
   * concurrent fetches. On any failure (timeout, Convex error, row missing)
   * returns the env fallback — correctness degrades gracefully to the old
   * single-geometry behaviour.
   */
  async resolve(canvasId: string): Promise<CanvasDims> {
    const now = this.clock();
    const cached = this.cache.get(canvasId);
    if (cached && cached.expiresAt > now) return cached.dims;

    let inflight = this.inflight.get(canvasId);
    if (!inflight) {
      inflight = this._fetch(canvasId);
      this.inflight.set(canvasId, inflight);
      void inflight.finally(() => this.inflight.delete(canvasId));
    }
    return inflight;
  }

  /**
   * Synchronous read from cache. Returns the most recently resolved value, or
   * the env fallback if no successful fetch has completed yet.
   *
   * NOTE: on the security bounds-guard path use `getDimsIfReady` instead —
   * it returns `null` on cache miss so callers can fail-closed (FEN-1795).
   * This method is kept for non-security paths (moderation, initial state)
   * where a 512 fallback degrades gracefully.
   */
  getDimsOrFallback(canvasId: string): CanvasDims {
    return this.cache.get(canvasId)?.dims ?? this.fallback;
  }

  /**
   * Synchronous read from cache. Returns the resolved dims if present (fresh
   * or stale — both mean a prior successful Convex fetch), or `null` when the
   * cache has no entry at all (canvas never subscribed, or evicted by
   * `invalidate`).
   *
   * Use this on the placement bounds-guard path (FEN-1795): returning `null`
   * lets callers fail-closed and reject the placement instead of silently
   * widening the bounds to the env fallback (512), which would allow OOB
   * pixels on small canvases during the cold-connect window or a Convex outage.
   */
  getDimsIfReady(canvasId: string): CanvasDims | null {
    return this.cache.get(canvasId)?.dims ?? null;
  }

  /**
   * Evict a canvas's cached dims so the next `resolve` fetches fresh data from
   * Convex. Called when the new dims are not yet known locally — ensures new WS
   * connections see the updated geometry within milliseconds rather than waiting
   * for the TTL to expire (FEN-1790).
   *
   * WARNING: after this call `getDimsIfReady` returns `null`, which causes the
   * placement handler to reject with "canvas not ready" (FEN-1813). Prefer
   * `set()` when the new dims are already known (e.g. after an authoritative
   * gateway-driven resize).
   */
  invalidate(canvasId: string): void {
    this.cache.delete(canvasId);
  }

  /**
   * Forcibly populate the cache with known-good dims (e.g. after an
   * authoritative gateway-driven resize that already computed the new
   * geometry). Replaces any existing entry with a fresh TTL so
   * `getDimsIfReady` returns the new geometry immediately without opening a
   * null window that would reject in-flight placements (FEN-1813).
   */
  set(canvasId: string, dims: CanvasDims): void {
    this.cache.set(canvasId, { dims, expiresAt: this.clock() + this.ttlMs });
  }

  /**
   * Force a fresh Convex fetch, bypassing the TTL. Used by the placement handler
   * when a JS bounds check fails on a coordinate within the previous canvas size
   * but potentially within the new size (FEN-1813 scheduling gap: Convex mutation
   * commits and the client sees new dims immediately via reactivity, but
   * `notifyGatewayResize` — a `runAfter(0)` action — may not have fired yet,
   * leaving the gateway's cache stale). Shares the current inflight fetch if one
   * is already running; otherwise starts a new unconditional fetch.
   */
  async forceResolve(canvasId: string): Promise<CanvasDims> {
    if (!this.client) return this.fallback;
    let inflight = this.inflight.get(canvasId);
    if (!inflight) {
      inflight = this._fetch(canvasId);
      this.inflight.set(canvasId, inflight);
      void inflight.finally(() => this.inflight.delete(canvasId));
    }
    return inflight;
  }

  private async _fetch(canvasId: string): Promise<CanvasDims> {
    if (!this.client) return this.fallback;
    // Record the start time so we can detect a concurrent set() that arrived
    // while this Convex HTTP query was inflight (FEN-1813 race: handleGridResize
    // calls set() with new dims, then _fetch() completes with stale Convex data
    // and overwrites the fresh entry — causing out_of_bounds on the next placement).
    const fetchStartedAt = this.clock();
    try {
      const result = await Promise.race([
        this.client.query("canvases:getCanvasDimsById", { canvasId }),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error("dims fetch timeout")), FETCH_TIMEOUT_MS),
        ),
      ]);
      if (result && typeof result === "object") {
        const r = result as { width?: unknown; height?: unknown };
        const w = Number(r.width);
        const h = Number(r.height);
        if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) {
          const dims: CanvasDims = { width: Math.floor(w), height: Math.floor(h) };
          // Guard: skip overwriting if a set() call landed after this fetch started.
          // expiresAt - ttlMs ≈ when the entry was last written; if that timestamp
          // is after fetchStartedAt, the entry is more authoritative than our result
          // (e.g. handleGridResize already updated the cache with the new geometry).
          const existing = this.cache.get(canvasId);
          const entryWrittenAt = existing ? existing.expiresAt - this.ttlMs : -Infinity;
          if (!existing || entryWrittenAt <= fetchStartedAt) {
            this.cache.set(canvasId, { dims, expiresAt: this.clock() + this.ttlMs });
          }
          return dims;
        }
      }
    } catch {
      // Swallow — return stale or fallback below.
    }
    // Use a stale cached entry over the fallback if available (canvas resize is rare).
    const stale = this.cache.get(canvasId);
    if (stale) return stale.dims;
    return this.fallback;
  }
}

/** Synchronous dims provider injected into the placement handler (hot path). */
export interface CanvasDimsProvider {
  getDimsOrFallback(canvasId: string): CanvasDims;
  /**
   * Returns resolved dims if the canvas is already in cache, or `null` if no
   * successful fetch has completed yet. Used on the security bounds-guard path
   * (FEN-1795) to fail-closed rather than widening bounds to the env fallback.
   */
  getDimsIfReady(canvasId: string): CanvasDims | null;
  /**
   * Optional: force-fetch from Convex, bypassing the TTL. Only present on
   * providers backed by a Convex client (i.e. `CanvasDimsCache` with a real
   * client). The placement handler calls this on the out_of_bounds path to
   * self-heal stale dims after a resize (FEN-1813 scheduling gap).
   */
  forceResolve?(canvasId: string): Promise<CanvasDims>;
}
