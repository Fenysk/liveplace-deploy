/**
 * @canvas/gateway entrypoint — the realtime WebSocket gateway (F7/FEN-13).
 *
 * Run with `pnpm --filter @canvas/gateway start` (or via docker compose). It
 * connects to Redis, subscribes to the delta channel, and serves the live pixel
 * stream to web + OBS clients. Business placement validation is F4/F5.
 */
import { loadConfig, type GatewayConfig } from "./config";
import { Gateway } from "./gateway";
import {
  ConvexGaugeBonusSource,
  StaticGaugeBonusSource,
  type GaugeBonusSource,
} from "./gaugeBonus";

/**
 * Build the F6 gauge-bonus source. With a Convex deployment configured
 * (`CONVEX_URL` + `GATEWAY_CANVAS_ID`) the gateway pulls each user's durable
 * `gaugeMaxBonus` from `points.getGaugeBonus`. Otherwise (local smoke) everyone
 * gets the canvas base max. The `convex` client is imported dynamically via a
 * non-literal specifier so the gateway carries no compile-time dependency on it.
 */
async function createBonusSource(cfg: GatewayConfig): Promise<GaugeBonusSource> {
  const { convexUrl, canvasId } = cfg.gauge;
  if (!convexUrl || !canvasId) {
    console.warn(
      "[gateway] CONVEX_URL/GATEWAY_CANVAS_ID not set — gauge-max bonus disabled, " +
        "every user gets the canvas base max (local smoke only).",
    );
    return new StaticGaugeBonusSource(0);
  }
  const spec = "convex/browser";
  const mod = (await import(spec)) as { ConvexHttpClient: new (url: string) => { query: (n: string, a: Record<string, unknown>) => Promise<unknown> } };
  const client = new mod.ConvexHttpClient(convexUrl);
  console.log(`[gateway] gauge-max bonus enabled via Convex (${convexUrl}, canvas ${canvasId})`);
  return new ConvexGaugeBonusSource(client, canvasId);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const bonusSource = await createBonusSource(cfg);
  const gateway = new Gateway(cfg, undefined, undefined, bonusSource);
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
