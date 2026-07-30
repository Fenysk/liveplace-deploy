/**
 * FEN-1280 — Stress-test orchestrator (ramp / scenarios / metrics / report).
 *
 * Drives N {@link StressClient} actors against a LivePlace gateway following a
 * DYNAMIC ramp profile, aggregates real-time metrics, enforces the prod
 * guard-rails (auto-abort + kill-switch), and produces a go/no-go report.
 *
 * The orchestrator is transport-only: it talks to a gateway over WebSockets via
 * StressClient, so the SAME code drives the in-process dry-run (see
 * `stress-dryrun.ts`) and the gated production run (real prod WS URL). It owns
 * no Redis/Convex — it imports the FEN-1278 load module and sequences it.
 *
 * ─── Traceability to FEN-1276 acceptance (plan §2–§5) ────────────────────────
 *   §4 profile  → {@link RampStage}[] (0→500→1000→2000→peak 3000), activeFraction
 *                 10–20 %, cooldown-respecting placers (StressClient.place).
 *   §3 metrics  → ack p50/p95/p99, propagation p95, error rate, throughput,
 *                 pixels-lost — {@link StageMetrics}.
 *   §3 SLO      → {@link DEFAULT_SLO}; per-stage pass/fail + breaking point.
 *   §5 abort    → {@link DEFAULT_GUARDRAILS} (error>5 %, ack p95>3×SLO) + kill-switch.
 *   §9 report   → {@link generateReport} (markdown SLO table + ascii graphs + JSON).
 */
import {
  StressClient,
  mintTestToken,
  pctSummary,
  type PlacementRecord,
  type PercentileSummary,
  type Zone,
} from "./convex-stress";

// Re-exported so the runner CLI can build a typed OrchestratorConfig.zone.
export type { Zone } from "./convex-stress";

// ─── SLO + guard-rails (plan §3 / §5) ───────────────────────────────────────────

export interface Slo {
  /** Mutation (place→ack) latency p95 ceiling, ms. */
  ackP95Ms: number;
  /** Mutation latency p99 ceiling, ms. */
  ackP99Ms: number;
  /** Propagation (place→delta on observer) p95 ceiling, ms. */
  propP95Ms: number;
  /** Error-rate ceiling, percent (cooldowns are expected backpressure, not errors). */
  errorRatePct: number;
  /** Recovery budget after the peak: latency must return to nominal within this, ms. */
  recoveryMs: number;
}

/** Reference SLO from plan §3. */
export const DEFAULT_SLO: Slo = {
  ackP95Ms: 300,
  ackP99Ms: 800,
  propP95Ms: 1_000,
  errorRatePct: 1,
  recoveryMs: 120_000,
};

export interface Guardrails {
  /** Abort the ramp if the live error rate exceeds this, percent. */
  abortErrorRatePct: number;
  /** Abort if live ack p95 exceeds this multiple of the SLO ack p95 (3× ⇒ 900 ms). */
  abortAckP95MultipleOfSlo: number;
}

/** Hard abort thresholds from plan §5. */
export const DEFAULT_GUARDRAILS: Guardrails = {
  abortErrorRatePct: 5,
  abortAckP95MultipleOfSlo: 3,
};

// ─── Profile ────────────────────────────────────────────────────────────────────

export interface RampStage {
  /** Human label, e.g. "palier-1000" or "pic-3000". */
  label: string;
  /** Target number of connected actors at this stage. */
  actors: number;
  /** How long to hold the plateau (ms) while metrics + guard-rails are sampled. */
  holdMs: number;
}

export interface OrchestratorConfig {
  /** Gateway WS base URL, e.g. "ws://127.0.0.1:8080". */
  wsUrl: string;
  /**
   * HS256 dev secret (GATEWAY_DEV_JWT_SECRET). REQUIRED: placement needs a real
   * per-user identity (anonymous sockets are read-only), and per-user tokens give
   * each actor an isolated gauge bucket — the realistic cooldown model (plan §4).
   */
  devSecret: string;
  /** Ramp profile, applied in order. */
  stages: RampStage[];
  /** Fraction of connected actors that actively place (plan §4: 10–20 %). Default 0.15. */
  activeFraction?: number;
  /** Overall placement region, sub-divided into a non-overlapping cell per active placer. */
  zone?: Zone;
  /** Dedicated observer sockets used to time propagation. Default 3. */
  observerCount?: number;
  /** Min gap (ms) an active placer waits between attempts, on top of any gauge cooldown. Default 0. */
  placeIntervalMs?: number;
  /** Fraction of placements measured for propagation latency (sampling keeps watcher cost bounded). Default 0.25. */
  propagationSampleRate?: number;
  /** Per-sample propagation watch timeout, ms. Default 3000. */
  propagationTimeoutMs?: number;
  /** Reference SLO. Default {@link DEFAULT_SLO}. */
  slo?: Slo;
  /** Auto-abort thresholds. Default {@link DEFAULT_GUARDRAILS}. */
  guardrails?: Guardrails;
  /** Test user-id prefix (filterable in Convex). Default "loadtest:user:". */
  userPrefix?: string;
  /** Guard-rail evaluation cadence during a hold, ms. Default 2000. */
  evalIntervalMs?: number;
  /** Measure post-peak recovery (drain placers, watch latency return to nominal). Default true. */
  measureRecovery?: boolean;
  /** Marks the report as a dry-run (instrumentation validation, not a prod result). */
  dryRun?: boolean;
  /** Optional log sink (defaults to console.log). */
  log?: (line: string) => void;
}

// ─── Result types ───────────────────────────────────────────────────────────────

export interface StageMetrics {
  label: string;
  /** Connected actors held during the stage. */
  actors: number;
  /** Of those, how many were active placers. */
  activePlacers: number;
  /** Wall-clock window the stage's placements were attributed to, ms. */
  windowMs: number;
  attempted: number;
  accepted: number;
  /** Placements deferred by the gauge cooldown (expected backpressure, not errors). */
  cooldown: number;
  /** Non-cooldown failures (errors + timeouts). */
  errors: number;
  /** Accepted placements per second during the window. */
  throughputPerSec: number;
  /** errors / (attempted − cooldown), percent. */
  errorRatePct: number;
  ack: PercentileSummary;
  prop: PercentileSummary;
  /** Placements for which propagation was sampled. */
  propagationSampled: number;
  /** Sampled placements whose DELTA was never observed (fan-out loss). */
  pixelsLostSampled: number;
  /** SLO verdict for this stage. */
  sloPass: boolean;
  /** Human descriptions of any SLO breaches. */
  sloBreaches: string[];
}

export interface RecoveryResult {
  /** ms from end-of-peak until ack p95 returned within SLO, or null if it never did. */
  recoveredInMs: number | null;
  withinSlo: boolean;
  postPeakAckP95Ms: number;
}

export interface OrchestratorResult {
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  config: {
    wsUrl: string;
    stages: RampStage[];
    activeFraction: number;
    propagationSampleRate: number;
  };
  slo: Slo;
  guardrails: Guardrails;
  stages: StageMetrics[];
  aborted: boolean;
  abortReason: string | null;
  /** First stage that breached SLO or where the run aborted; null if all passed. */
  breakingPoint: { label: string; actors: number; reason: string } | null;
  /** Largest actor count of a stage that stayed fully within SLO. */
  maxSustainedActors: number;
  recovery: RecoveryResult | null;
  /**
   * Cooldown backpressure the placers actually honoured (the realistic, gauge-paced
   * cadence — plan §4). `count` = number of cooldown waits across all actors;
   * a non-zero count proves the gauge/cooldown path was exercised.
   */
  cooldownWaits: { count: number; p50Ms: number; maxMs: number };
}

// ─── Internal helpers ───────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Colour palette indices to cycle through (valid placed colours). */
const COLORS = [5, 10, 12, 8, 14, 3, 21, 7];

/** Slice `zone` into `n` non-overlapping cells (grid), so each placer owns a region. */
export function sliceZone(zone: Zone, n: number): Zone[] {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cw = Math.max(1, Math.floor(zone.w / cols));
  const ch = Math.max(1, Math.floor(zone.h / rows));
  const cells: Zone[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    cells.push({ x: zone.x + c * cw, y: zone.y + r * ch, w: cw, h: ch });
  }
  return cells;
}

/** Aggregate a set of placement records into a StageMetrics row. */
export function summariseWindow(
  label: string,
  actors: number,
  activePlacers: number,
  records: PlacementRecord[],
  windowMs: number,
  slo: Slo,
): StageMetrics {
  const accepted = records.filter((r) => r.outcome === "ack");
  const cooldown = records.filter((r) => r.outcome === "cooldown").length;
  const errors = records.filter((r) => r.outcome === "error_other" || r.outcome === "timeout").length;
  const ackLats = accepted.map((r) => r.ackLatencyMs).filter((v): v is number => v !== undefined);
  const sampled = accepted.filter((r) => r.propagationSampled === true);
  const propLats = sampled.map((r) => r.propagationMs).filter((v): v is number => v !== undefined);
  const pixelsLostSampled = sampled.filter((r) => r.propagationMs === undefined).length;

  const denom = records.length - cooldown;
  const errorRatePct = denom > 0 ? +((errors / denom) * 100).toFixed(3) : 0;
  const throughputPerSec = windowMs > 0 ? +((accepted.length / windowMs) * 1000).toFixed(2) : 0;
  const ack = pctSummary(ackLats);
  const prop = pctSummary(propLats);

  const breaches: string[] = [];
  if (ack.samples > 0 && ack.p95 > slo.ackP95Ms) breaches.push(`ack p95 ${ack.p95}ms > ${slo.ackP95Ms}ms`);
  if (ack.samples > 0 && ack.p99 > slo.ackP99Ms) breaches.push(`ack p99 ${ack.p99}ms > ${slo.ackP99Ms}ms`);
  if (prop.samples > 0 && prop.p95 > slo.propP95Ms) breaches.push(`prop p95 ${prop.p95}ms > ${slo.propP95Ms}ms`);
  if (errorRatePct > slo.errorRatePct) breaches.push(`error ${errorRatePct}% > ${slo.errorRatePct}%`);
  if (pixelsLostSampled > 0) breaches.push(`${pixelsLostSampled} sampled pixel(s) lost (zero-loss SLO)`);

  return {
    label,
    actors,
    activePlacers,
    windowMs,
    attempted: records.length,
    accepted: accepted.length,
    cooldown,
    errors,
    throughputPerSec,
    errorRatePct,
    ack,
    prop,
    propagationSampled: sampled.length,
    pixelsLostSampled,
    sloPass: breaches.length === 0,
    sloBreaches: breaches,
  };
}

// ─── Orchestrator ───────────────────────────────────────────────────────────────

/**
 * One live, kill-switchable stress run. `run()` resolves with the full result
 * once all stages complete or a guard-rail aborts the ramp. `kill(reason)` (or
 * SIGINT) trips the kill-switch and tears the ramp down immediately.
 */
export class StressOrchestrator {
  private readonly cfg: Required<
    Omit<OrchestratorConfig, "zone" | "log">
  > & { zone: Zone; log: (l: string) => void };

  private readonly actors: StressClient[] = [];
  private readonly observers: StressClient[] = [];
  /** Tokens of in-flight active placer loops (index → running). */
  private readonly placerStop = new Set<number>();
  /** Every completed placement record across the run (shared, timestamp-attributed). */
  private readonly allRecords: PlacementRecord[] = [];
  private zoneCells: Zone[] = [];
  private aborted = false;
  private abortReason: string | null = null;
  private peakEndedAt = 0;

  constructor(config: OrchestratorConfig) {
    if (!config.devSecret) {
      throw new Error("StressOrchestrator requires devSecret: placement needs a per-user identity.");
    }
    this.cfg = {
      wsUrl: config.wsUrl,
      devSecret: config.devSecret,
      stages: config.stages,
      activeFraction: config.activeFraction ?? 0.15,
      zone: config.zone ?? { x: 0, y: 0, w: 256, h: 256 },
      observerCount: config.observerCount ?? 3,
      placeIntervalMs: config.placeIntervalMs ?? 0,
      propagationSampleRate: config.propagationSampleRate ?? 0.25,
      propagationTimeoutMs: config.propagationTimeoutMs ?? 3_000,
      slo: config.slo ?? DEFAULT_SLO,
      guardrails: config.guardrails ?? DEFAULT_GUARDRAILS,
      userPrefix: config.userPrefix ?? "loadtest:user:",
      evalIntervalMs: config.evalIntervalMs ?? 2_000,
      measureRecovery: config.measureRecovery ?? true,
      dryRun: config.dryRun ?? false,
      log: config.log ?? ((l: string) => console.log(l)),
    };
  }

  /** Trip the kill-switch: stop spawning, stop placing, and let `run()` unwind. */
  kill(reason: string): void {
    if (this.aborted) return;
    this.aborted = true;
    this.abortReason = reason;
    for (const t of [...this.placerStop]) this.placerStop.delete(t);
    this.cfg.log(`[orchestrator] KILL-SWITCH: ${reason}`);
  }

  async run(): Promise<OrchestratorResult> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const onSigint = () => this.kill("SIGINT kill-switch");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigint);

    const maxActors = Math.max(0, ...this.cfg.stages.map((s) => s.actors));
    const maxActive = Math.max(1, Math.ceil(maxActors * this.cfg.activeFraction));
    this.zoneCells = sliceZone(this.cfg.zone, maxActive);

    const stageMetrics: StageMetrics[] = [];
    try {
      await this.connectObservers();

      for (const stage of this.cfg.stages) {
        if (this.aborted) break;
        await this.rampTo(stage.actors);
        const activeCount = Math.min(this.actors.length, Math.ceil(stage.actors * this.cfg.activeFraction));
        this.ensurePlacersRunning(activeCount);

        const windowStart = Date.now();
        const liveBreach = await this.holdAndWatch(stage, windowStart);
        const windowEnd = Date.now();

        const stageRecords = this.allRecords.filter(
          (r) => r.sentAtMs >= windowStart && r.sentAtMs <= windowEnd,
        );
        const m = summariseWindow(stage.label, this.actors.length, activeCount, stageRecords, windowEnd - windowStart, this.cfg.slo);
        stageMetrics.push(m);
        this.cfg.log(
          `[orchestrator] ${stage.label}: actors=${m.actors} active=${m.activePlacers} ` +
            `acc=${m.accepted} thr=${m.throughputPerSec}/s ack p95=${m.ack.p95}ms p99=${m.ack.p99}ms ` +
            `prop p95=${m.prop.p95}ms err=${m.errorRatePct}% lost=${m.pixelsLostSampled} ${m.sloPass ? "✅" : "⚠"}`,
        );

        if (liveBreach) {
          this.kill(liveBreach);
          break;
        }
      }

      let recovery: RecoveryResult | null = null;
      if (this.cfg.measureRecovery && stageMetrics.length > 0) {
        recovery = await this.measureRecovery();
      }

      const finishedAt = new Date().toISOString();
      return this.buildResult(startedAt, finishedAt, Date.now() - t0, stageMetrics, recovery);
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigint);
      this.teardown();
    }
  }

  // ─── Connection management ────────────────────────────────────────────────────

  private async connectObservers(): Promise<void> {
    for (let i = 0; i < this.cfg.observerCount; i++) {
      const userId = `${this.cfg.userPrefix}observer:${i}`;
      const token = await mintTestToken(userId, this.cfg.devSecret);
      const obs = new StressClient({ wsUrl: this.cfg.wsUrl, userId, token });
      this.observers.push(obs);
    }
    await Promise.all(this.observers.map((o) => o.connect()));
    await Promise.all(this.observers.map((o) => o.whenReady));
    this.cfg.log(`[orchestrator] ${this.observers.length} observer(s) subscribed`);
  }

  /** Grow the actor pool to `target` connected+subscribed sockets, in batches. */
  private async rampTo(target: number): Promise<void> {
    const BATCH = 100;
    while (this.actors.length < target && !this.aborted) {
      const batch: StressClient[] = [];
      for (let i = 0; i < BATCH && this.actors.length + batch.length < target; i++) {
        const idx = this.actors.length + batch.length;
        const userId = `${this.cfg.userPrefix}${idx}`;
        const token = await mintTestToken(userId, this.cfg.devSecret);
        const cell = this.zoneCells[idx % this.zoneCells.length]!;
        batch.push(new StressClient({ wsUrl: this.cfg.wsUrl, userId, token, placementZone: cell }));
      }
      await Promise.all(batch.map((c) => c.connect()));
      await Promise.all(batch.map((c) => c.whenReady));
      this.actors.push(...batch);
    }
    this.cfg.log(`[orchestrator] ramped to ${this.actors.length} actors`);
  }

  // ─── Active placer loops ──────────────────────────────────────────────────────

  /** Start placer loops for actors [0, count) that are not already running. */
  private ensurePlacersRunning(count: number): void {
    for (let i = 0; i < count && i < this.actors.length; i++) {
      if (this.placerStop.has(i)) continue; // already running
      this.placerStop.add(i);
      void this.placerLoop(i);
    }
  }

  private async placerLoop(idx: number): Promise<void> {
    const actor = this.actors[idx]!;
    let colorN = idx;
    while (this.placerStop.has(idx) && !this.aborted) {
      const { x, y } = actor.randomCoord();
      const color = COLORS[colorN++ % COLORS.length]!;
      const sample = Math.random() < this.cfg.propagationSampleRate;
      let propPromise: Promise<number | null> | null = null;
      let observer: StressClient | null = null;
      if (sample && this.observers.length > 0) {
        observer = this.observers[idx % this.observers.length]!;
        propPromise = observer.awaitDelta(x, y, color, this.cfg.propagationTimeoutMs);
      }

      const record = await actor.place(x, y, color);
      record.propagationSampled = sample && observer !== null;
      this.allRecords.push(record);

      if (propPromise) {
        if (record.outcome === "ack") {
          const observedAt = await propPromise;
          if (observedAt !== null && record.sentAtMs > 0) record.propagationMs = observedAt - record.sentAtMs;
        } else {
          void propPromise.catch(() => undefined); // let the watcher time out, don't await
        }
      }

      if (this.cfg.placeIntervalMs > 0) await sleep(this.cfg.placeIntervalMs);
    }
  }

  // ─── Hold + live guard-rails ──────────────────────────────────────────────────

  /**
   * Hold the plateau for the stage duration, evaluating guard-rails on a rolling
   * recent window every evalIntervalMs. Returns a breach reason if a guard-rail
   * tripped (caller aborts), else null.
   */
  private async holdAndWatch(stage: RampStage, windowStart: number): Promise<string | null> {
    const deadline = windowStart + stage.holdMs;
    const { abortErrorRatePct, abortAckP95MultipleOfSlo } = this.cfg.guardrails;
    const ackP95Ceiling = this.cfg.slo.ackP95Ms * abortAckP95MultipleOfSlo;

    while (Date.now() < deadline && !this.aborted) {
      await sleep(Math.min(this.cfg.evalIntervalMs, Math.max(0, deadline - Date.now())));
      // Rolling window = the last evalInterval of records.
      const since = Date.now() - this.cfg.evalIntervalMs;
      const recent = this.allRecords.filter((r) => r.sentAtMs >= since);
      const cooldown = recent.filter((r) => r.outcome === "cooldown").length;
      const errors = recent.filter((r) => r.outcome === "error_other" || r.outcome === "timeout").length;
      const denom = recent.length - cooldown;
      const errPct = denom > 0 ? (errors / denom) * 100 : 0;
      const ackLats = recent
        .filter((r) => r.outcome === "ack")
        .map((r) => r.ackLatencyMs)
        .filter((v): v is number => v !== undefined);
      const ackP95 = pctSummary(ackLats).p95;

      if (errPct > abortErrorRatePct) {
        return `error rate ${errPct.toFixed(1)}% > ${abortErrorRatePct}% at ${stage.label}`;
      }
      if (ackLats.length >= 20 && ackP95 > ackP95Ceiling) {
        return `ack p95 ${ackP95}ms > ${ackP95Ceiling}ms (3×SLO) at ${stage.label}`;
      }
    }
    return null;
  }

  // ─── Recovery probe (plan §3: latency returns to nominal < 2 min) ──────────────

  private async measureRecovery(): Promise<RecoveryResult> {
    // Drain all but a light residual placer set, then watch ack p95 return to SLO.
    this.peakEndedAt = Date.now();
    for (const t of [...this.placerStop]) if (t >= 2) this.placerStop.delete(t);
    this.cfg.log(`[orchestrator] peak ended; measuring recovery (residual ${Math.min(2, this.actors.length)} placers)`);

    const deadline = this.peakEndedAt + this.cfg.slo.recoveryMs;
    let lastP95 = Infinity;
    while (Date.now() < deadline && !this.aborted) {
      await sleep(Math.min(5_000, Math.max(0, deadline - Date.now())));
      const since = Date.now() - 5_000;
      const ackLats = this.allRecords
        .filter((r) => r.sentAtMs >= since && r.outcome === "ack")
        .map((r) => r.ackLatencyMs)
        .filter((v): v is number => v !== undefined);
      if (ackLats.length === 0) continue;
      lastP95 = pctSummary(ackLats).p95;
      if (lastP95 <= this.cfg.slo.ackP95Ms) {
        return { recoveredInMs: Date.now() - this.peakEndedAt, withinSlo: true, postPeakAckP95Ms: lastP95 };
      }
    }
    return { recoveredInMs: null, withinSlo: false, postPeakAckP95Ms: Number.isFinite(lastP95) ? lastP95 : -1 };
  }

  // ─── Result assembly + teardown ───────────────────────────────────────────────

  private buildResult(
    startedAt: string,
    finishedAt: string,
    durationMs: number,
    stages: StageMetrics[],
    recovery: RecoveryResult | null,
  ): OrchestratorResult {
    const firstBreach = stages.find((s) => !s.sloPass);
    let breakingPoint: OrchestratorResult["breakingPoint"] = null;
    if (this.aborted && this.abortReason) {
      const lastStage = stages[stages.length - 1];
      breakingPoint = { label: lastStage?.label ?? "unknown", actors: lastStage?.actors ?? 0, reason: this.abortReason };
    } else if (firstBreach) {
      breakingPoint = { label: firstBreach.label, actors: firstBreach.actors, reason: firstBreach.sloBreaches.join("; ") };
    }
    const sustained = stages.filter((s) => s.sloPass).map((s) => s.actors);
    const maxSustainedActors = sustained.length > 0 ? Math.max(...sustained) : 0;

    // Collect cooldown waits across actors while they are still alive (pre-teardown).
    const allWaits: number[] = [];
    for (const a of this.actors) allWaits.push(...a.collectMetrics().cooldownWaitsMs);
    const waitSummary = pctSummary(allWaits);
    const cooldownWaits = {
      count: allWaits.length,
      p50Ms: Number.isFinite(waitSummary.p50) ? waitSummary.p50 : 0,
      maxMs: Number.isFinite(waitSummary.max) ? waitSummary.max : 0,
    };

    return {
      dryRun: this.cfg.dryRun,
      startedAt,
      finishedAt,
      durationMs,
      config: {
        wsUrl: this.cfg.wsUrl,
        stages: this.cfg.stages,
        activeFraction: this.cfg.activeFraction,
        propagationSampleRate: this.cfg.propagationSampleRate,
      },
      slo: this.cfg.slo,
      guardrails: this.cfg.guardrails,
      stages,
      aborted: this.aborted,
      abortReason: this.abortReason,
      breakingPoint,
      maxSustainedActors,
      recovery,
      cooldownWaits,
    };
  }

  private teardown(): void {
    for (const t of [...this.placerStop]) this.placerStop.delete(t);
    for (const a of this.actors) a.close();
    for (const o of this.observers) o.close();
  }
}

// ─── Report generator (plan §9) ─────────────────────────────────────────────────

/** Render a tiny fixed-width ascii bar for a value against a max. */
function bar(value: number, max: number, width = 24): string {
  if (!Number.isFinite(value) || max <= 0) return "";
  const n = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return "█".repeat(n) + "·".repeat(width - n);
}

/**
 * Build the human report: profile, per-stage SLO table, ascii latency/throughput
 * graphs, breaking point, and a go/no-go recommendation. Returns markdown + the
 * raw JSON artifact (machine-readable, re-attachable to the issue).
 */
export function generateReport(result: OrchestratorResult): { markdown: string; json: string } {
  const L: string[] = [];
  const kind = result.dryRun ? "Dry-run (instrumentation validation)" : "Production run";
  L.push(`# Stress test — ${kind}`);
  L.push("");
  L.push(`- Started: ${result.startedAt}`);
  L.push(`- Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  L.push(`- Target: \`${result.config.wsUrl}\``);
  L.push(`- Active fraction: ${(result.config.activeFraction * 100).toFixed(0)}% · propagation sample: ${(result.config.propagationSampleRate * 100).toFixed(0)}%`);
  L.push("");

  L.push("## SLO reference (plan §3)");
  L.push("");
  L.push(`- mutation ack p95 < ${result.slo.ackP95Ms}ms · p99 < ${result.slo.ackP99Ms}ms`);
  L.push(`- propagation p95 < ${result.slo.propP95Ms}ms`);
  L.push(`- error rate < ${result.slo.errorRatePct}% · zero pixel loss · recovery < ${(result.slo.recoveryMs / 1000).toFixed(0)}s`);
  L.push("");

  L.push("## Per-stage results");
  L.push("");
  L.push("| Stage | Actors | Active | Acc | Thr/s | ack p50 | ack p95 | ack p99 | prop p95 | err% | lost | SLO |");
  L.push("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|:--:|");
  for (const s of result.stages) {
    L.push(
      `| ${s.label} | ${s.actors} | ${s.activePlacers} | ${s.accepted} | ${s.throughputPerSec} | ` +
        `${fmt(s.ack.p50)} | ${fmt(s.ack.p95)} | ${fmt(s.ack.p99)} | ${fmt(s.prop.p95)} | ${s.errorRatePct} | ` +
        `${s.pixelsLostSampled} | ${s.sloPass ? "✅" : "❌"} |`,
    );
  }
  L.push("");

  // ascii graph: ack p95 across stages.
  const maxAck = Math.max(result.slo.ackP95Ms, ...result.stages.map((s) => s.ack.p95).filter(Number.isFinite));
  const maxThr = Math.max(1, ...result.stages.map((s) => s.throughputPerSec));
  L.push("## Latency vs load (ack p95, ms)");
  L.push("");
  L.push("```");
  for (const s of result.stages) {
    const mark = s.ack.p95 > result.slo.ackP95Ms ? " ⚠" : "";
    L.push(`${s.label.padEnd(14)} ${bar(s.ack.p95, maxAck)} ${fmt(s.ack.p95)}ms${mark}`);
  }
  L.push(`${"SLO p95".padEnd(14)} ${bar(result.slo.ackP95Ms, maxAck)} ${result.slo.ackP95Ms}ms (ceiling)`);
  L.push("```");
  L.push("");
  L.push("## Throughput vs load (accepted/s)");
  L.push("");
  L.push("```");
  for (const s of result.stages) {
    L.push(`${s.label.padEnd(14)} ${bar(s.throughputPerSec, maxThr)} ${s.throughputPerSec}/s`);
  }
  L.push("```");
  L.push("");

  L.push("## Breaking point");
  L.push("");
  if (result.breakingPoint) {
    L.push(`⚠ First failure at **${result.breakingPoint.label}** (${result.breakingPoint.actors} actors): ${result.breakingPoint.reason}.`);
    L.push("");
    L.push(`Max load sustained within SLO: **${result.maxSustainedActors} actors**.`);
  } else {
    L.push(`✅ No SLO breach across all stages. Max sustained: **${result.maxSustainedActors} actors**.`);
  }
  L.push("");

  if (result.recovery) {
    L.push("## Recovery (post-peak)");
    L.push("");
    if (result.recovery.withinSlo) {
      L.push(`✅ ack p95 returned to nominal in ${((result.recovery.recoveredInMs ?? 0) / 1000).toFixed(1)}s (SLO ${(result.slo.recoveryMs / 1000).toFixed(0)}s).`);
    } else {
      L.push(`⚠ ack p95 did NOT return within ${(result.slo.recoveryMs / 1000).toFixed(0)}s (last p95 ${fmt(result.recovery.postPeakAckP95Ms)}ms).`);
    }
    L.push("");
  }

  L.push("## Cooldown backpressure (plan §4)");
  L.push("");
  L.push(
    result.cooldownWaits.count > 0
      ? `Placers honoured **${result.cooldownWaits.count}** gauge cooldown wait(s) (p50 ${result.cooldownWaits.p50Ms}ms, max ${result.cooldownWaits.maxMs}ms) — realistic gauge-paced cadence, not a spam burst.`
      : "No cooldown waits recorded (gauge never emptied at this charge/duration).",
  );
  L.push("");

  L.push("## Recommendation");
  L.push("");
  const allPass = result.stages.length > 0 && result.stages.every((s) => s.sloPass) && !result.aborted;
  if (result.dryRun) {
    const instrumented = result.stages.some((s) => s.accepted > 0 && s.ack.samples > 0);
    L.push(
      instrumented
        ? "✅ **Instrumentation validated**: subscribe + place + ack-latency + propagation + gauge-cooldown + metrics aggregation all produced samples. Harness is ready for the gated production run."
        : "❌ **Instrumentation INVALID**: no accepted placements / latency samples captured — fix before any prod run.",
    );
  } else if (allPass) {
    L.push("✅ **GO**: all stages within SLO. The realtime core sustains the target load with no pixel loss.");
  } else {
    L.push("❌ **NO-GO** (or conditional): see breaking point above. Address the bottleneck before launch.");
  }
  L.push("");

  return { markdown: L.join("\n"), json: JSON.stringify(result) };
}

function fmt(n: number): string {
  return Number.isFinite(n) ? String(n) : "—";
}
