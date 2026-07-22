/**
 * Hot-path application of the F6 gauge-max upgrade (FEN-27).
 *
 * Layering (docs/contracts/points-gauge-upgrade.md § "Hot-path application"):
 * Convex is the durable source of truth for a user's purchased `gaugeMaxBonus`;
 * Convex never writes Redis. The gateway *applies* the bonus by folding it into
 * the effective gauge max it passes to the place-pixel script as `gaugeMax`
 * (`maxCharges`). The gauge hash in Redis stays `{ c, ts }` — no bonus is
 * persisted there.
 *
 * This module owns the gateway side of that contract:
 *   - resolve the durable bonus per session via `points.getGaugeBonus`,
 *   - cache it for the connection's lifetime,
 *   - expose the effective max the placement path (F5/FEN-15) passes to the Lua,
 *   - re-resolve on demand so a mid-session purchase takes effect (FEN-27 #3).
 *
 * It also owns the *charge-grant* half of the tier claim (Lot D / FEN-130): when
 * Convex confirms a claim it asks the gateway (over `/internal/gauge/claim`) to
 * hand the viewer the board-default +1 immediately-usable charge so the
 * celebration is actionable mid-cooldown. That is an atomic `grant.lua` call on
 * the live gauge hash; the gateway then pushes the post-grant `gauge` frame.
 */
import type Redis from "ioredis";
import {
  GRANT_LUA,
  grantArgs,
  parsePeekResult,
  peekArgs,
  REFILL_PEEK_LUA,
  type GaugeParams,
  type PeekResult,
} from "@canvas/redis-scripts";
import { effectiveGaugeMax } from "@canvas/points-rules";
import { evalShaCached, type CachedScript } from "./evalsha";

export { effectiveGaugeMax };

/** Resolves a user's durable gauge-max bonus for a given canvas. */
export interface GaugeBonusSource {
  /**
   * Purchased `gaugeMaxBonus` (≥ 0) for this user on this canvas, from Convex.
   * `canvasId` scopes the lookup (FEN-1616): the bonus is per-(user, canvas), so
   * the caller passes the CONNECTION's canvas, not a gateway-wide default.
   */
  getGaugeBonus(userId: string, canvasId: string): Promise<number>;
}

/**
 * Minimal structural view of a Convex client (`ConvexHttpClient.query`). Kept
 * structural so the gateway has no compile-time dependency on the `convex`
 * package; the concrete client is constructed at the entrypoint behind config.
 */
export interface ConvexQueryClient {
  query(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Reads the bonus from Convex `points.getGaugeBonus({ canvasId, userId })`.
 * The per-call `canvasId` (the connection's canvas) is authoritative (FEN-1616);
 * the constructor `defaultCanvasId` (from GATEWAY_CANVAS_ID) is only a fallback for
 * legacy single-canvas callers that don't pass one.
 */
export class ConvexGaugeBonusSource implements GaugeBonusSource {
  constructor(
    private readonly client: ConvexQueryClient,
    private readonly defaultCanvasId: string,
  ) {}

  async getGaugeBonus(userId: string, canvasId?: string): Promise<number> {
    const res = (await this.client.query("points:getGaugeBonus", {
      canvasId: canvasId ?? this.defaultCanvasId,
      userId,
    })) as { gaugeMaxBonus?: number } | null;
    return normalizeBonus(res?.gaugeMaxBonus);
  }
}

/**
 * Fixed-bonus source for local smoke (no Convex deployment) and tests. Defaults
 * to 0, i.e. every user gets the canvas base max — the correct, safe fallback.
 */
export class StaticGaugeBonusSource implements GaugeBonusSource {
  constructor(private readonly bonus = 0) {}
  async getGaugeBonus(_userId?: string, _canvasId?: string): Promise<number> {
    return normalizeBonus(this.bonus);
  }
}

/** Clamp to a non-negative finite integer; an absent/garbage value means 0. */
function normalizeBonus(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * Per-connection gauge resolution. Holds the last-resolved bonus and derives the
 * effective max the placement path passes to the script. Starts at the base max
 * (bonus 0) so a placement that races the initial resolve is never *over*-budgeted;
 * `refresh()` lifts it once Convex answers and again after a mid-session purchase.
 */
export class SessionGauge {
  private resolvedBonus = 0;

  constructor(
    private readonly source: GaugeBonusSource,
    /** Signed-in user id, or `null` for an anonymous read-only viewer (no bonus, never places). */
    private readonly userId: string | null,
    private readonly baseGaugeMax: number,
    /** The connection's canvas — scopes the bonus lookup per-(user, canvas) (FEN-1616). */
    private readonly canvasId: string,
  ) {}

  /** The user's currently-applied bonus (0 until the first successful refresh). */
  get bonus(): number {
    return this.resolvedBonus;
  }

  /** Effective max = base + bonus; this is what the placement path passes as `gaugeMax`. */
  get effectiveGaugeMax(): number {
    return effectiveGaugeMax(this.baseGaugeMax, this.resolvedBonus);
  }

  /**
   * Re-read the durable bonus from the source and cache it. On failure the last
   * known value is kept (a transient Convex blip must not silently drop a user's
   * paid-for ceiling), and the error is surfaced to the caller for logging.
   */
  async refresh(): Promise<number> {
    // Anonymous viewers never place, so there is no durable bonus to resolve —
    // and the Convex source only takes a real user id. Stay at base (bonus 0).
    if (this.userId === null) return this.resolvedBonus;
    this.resolvedBonus = await this.source.getGaugeBonus(this.userId, this.canvasId);
    return this.resolvedBonus;
  }
}

/**
 * Atomic "grant N charges" on a user's live gauge (tier claim, FEN-130). Injected
 * into the gateway so the claim seam is unit-tested without a server (the Lua
 * arithmetic itself is proven by the redis-scripts gauge unit + integration
 * tests), mirroring placement's PlaceScriptRunner / moderation's ModerationRedis.
 */
export interface GaugeGrantRunner {
  /**
   * Refill to `nowMs`, add `grant` charges, clamp to `gauge.gaugeMax` (the
   * EFFECTIVE max the caller already raised), persist, and return the post-grant
   * snapshot the gateway pushes as a `gauge` frame.
   */
  grant(
    userId: string,
    canvasId: string,
    gauge: GaugeParams,
    grant: number,
    nowMs: number,
  ): Promise<PeekResult>;
}

/**
 * ioredis-backed grant runner. Loads grant.lua once (SCRIPT LOAD) and runs it via
 * EVALSHA, reloading + retrying once on NOSCRIPT — same hot-path discipline as
 * the place/moderation runners.
 */
export class IoredisGaugeGrantRunner implements GaugeGrantRunner {
  private readonly script: CachedScript;

  constructor(cmd: Redis) {
    this.script = evalShaCached(cmd, GRANT_LUA);
  }

  async grant(
    userId: string,
    canvasId: string,
    gauge: GaugeParams,
    grant: number,
    nowMs: number,
  ): Promise<PeekResult> {
    const { keys, argv } = grantArgs({ nowMs, gauge, userId, grant, canvasId });
    return parsePeekResult(await this.script.run(keys, argv));
  }
}

/**
 * Read-only "what is this user's gauge right now" (refill-peek.lua). Injected like
 * {@link GaugeGrantRunner} so the seam is unit-testable without a server. Used to
 * push the INITIAL `gauge` frame on connect (FEN-184): the welcome frame implies
 * "ready" but carries no charge count, and the client's unified place-state gates
 * the canvas on a known gauge (`placeState.ts`: `gauge === null` ⇒ the indefinite
 * "loading"/"La fresque arrive…" state). Without this frame a fresh authenticated
 * session can never make its first placement — the only other way a gauge lands —
 * so the canvas deadlocks on loading. The peek is side-effect free (no consume, no
 * persist), so it is safe to run on every connect.
 */
export interface GaugePeekRunner {
  /** Current gauge snapshot after a virtual refill; never consumes or persists. */
  peek(userId: string, canvasId: string, gauge: GaugeParams, nowMs: number): Promise<PeekResult>;
}

/**
 * ioredis-backed peek runner. Loads refill-peek.lua once (SCRIPT LOAD) and runs it
 * via EVALSHA, reloading + retrying once on NOSCRIPT — same hot-path discipline as
 * the grant/place/moderation runners.
 */
export class IoredisGaugePeekRunner implements GaugePeekRunner {
  private readonly script: CachedScript;

  constructor(cmd: Redis) {
    this.script = evalShaCached(cmd, REFILL_PEEK_LUA);
  }

  async peek(userId: string, canvasId: string, gauge: GaugeParams, nowMs: number): Promise<PeekResult> {
    const { keys, argv } = peekArgs({ nowMs, gauge, userId, canvasId });
    return parsePeekResult(await this.script.run(keys, argv));
  }
}
