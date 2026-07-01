/**
 * FEN-1280 — Stress-test DRY-RUN (plan §5: répétition basse charge validant
 * l'instrumentation AVANT tout run prod).
 *
 * Stands up a real in-process Gateway backed by the Redis-less {@link createDryRunStack}
 * (faithful gauge + delta-publish emulation), then drives the production
 * {@link StressOrchestrator} against it at LOW charge. The point is NOT to load-test
 * anything — it is to prove, end-to-end and offline, that every measurement the
 * orchestrator will rely on in production actually fires:
 *
 *   - subscribe (snapshot received → whenReady resolves),
 *   - place → ack with measured ack latency,
 *   - DELTA propagation timed on a separate observer socket,
 *   - gauge cooldown honoured (small gauge + fast refill so it triggers quickly),
 *   - per-stage metric aggregation, SLO verdict, guard-rails, kill-switch,
 *   - report generation (markdown + JSON).
 *
 * Exit code 0 = instrumentation validated (ready for the gated prod run), 1 = a
 * required signal was missing, 2 = fatal error.
 *
 * Run:  pnpm --filter @canvas/gateway exec tsx load/stress-dryrun.ts
 * Tune: DRYRUN_GAUGE_MAX (default 5)  DRYRUN_REFILL_MS (default 1500)
 *       DRYRUN_HOLD_MS (default 4000)  WRITE_ARTIFACT=1 (write results/)
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GAUGE } from "@canvas/redis-scripts";
import { Gateway } from "../src/gateway";
import type { GatewayConfig } from "../src/config";
import { RedisPlacementHandler } from "../src/placement";
import { createDryRunStack } from "./dryrun-stack";
import { StressOrchestrator, generateReport, type RampStage } from "./stress-orchestrator";

const DEV_SECRET = process.env.DRYRUN_DEV_SECRET ?? "dryrun-stress-secret";
const CANVAS_ID = "loadtest-default";
const CANVAS_W = 256;
const CANVAS_H = 256;
// Small gauge + fast refill so the cooldown path is exercised quickly in a short run.
const GAUGE_MAX = Number(process.env.DRYRUN_GAUGE_MAX ?? 5);
const REFILL_MS = Number(process.env.DRYRUN_REFILL_MS ?? 1_500);
const HOLD_MS = Number(process.env.DRYRUN_HOLD_MS ?? 4_000);
const FLUSH_INTERVAL_MS = Number(process.env.DRYRUN_FLUSH_MS ?? 10);

async function main(): Promise<void> {
  console.log(`[dryrun] booting in-process gateway (canvas=${CANVAS_W}x${CANVAS_H}, gaugeMax=${GAUGE_MAX}, refill=${REFILL_MS}ms)`);

  const stack = createDryRunStack();
  // Seed an empty canvas snapshot so sendInitialState reads a clean seq=0 canvas.
  stack.seed(`canvas:${CANVAS_ID}:meta`, "0");
  stack.seed(`canvas:${CANVAS_ID}:pixels`, Buffer.alloc(CANVAS_W * CANVAS_H, 0));

  const cfg: GatewayConfig = {
    port: 0,
    redisUrl: "inproc://dryrun",
    canvasId: CANVAS_ID,
    width: CANVAS_W,
    height: CANVAS_H,
    flushIntervalMs: FLUSH_INTERVAL_MS,
    resyncBufferSize: 8192,
    presenceRefreshMs: 3_600_000,
    presenceTtlMs: 7_200_000,
    heartbeatMs: 3_600_000,
    instanceId: "dryrun-harness",
    // Not exercised offline (the dry-run drives only connect + place), but required
    // by GatewayConfig — give inert values so the literal stays type-complete.
    streamMaxLen: 1_000_000,
    attribution: { redirectUrl: "/", cookieMaxAgeSec: 0, cookieSecure: false },
    auth: { disabled: false, devSecret: DEV_SECRET },
    gauge: {
      base: { ...DEFAULT_GAUGE, gaugeMax: GAUGE_MAX, refillIntervalMs: REFILL_MS },
    },
    socket: { inboundBurst: 1_000_000, inboundRefillPerSec: 1_000_000 },
  };

  // Real placement handler, but the script-runner is our in-process emulator.
  const placement = new RedisPlacementHandler(stack.placeRunner, {
    width: CANVAS_W,
    height: CANVAS_H,
    paletteSize: 32,
    gauge: { ...DEFAULT_GAUGE, gaugeMax: GAUGE_MAX, refillIntervalMs: REFILL_MS },
    canvasId: CANVAS_ID,
  });

  const gateway = new Gateway(cfg, placement, stack.pair);
  await gateway.start();
  stack.fireReady();
  const port = gateway.boundPort;
  const wsUrl = `ws://127.0.0.1:${port}`;
  console.log(`[dryrun] gateway up on :${port}`);

  // Low-charge ramp: enough actors to exercise multi-actor aggregation + zones,
  // small enough to run in a few seconds offline.
  const stages: RampStage[] = [
    { label: "warmup-4", actors: 4, holdMs: HOLD_MS },
    { label: "ramp-12", actors: 12, holdMs: HOLD_MS },
  ];

  const orch = new StressOrchestrator({
    wsUrl,
    devSecret: DEV_SECRET,
    stages,
    activeFraction: 0.5, // higher fraction at low charge so we get plenty of samples fast
    zone: { x: 0, y: 0, w: 128, h: 128 },
    observerCount: 2,
    propagationSampleRate: 1, // sample every placement in the dry-run
    placeIntervalMs: 50,
    measureRecovery: true,
    dryRun: true,
  });

  const result = await orch.run();
  await gateway.stop();

  const { markdown, json } = generateReport(result);
  console.log("\n" + markdown + "\n");

  // ─── Validate the instrumentation actually fired ─────────────────────────────
  const totals = result.stages.reduce(
    (acc, s) => ({
      accepted: acc.accepted + s.accepted,
      ackSamples: acc.ackSamples + s.ack.samples,
      propSamples: acc.propSamples + s.prop.samples,
      cooldown: acc.cooldown + s.cooldown,
    }),
    { accepted: 0, ackSamples: 0, propSamples: 0, cooldown: 0 },
  );

  const checks: Array<{ name: string; pass: boolean; detail: string }> = [
    { name: "placements accepted", pass: totals.accepted > 0, detail: `${totals.accepted}` },
    { name: "ack latency sampled", pass: totals.ackSamples > 0, detail: `${totals.ackSamples}` },
    { name: "propagation sampled", pass: totals.propSamples > 0, detail: `${totals.propSamples}` },
    {
      name: "gauge cooldown exercised",
      pass: result.cooldownWaits.count > 0 || totals.cooldown > 0,
      detail: `${result.cooldownWaits.count} waits, ${totals.cooldown} rejects`,
    },
    { name: "report generated", pass: markdown.length > 0 && json.length > 0, detail: `${markdown.length}b md` },
    { name: "recovery measured", pass: result.recovery !== null, detail: result.recovery?.withinSlo ? "within SLO" : "see report" },
  ];

  console.log("═══ INSTRUMENTATION CHECKS ═══════════════════════════════════════");
  for (const c of checks) console.log(`  ${c.pass ? "✅" : "❌"} ${c.name.padEnd(28)} ${c.detail}`);

  if (process.env.WRITE_ARTIFACT === "1") {
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = join(here, "results");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stress-dryrun.md"), markdown);
    writeFileSync(join(dir, "stress-dryrun.json"), json);
    console.log(`\n[dryrun] artifacts written to ${dir}/stress-dryrun.{md,json}`);
  }

  const pass = checks.every((c) => c.pass);
  console.log(`\nDRY-RUN VERDICT: ${pass ? "PASS ✅ (instrumentation validated, ready for gated prod run)" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error("[dryrun] fatal:", err);
  process.exit(2);
});
