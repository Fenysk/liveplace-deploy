/**
 * FEN-50 [F7/CA1] fan-out load proof.
 *
 * Drives up to 1 000 real WebSocket clients against a real Gateway, places ONE
 * pixel, and proves the CA1 invariant: every connected socket receives exactly
 * one DELTA frame carrying that write's seq, with ZERO per-socket DB read on the
 * fan-out path and ONE delta subscription regardless of socket count.
 *
 * Redis is substituted by an instrumented in-process double (see
 * instrumentedRedis.ts) so we can observe the exact command stream and assert it
 * stays flat as the socket count climbs. The fan-out loop (Gateway.flush) and the
 * WebSocket sockets are the real gateway code.
 *
 * Run:  pnpm --filter @canvas/gateway exec tsx load/fanout-load.ts
 * Tune: LOAD_PLATEAUS=1,10,100,1000  LOAD_ROUNDS=3  FLUSH_INTERVAL_MS=10
 */
import { WebSocket } from "ws";
import { OP_DELTA, OP_SNAPSHOT } from "@canvas/protocol";
import { DEFAULT_GAUGE, canvasDeltaChannel, canvasKeys } from "@canvas/redis-scripts";
import { Gateway } from "../src/gateway";
import type { GatewayConfig } from "../src/config";
import { createInstrumentedRedis, type CommandCounts } from "./instrumentedRedis";

const PLATEAUS = (process.env.LOAD_PLATEAUS ?? "1,10,50,100,250,500,1000")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const ROUNDS = Number(process.env.LOAD_ROUNDS ?? 3);
const FLUSH_INTERVAL_MS = Number(process.env.FLUSH_INTERVAL_MS ?? 10);
const CANVAS_W = 64;
const CANVAS_H = 64;
const CONNECT_BATCH = 100;
const ROUND_TIMEOUT_MS = 10_000;

const ns = () => process.hrtime.bigint();
const msSince = (t0: bigint) => Number(ns() - t0) / 1e6;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)]!;
}

/** One synthetic WS client. Records every DELTA frame's seq + receive time. */
class Client {
  readonly ws: WebSocket;
  private ready!: () => void;
  readonly whenReady: Promise<void>;
  private waitingSeq: number | null = null;
  private waiter: ((tNs: bigint) => void) | null = null;
  sawSnapshot = false;
  deltaFrames = 0;

  constructor(url: string) {
    this.ws = new WebSocket(url, { perMessageDeflate: false });
    this.whenReady = new Promise((res) => (this.ready = res));
    this.ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return; // welcome / viewerCount JSON — ignore
      const op = data[0];
      if (op === OP_SNAPSHOT) {
        if (!this.sawSnapshot) {
          this.sawSnapshot = true;
          this.ready();
        }
        return;
      }
      if (op === OP_DELTA) {
        this.deltaFrames++;
        const seq = data.readUInt32BE(1);
        const t = ns();
        if (this.waitingSeq !== null && seq === this.waitingSeq && this.waiter) {
          const w = this.waiter;
          this.waiter = null;
          this.waitingSeq = null;
          w(t);
        }
      }
    });
  }

  /** Resolve with this client's receive timestamp once it observes `seq`. */
  awaitSeq(seq: number): Promise<bigint> {
    return new Promise((res) => {
      this.waitingSeq = seq;
      this.waiter = res;
    });
  }

  close(): void {
    this.ws.removeAllListeners();
    this.ws.terminate();
  }
}

interface PlateauResult {
  sockets: number;
  connectMs: number;
  received: number;
  missing: number;
  extraDeltaFrames: number;
  subscribeCalls: number;
  deltaPathCmdDelta: number; // total Redis cmds caused by the one fan-out round
  deltaPathCmdNames: Record<string, number>;
  latency: { min: number; p50: number; p95: number; p99: number; max: number; mean: number; samples: number };
  /**
   * Server-side fan-out cost, isolated from single-process client contention:
   * firstByteMs = publish→first client receives (≈ flush interval + dispatch);
   * spreadMs   = first client receives → last client receives (the broadcast
   * loop's serialization cost across N sockets). Averaged over the rounds.
   */
  firstByteMs: number;
  spreadMs: number;
  rssMb: number;
  heapMb: number;
}

function diffCounts(before: CommandCounts, after: CommandCounts): { total: number; names: Record<string, number> } {
  const names: Record<string, number> = {};
  for (const k of new Set([...Object.keys(before.byName), ...Object.keys(after.byName)])) {
    const d = (after.byName[k] ?? 0) - (before.byName[k] ?? 0);
    if (d !== 0) names[k] = d;
  }
  return { total: after.total - before.total, names };
}

async function main(): Promise<void> {
  const CANVAS_ID = "default"; // DEFAULT_CANVAS_ID — per-canvas keys are canvas:default:*
  const redis = createInstrumentedRedis();
  // Seed an empty canvas snapshot (namespaced keys, ADR-0003) so sendInitialState
  // reads a clean seq=0 canvas. Missing keys read as zero-filled anyway.
  const ck = canvasKeys(CANVAS_ID);
  redis.seed(ck.meta, "0");
  redis.seed(ck.pixels, Buffer.alloc(CANVAS_W * CANVAS_H, 0));

  const cfg: GatewayConfig = {
    port: 0,
    redisUrl: "inproc://instrumented",
    canvasId: CANVAS_ID,
    width: CANVAS_W,
    height: CANVAS_H,
    flushIntervalMs: FLUSH_INTERVAL_MS,
    resyncBufferSize: 8192,
    // Disable background presence/heartbeat during the test so the per-delta
    // command diff isolates the fan-out path (presence is O(1)/instance anyway).
    presenceRefreshMs: 3_600_000,
    presenceTtlMs: 7_200_000,
    heartbeatMs: 3_600_000,
    instanceId: "load-harness",
    // Not exercised by this fan-out proof (clients are receive-only), but required
    // by GatewayConfig — inert values keep the literal type-complete.
    streamMaxLen: 1_000_000,
    attribution: { redirectUrl: "/", cookieMaxAgeSec: 0, cookieSecure: false },
    auth: { disabled: true },
    gauge: {
      base: { ...DEFAULT_GAUGE },
      // No convexUrl/canvasId → StaticGaugeBonusSource(0): ZERO Convex calls.
    },
    // Per-socket inbound rate limit (FEN-14). Our clients are receive-only, so
    // the bucket never bites; generous values keep it inert.
    socket: { inboundBurst: 1_000_000, inboundRefillPerSec: 1_000_000 },
  };

  const gateway = new Gateway(cfg, undefined, redis.pair);
  await gateway.start();
  redis.fireReady(); // mimic ioredis 'ready' so the ring buffer initialises
  const port = gateway.boundPort;
  const url = `ws://127.0.0.1:${port}/?token=load`;
  console.log(`[load] gateway up on :${port}  flush=${FLUSH_INTERVAL_MS}ms  canvas=${CANVAS_W}x${CANVAS_H}`);

  const clients: Client[] = [];
  const results: PlateauResult[] = [];
  let seqCounter = 1000;

  for (const target of PLATEAUS) {
    // ── grow the pool to `target` sockets, in batches ────────────────────────
    const t0 = ns();
    while (clients.length < target) {
      const batch: Client[] = [];
      for (let i = 0; i < CONNECT_BATCH && clients.length + batch.length < target; i++) {
        batch.push(new Client(url));
      }
      await Promise.all(batch.map((c) => c.whenReady));
      clients.push(...batch);
    }
    const connectMs = msSince(t0);

    // settle: let the event loop drain any backlog before measuring
    await sleep(100);

    // ── command-count isolation round: one delta, diff Redis commands ────────
    const subBefore = redis.sub.snapshot();
    const cmdBefore = redis.cmd.snapshot();
    {
      const seq = ++seqCounter;
      const waiters = clients.map((c) => c.awaitSeq(seq));
      redis.publish(canvasDeltaChannel(CANVAS_ID), `${seq},0,0,5`);
      await Promise.race([Promise.all(waiters), sleep(ROUND_TIMEOUT_MS)]);
    }
    const subDiff = diffCounts(subBefore, redis.sub.snapshot());
    const cmdDiff = diffCounts(cmdBefore, redis.cmd.snapshot());
    const deltaPathNames = { ...cmdDiff.names };
    for (const [k, v] of Object.entries(subDiff.names)) deltaPathNames[k] = (deltaPathNames[k] ?? 0) + v;

    // ── latency rounds: aggregate samples across ROUNDS deltas ───────────────
    const latencies: number[] = [];
    let received = 0;
    let extra = 0;
    const firstBytes: number[] = [];
    const spreads: number[] = [];
    const deltaFramesBefore = clients.map((c) => c.deltaFrames);
    for (let r = 0; r < ROUNDS; r++) {
      const seq = ++seqCounter;
      const x = seqCounter % CANVAS_W;
      const waiters = clients.map((c) => c.awaitSeq(seq));
      const tPub = ns();
      redis.publish(canvasDeltaChannel(CANVAS_ID), `${seq},${x},0,5`);
      const settled = await Promise.race([
        Promise.all(waiters).then(() => "all" as const),
        sleep(ROUND_TIMEOUT_MS).then(() => "timeout" as const),
      ]);
      if (settled === "all") {
        const recv = await Promise.all(waiters);
        for (const tRecv of recv) latencies.push(Number(tRecv - tPub) / 1e6);
        // Server-side fan-out, isolated from client co-location noise: first-byte
        // ≈ flush interval + dispatch; spread = serialization across N sockets.
        const recvMs = recv.map((t) => Number(t - tPub) / 1e6);
        firstBytes.push(Math.min(...recvMs));
        spreads.push(Math.max(...recvMs) - Math.min(...recvMs));
        received = clients.length;
      } else {
        const recv = await Promise.all(waiters.map((w) => Promise.race([w, sleep(0).then(() => null)])));
        received = recv.filter((v) => v !== null).length;
      }
    }
    // Each client should have seen exactly ROUNDS+1 new delta frames (1 isolation
    // + ROUNDS latency); more than that = duplicate fan-out.
    for (let i = 0; i < clients.length; i++) {
      const seen = clients[i]!.deltaFrames - deltaFramesBefore[i]!;
      if (seen > ROUNDS) extra += seen - ROUNDS;
    }

    latencies.sort((a, b) => a - b);
    const mem = process.memoryUsage();
    const res: PlateauResult = {
      sockets: clients.length,
      connectMs: Math.round(connectMs),
      received,
      missing: clients.length - received,
      extraDeltaFrames: extra,
      subscribeCalls: redis.sub.snapshot().subscribeCalls,
      deltaPathCmdDelta: cmdDiff.total + subDiff.total,
      deltaPathCmdNames: deltaPathNames,
      latency: {
        min: +pct(latencies, 0).toFixed(2),
        p50: +pct(latencies, 50).toFixed(2),
        p95: +pct(latencies, 95).toFixed(2),
        p99: +pct(latencies, 99).toFixed(2),
        max: +pct(latencies, 100).toFixed(2),
        mean: +(latencies.reduce((s, v) => s + v, 0) / (latencies.length || 1)).toFixed(2),
        samples: latencies.length,
      },
      firstByteMs: +(firstBytes.reduce((s, v) => s + v, 0) / (firstBytes.length || 1)).toFixed(2),
      spreadMs: +(spreads.reduce((s, v) => s + v, 0) / (spreads.length || 1)).toFixed(2),
      rssMb: +(mem.rss / 2 ** 20).toFixed(1),
      heapMb: +(mem.heapUsed / 2 ** 20).toFixed(1),
    };
    results.push(res);
    console.log(
      `[load] N=${String(res.sockets).padStart(4)}  recv=${res.received}/${res.sockets}  ` +
        `deltaPathRedisCmds=${res.deltaPathCmdDelta}  subs=${res.subscribeCalls}  ` +
        `p50=${res.latency.p50}ms p95=${res.latency.p95}ms p99=${res.latency.p99}ms max=${res.latency.max}ms  ` +
        `firstByte=${res.firstByteMs}ms spread=${res.spreadMs}ms  rss=${res.rssMb}MB`,
    );
  }

  // ── verdict ────────────────────────────────────────────────────────────────
  // CA1 is about correctness + flat resource use under fan-out, NOT raw latency:
  // this single-process harness co-locates N clients with N server sockets on the
  // same cores, so end-to-end latency includes client-side scheduling that a real
  // distributed deploy would not. We gate on the hard invariants (one delta per
  // socket, zero drops, zero per-socket DB read, one subscription) plus an
  // absolute p99 ceiling — and report firstByte/spread so the server-side fan-out
  // cost is visible independent of that co-location noise.
  const P99_CEILING_MS = 150;
  const ca1 = {
    everySocketOneDelta: results.every((r) => r.missing === 0 && r.extraDeltaFrames === 0),
    zeroPerSocketDbRead: results.every((r) => r.deltaPathCmdDelta === 0),
    oneSubscription: results.every((r) => r.subscribeCalls === 1),
    noDroppedFrames: results.every((r) => r.missing === 0),
    latencyWithinCeiling: results.every((r) => r.latency.p99 <= P99_CEILING_MS),
  };
  const pass = Object.values(ca1).every(Boolean);

  const report = { generatedAt: new Date().toISOString(), config: { plateaus: PLATEAUS, rounds: ROUNDS, flushIntervalMs: FLUSH_INTERVAL_MS, canvas: `${CANVAS_W}x${CANVAS_H}` }, ca1, pass, results };
  console.log("\n===== CA1 VERDICT =====");
  console.log(JSON.stringify(ca1, null, 2));
  console.log(pass ? "RESULT: PASS ✅" : "RESULT: FAIL ❌");
  console.log("\n===== JSON ARTIFACT =====");
  console.log(JSON.stringify(report));

  for (const c of clients) c.close();
  await gateway.stop();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("[load] fatal:", err);
  process.exit(2);
});
