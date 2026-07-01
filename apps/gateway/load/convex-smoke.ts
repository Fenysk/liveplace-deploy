/**
 * FEN-1278 — Convex stress-test smoke test (1 actor + 1 observer).
 *
 * Proves subscribe + place + metrics with the smallest possible setup:
 *   - Observer connects first and subscribes to canvas state (snapshot).
 *   - Actor connects, waits for snapshot, then places pixels respecting the D1
 *     gauge cooldown. Each placement is measured end-to-end.
 *   - After each accepted placement, propagation latency is measured by timing
 *     how long the observer takes to see the matching DELTA frame.
 *   - Metrics are printed on exit, including ack latency, propagation latency,
 *     gauge history, and pixel-lost count.
 *
 * ─── Minimal env setup ───────────────────────────────────────────────────────
 *
 *   # Mode A — auth disabled (no JWT, shared gauge):
 *   GATEWAY_AUTH_DISABLED=1
 *   GATEWAY_CANVAS_ID=loadtest-default
 *
 *   # Mode B — HS256 dev tokens (isolated per-user gauge, recommended):
 *   GATEWAY_DEV_JWT_SECRET=my-dev-secret
 *   GATEWAY_CANVAS_ID=loadtest-default
 *
 *   # Both modes: target a disposable test canvas, not prod.
 *
 * ─── Run ─────────────────────────────────────────────────────────────────────
 *
 *   pnpm --filter @canvas/gateway exec tsx load/convex-smoke.ts
 *
 * ─── Tune ────────────────────────────────────────────────────────────────────
 *
 *   MAX_PLACEMENTS=5           # pixels to place (default: 5; gauge refill means waits)
 *   WS_URL=ws://localhost:8080 # gateway endpoint (default: ws://localhost:8080)
 *   DEV_SECRET=<secret>        # GATEWAY_DEV_JWT_SECRET value (Mode B)
 *   PLACEMENT_ZONE=0,0,64,64   # "x,y,w,h" restrict placements to a zone
 *   PROPAGATION_TIMEOUT_MS=3000
 */

import { StressClient, mintTestToken, pctSummary, type PlacementRecord } from "./convex-stress";

// ─── Config ───────────────────────────────────────────────────────────────────

const WS_URL = process.env.WS_URL ?? "ws://localhost:8080";
const DEV_SECRET = process.env.DEV_SECRET;
const MAX_PLACEMENTS = Number(process.env.MAX_PLACEMENTS ?? 5);
const PROPAGATION_TIMEOUT_MS = Number(process.env.PROPAGATION_TIMEOUT_MS ?? 3_000);
const CONNECT_TIMEOUT_MS = 10_000;

function parseZone(s: string | undefined) {
  if (!s) return undefined;
  const [x, y, w, h] = s.split(",").map(Number);
  if ([x, y, w, h].some((v) => v === undefined || !Number.isFinite(v) || v < 0)) return undefined;
  return { x: x!, y: y!, w: w!, h: h! };
}

const ZONE = parseZone(process.env.PLACEMENT_ZONE);

// ─── Colour palette (indices 1–31 are valid placed colours; 0 is white/eraser) ─

const COLORS = [5, 10, 12, 8, 14]; // red, green, blue, yellow, purple — cycling

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[smoke] WS_URL=${WS_URL}  MAX_PLACEMENTS=${MAX_PLACEMENTS}  mode=${DEV_SECRET ? "HS256 dev-token" : "anon"}`);

  // Mint tokens if running in Mode B (GATEWAY_DEV_JWT_SECRET).
  const actorToken = DEV_SECRET ? await mintTestToken("loadtest:user:smoke-actor", DEV_SECRET) : undefined;
  // Observer is always anonymous — we only need it to watch incoming deltas.
  const observerToken = DEV_SECRET ? await mintTestToken("loadtest:user:smoke-observer", DEV_SECRET) : undefined;

  const actor = new StressClient({
    wsUrl: WS_URL,
    userId: "loadtest:user:smoke-actor",
    token: actorToken,
    placementZone: ZONE,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
  });

  const observer = new StressClient({
    wsUrl: WS_URL,
    userId: "loadtest:user:smoke-observer",
    token: observerToken,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
  });

  // Connect both in parallel.
  console.log("[smoke] connecting actor + observer ...");
  await Promise.all([actor.connect(), observer.connect()]);
  console.log("[smoke] connected. waiting for canvas snapshots ...");

  // Wait for both to receive the initial snapshot (canvas subscribed).
  await Promise.all([actor.whenReady, observer.whenReady]);
  console.log("[smoke] both clients subscribed. starting placements ...\n");

  const acceptedRecords: PlacementRecord[] = [];

  for (let i = 0; i < MAX_PLACEMENTS; i++) {
    const coord = actor.randomCoord();
    const color = COLORS[i % COLORS.length]!;

    // Register the propagation watcher on the observer BEFORE sending the place,
    // so no delta is missed in the window between place and watcher setup.
    const propPromise = observer.awaitDelta(coord.x, coord.y, color, PROPAGATION_TIMEOUT_MS);

    const record = await actor.place(coord.x, coord.y, color);

    if (record.outcome === "ack") {
      const observedAt = await propPromise;
      if (observedAt !== null) {
        record.propagationMs = observedAt - record.sentAtMs;
        console.log(
          `[smoke] #${i + 1}  (${coord.x},${coord.y}) c=${color}  ` +
            `ack=${record.ackLatencyMs}ms  prop=${record.propagationMs}ms  ✓`,
        );
      } else {
        console.log(
          `[smoke] #${i + 1}  (${coord.x},${coord.y}) c=${color}  ` +
            `ack=${record.ackLatencyMs}ms  prop=TIMEOUT ⚠ (pixel lost)`,
        );
      }
      acceptedRecords.push(record);
    } else if (record.outcome === "cooldown") {
      // Gauge empty — actor.place() already waited for cooldownUntil before returning.
      // Decrement i so this attempt doesn't count against MAX_PLACEMENTS.
      console.log(`[smoke] #${i + 1}  cooldown (gauge empty, retrying) ...`);
      i--;
      await propPromise; // discard watcher
    } else {
      console.log(`[smoke] #${i + 1}  outcome=${record.outcome}  (x=${coord.x} y=${coord.y})`);
      await propPromise; // discard watcher
    }
  }

  // ─── Metrics summary ─────────────────────────────────────────────────────────

  const actorMetrics = actor.collectMetrics();

  const ackLats = acceptedRecords.map((r) => r.ackLatencyMs!);
  const propLats = acceptedRecords.map((r) => r.propagationMs).filter((v): v is number => v !== undefined);
  const lostCount = acceptedRecords.filter((r) => r.propagationMs === undefined).length;

  console.log("\n═══ SMOKE RESULT ═══════════════════════════════════════════════");
  console.log(`attempted : ${actorMetrics.placementsAttempted}`);
  console.log(`accepted  : ${actorMetrics.placementsAccepted}`);
  console.log(`cooldown  : ${actorMetrics.placementsCooldown}`);
  console.log(`other err : ${actorMetrics.placementsOther}`);
  console.log(`pixels lost (no propagation observed): ${lostCount}`);

  if (ackLats.length > 0) {
    const ackS = pctSummary(ackLats);
    console.log(`\nAck latency (place→ack, ms):`);
    console.log(`  min=${ackS.min}  p50=${ackS.p50}  p95=${ackS.p95}  p99=${ackS.p99}  max=${ackS.max}  mean=${ackS.mean}  n=${ackS.samples}`);
  }

  if (propLats.length > 0) {
    const propS = pctSummary(propLats);
    console.log(`\nPropagation latency (place→delta on observer, ms):`);
    console.log(`  min=${propS.min}  p50=${propS.p50}  p95=${propS.p95}  p99=${propS.p99}  max=${propS.max}  mean=${propS.mean}  n=${propS.samples}`);
  } else {
    console.log(`\nPropagation: no samples (check observer socket or propagation timeout)`);
  }

  if (actorMetrics.cooldownWaitsMs.length > 0) {
    const waitS = pctSummary(actorMetrics.cooldownWaitsMs);
    console.log(`\nCooldown waits (ms):`);
    console.log(`  count=${waitS.samples}  min=${waitS.min}  mean=${waitS.mean}  max=${waitS.max}`);
  }

  const gaugeReadings = actorMetrics.gaugeHistory;
  if (gaugeReadings.length > 0) {
    const last = gaugeReadings[gaugeReadings.length - 1]!;
    console.log(`\nGauge (final): charges=${last.charges}/${last.max}  cooldownUntil=${last.cooldownUntil}`);
  }

  console.log("\n═══ JSON METRICS ════════════════════════════════════════════════");
  console.log(
    JSON.stringify({
      actorMetrics: {
        userId: actorMetrics.userId,
        sessionDurationMs: actorMetrics.sessionDurationMs,
        placementsAttempted: actorMetrics.placementsAttempted,
        placementsAccepted: actorMetrics.placementsAccepted,
        placementsCooldown: actorMetrics.placementsCooldown,
        placementsOther: actorMetrics.placementsOther,
        pixelsLost: lostCount,
        ackLatency: pctSummary(ackLats),
        propagation: pctSummary(propLats),
        cooldownWaitsMs: actorMetrics.cooldownWaitsMs,
        gaugeHistory: actorMetrics.gaugeHistory,
      },
    }),
  );

  const pass = lostCount === 0 && actorMetrics.placementsAccepted === MAX_PLACEMENTS;
  console.log(`\nVERDICT: ${pass ? "PASS ✅" : "PARTIAL / CHECK ABOVE ⚠"}`);

  actor.close();
  observer.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("[smoke] fatal:", err);
  process.exit(2);
});
