/**
 * Gateway configuration, parsed once from the environment. Defaults are tuned
 * for local `docker compose up`; the NAS deployment overrides via env/secrets.
 */
import { hostname } from "node:os";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "@canvas/protocol";
import { DEFAULT_GAUGE, num, bool, type GaugeParams } from "@canvas/redis-scripts";

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

  /**
   * Shared secret guarding the moderation internal routes (`POST /internal/{moderate,
   * ban,freeze,flush}`, F8/FEN-19). Convex sends it as `Authorization: Bearer`.
   * Unset → those routes are disabled (404) and moderation has no realtime effect
   * (Convex still records durable state — see moderation-internal.md).
   */
  internalSecret?: string;

  auth: AuthConfig;
  gauge: GaugeConfig;
  socket: SocketConfig;
  attribution: AttributionConfig;
}

/**
 * Outreach funnel attribution (FEN-242). The DM link `/r?ref=XYZ` counts a
 * visit, drops the `lp_ref` cookie and 302s to `redirectUrl`; the report route
 * `GET /r/report` reuses the moderation `internalSecret` as its Bearer guard.
 */
export interface AttributionConfig {
  /** Where `/r` sends the visitor after stamping the cookie (the public site). */
  redirectUrl: string;
  /** Lifetime of the `lp_ref` attribution cookie (covers response→signup lag). */
  cookieMaxAgeSec: number;
  /** Set the `Secure` cookie attribute (off only for local http smoke). */
  cookieSecure: boolean;
}

/**
 * Per-socket inbound rate limit (guardrail G-I2). A token bucket bounds the raw
 * message rate of a single connection before any work is done — orthogonal to
 * the gauge, which only caps accepted placements. Defaults are generous: normal
 * placing/panning is well under them; they only bite on a flood.
 */
export interface SocketConfig {
  /** Burst size: messages a socket may send back-to-back before throttling. */
  inboundBurst: number;
  /** Sustained refill rate in messages per second. */
  inboundRefillPerSec: number;
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
    internalSecret: process.env.GATEWAY_INTERNAL_SECRET || undefined,
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
    socket: {
      inboundBurst: num("SOCKET_INBOUND_BURST", 30),
      inboundRefillPerSec: num("SOCKET_INBOUND_REFILL_PER_SEC", 15),
    },
    attribution: {
      // PUBLIC_SITE_URL is the player-facing origin (e.g. https://liveplace.tv);
      // fall back to "/" so a misconfigured deploy still lands on the site root.
      redirectUrl: process.env.PUBLIC_SITE_URL || process.env.SITE_URL || "/",
      cookieMaxAgeSec: num("ATTRIBUTION_COOKIE_MAX_AGE_SEC", 30 * 24 * 60 * 60),
      cookieSecure: bool("ATTRIBUTION_COOKIE_SECURE", true),
    },
  };
}
