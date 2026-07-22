/**
 * @canvas/gateway entrypoint — the realtime WebSocket gateway (F7/FEN-13).
 *
 * Run with `pnpm --filter @canvas/gateway start` (or via docker compose). It
 * connects to Redis, subscribes to the delta channel, and serves the live pixel
 * stream to web + OBS clients. Business placement validation is F4/F5.
 */
import { PALETTE_SIZE } from "@canvas/protocol";
import { loadConfig, type GatewayConfig } from "./config";
import { Gateway } from "./gateway";
import { createRedisPair } from "./redis";
import { IoredisPlaceRunner, RedisPlacementHandler } from "./placement";
import {
  ConvexGaugeBonusSource,
  StaticGaugeBonusSource,
  type GaugeBonusSource,
} from "./gaugeBonus";
import { CanvasDimsCache, type CanvasDimsQueryClient } from "./canvasDims";

type ConvexHttpClientT = CanvasDimsQueryClient & { query: (n: string, a: Record<string, unknown>) => Promise<unknown> };

/**
 * Lazily import the Convex browser client and return a typed instance.
 * Uses a non-literal specifier so the gateway carries no compile-time
 * dependency on the `convex` package (same pattern as the bonus source).
 */
async function createConvexClient(convexUrl: string): Promise<ConvexHttpClientT> {
  const spec = "convex/browser";
  const mod = (await import(spec)) as {
    ConvexHttpClient: new (url: string, opts?: { skipConvexDeploymentUrlCheck?: boolean }) => ConvexHttpClientT;
  };
  // Self-hosted URL won't match *.convex.cloud — skip the check, same as the worker.
  return new mod.ConvexHttpClient(convexUrl, { skipConvexDeploymentUrlCheck: true });
}

/**
 * Build the F6 gauge-bonus source. With a Convex deployment configured
 * (`CONVEX_URL` + `GATEWAY_CANVAS_ID`) the gateway pulls each user's durable
 * `gaugeMaxBonus` from `points.getGaugeBonus`. Otherwise (local smoke) everyone
 * gets the canvas base max.
 */
async function createBonusSource(cfg: GatewayConfig, client: ConvexHttpClientT | null): Promise<GaugeBonusSource> {
  const { convexUrl, canvasId } = cfg.gauge;
  if (!client || !convexUrl || !canvasId) {
    console.warn(
      "[gateway] CONVEX_URL/GATEWAY_CANVAS_ID not set — gauge-max bonus disabled, " +
        "every user gets the canvas base max (local smoke only).",
    );
    return new StaticGaugeBonusSource(0);
  }
  console.log(`[gateway] gauge-max bonus enabled via Convex (${convexUrl}, canvas ${canvasId})`);
  return new ConvexGaugeBonusSource(client, canvasId);
}

/**
 * Build the per-canvas dims cache (FEN-1762). Shares the same Convex client
 * as the bonus source; returns a static fallback cache when Convex is not
 * configured (local smoke / tests).
 */
function createDimsCache(cfg: GatewayConfig, client: ConvexHttpClientT | null): CanvasDimsCache {
  const fallback = { width: cfg.width, height: cfg.height };
  if (!client || !cfg.gauge.convexUrl) {
    console.warn("[gateway] CONVEX_URL not set — per-canvas dims disabled, using env geometry for all canvases.");
    return new CanvasDimsCache(null, fallback);
  }
  console.log(`[gateway] per-canvas dims enabled via Convex (${cfg.gauge.convexUrl})`);
  return new CanvasDimsCache(client, fallback);
}

async function main(): Promise<void> {
  const cfg = loadConfig();

  // One shared Convex client for both gauge bonuses and per-canvas dims (FEN-1762).
  const convexClient = cfg.gauge.convexUrl ? await createConvexClient(cfg.gauge.convexUrl) : null;
  const bonusSource = await createBonusSource(cfg, convexClient);
  const dimsCache = createDimsCache(cfg, convexClient);

  // Compose the real F5 placement path here (the gateway's default is the
  // safe rejecting handler). It owns the Redis command connection so the
  // gateway and place.lua share one client; place.lua is EVALSHA-cached.
  const redis = createRedisPair(cfg.redisUrl);
  const placement = new RedisPlacementHandler(new IoredisPlaceRunner(redis.cmd), {
    width: cfg.width,
    height: cfg.height,
    paletteSize: PALETTE_SIZE,
    gauge: cfg.gauge.base,
    // Bounded backstop on the durable stream so the firehose can't blow Redis
    // memory while the worker is down (FEN-651/A8, docs/contracts/retention.md).
    streamMaxLen: cfg.streamMaxLen,
    // Per-canvas bounds guard — handlePlace reads conn.canvasId for the namespace.
    dimsProvider: dimsCache,
  });

  const gateway = new Gateway(cfg, placement, redis, bonusSource, dimsCache);
  await gateway.start();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[gateway] ${signal} received, shutting down`);
    gateway
      .stop()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error("[gateway] error during shutdown:", err);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[gateway] fatal:", err);
  process.exit(1);
});
