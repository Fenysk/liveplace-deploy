/**
 * Gateway configuration, parsed once from the environment. Defaults are tuned
 * for local `docker compose up`; the NAS deployment overrides via env/secrets.
 */
import { hostname } from "node:os";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "@canvas/protocol";
import { DEFAULT_GAUGE, type GaugeParams } from "@canvas/redis-scripts";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got "${raw}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export interface GatewayConfig {
  port: number;
  redisUrl: string;
  width: number;
  height: number;

  /**
   * Canvas id this gateway serves — the namespace for the per-canvas hot-path
   * Redis keys (`canvasKeys`, ADR-0003), fixed equal to the F2 `slug` and the
   * worker's drain target (ADR-0001). From GATEWAY_CANVAS_ID; falls back to
   * DEFAULT_CANVAS_ID for local single-canvas smoke.
   */
  canvasId?: string;

  /** ms between coalesced delta flushes to clients (fan-out cadence). */
  flushIntervalMs: number;
  /** in-memory ring buffer size for incremental resync (number of recent writes). */
  resyncBufferSize: number;

  /** ms between presence heartbeats (refresh own key + recompute global count). */
  presenceRefreshMs: number;
  /** TTL on the presence key; must exceed presenceRefreshMs so a live instance never expires. */
  presenceTtlMs: number;
  /** ms between WS keepalive pings; a socket that misses two is terminated. */
  heartbeatMs: number;

  /** Unique id for this gateway process (presence key + logs). */
  instanceId: string;

  auth: AuthConfig;
  gauge: GaugeConfig;
}

/**
 * Gauge / gauge-max-upgrade settings (D1 + F6). The `base` here is the canvas
 * base max with NO upgrade bonus; the gateway folds each user's purchased bonus
 * (read from Convex per session) on top to get the effective `gaugeMax` it
 * passes to place-pixel — see gaugeBonus.ts and the F6 contract.
 */
export interface GaugeConfig {
  /** Canvas-level gauge params; `gaugeMax` is the BASE max (bonus added per user). */
  base: GaugeParams;
  /** Convex deployment URL the gateway pulls the durable bonus from (F6). */
  convexUrl?: string;
  /** Convex `Id<"canvases">` this gateway serves; required to query the bonus. */
  canvasId?: string;
  /**
   * Shared secret guarding the in-session bonus-refresh endpoint
   * (`POST /internal/gauge/refresh`). Unset → the endpoint is disabled and a
   * mid-session purchase takes effect on the user's next reconnect (FEN-27 #3).
   */
  refreshSecret?: string;
}

export interface AuthConfig {
  /** Convex JWKS endpoint; offline verification caches keys from here. */
  jwksUrl?: string;
  /** Expected `iss` claim (optional). */
  issuer?: string;
  /** Expected `aud` claim (optional). */
  audience?: string;
  /** HS256 shared secret for LOCAL DEV ONLY (no Convex deployment needed). */
  devSecret?: string;
  /**
   * Disable auth entirely — LOCAL SMOKE ONLY. Every socket is accepted as an
   * anonymous user. Never set this on the NAS; CA3 requires rejecting bad JWTs.
   */
  disabled: boolean;
}

export function loadConfig(): GatewayConfig {
  const presenceRefreshMs = num("PRESENCE_REFRESH_MS", 5_000);
  const presenceTtlMs = num("PRESENCE_TTL_MS", Math.max(15_000, presenceRefreshMs * 3));

  return {
    port: num("GATEWAY_PORT", 8080),
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    width: num("CANVAS_WIDTH", CANVAS_WIDTH),
    height: num("CANVAS_HEIGHT", CANVAS_HEIGHT),
    canvasId: process.env.GATEWAY_CANVAS_ID || undefined,
    flushIntervalMs: num("FLUSH_INTERVAL_MS", 50),
    resyncBufferSize: num("RESYNC_BUFFER_SIZE", 8_192),
    presenceRefreshMs,
    presenceTtlMs,
    heartbeatMs: num("HEARTBEAT_MS", 30_000),
    instanceId: process.env.GATEWAY_INSTANCE_ID ?? `${hostname()}-${process.pid}`,
    auth: {
      jwksUrl: process.env.CONVEX_JWKS_URL || undefined,
      issuer: process.env.GATEWAY_JWT_ISSUER || undefined,
      audience: process.env.GATEWAY_JWT_AUDIENCE || undefined,
      devSecret: process.env.GATEWAY_DEV_JWT_SECRET || undefined,
      disabled: bool("GATEWAY_AUTH_DISABLED", false),
    },
    gauge: {
      base: {
        gaugeMax: num("GAUGE_MAX_BASE", DEFAULT_GAUGE.gaugeMax),
        refillAmount: num("GAUGE_REFILL_AMOUNT", DEFAULT_GAUGE.refillAmount),
        refillIntervalMs: num("GAUGE_REFILL_INTERVAL_MS", DEFAULT_GAUGE.refillIntervalMs),
        gaugeTtlMs: num("GAUGE_TTL_MS", DEFAULT_GAUGE.gaugeTtlMs),
      },
      convexUrl: process.env.CONVEX_URL || undefined,
      canvasId: process.env.GATEWAY_CANVAS_ID || undefined,
      refreshSecret: process.env.GATEWAY_GAUGE_REFRESH_SECRET || undefined,
    },
  };
}
