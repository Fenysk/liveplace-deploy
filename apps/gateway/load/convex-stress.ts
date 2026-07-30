/**
 * FEN-1278 — Convex stress-test client module (reusable, parameterised).
 *
 * Simulates a real LivePlace viewer that:
 *   - Opens a WS connection and subscribes to canvas state (snapshot + deltas).
 *   - Places pixels via the gateway `place` message (→ place.lua → Redis →
 *     worker → Convex durable placements table).
 *   - Respects the D1 cooldown/gauge rate-limit using live gauge frames, exactly
 *     as the real web client does (waits for cooldownUntil before re-placing).
 *   - Exposes metrics: mutation latency (place→ack), success/failure counts,
 *     propagation latency (place→delta arriving on a separate observer socket),
 *     and pixels-lost (accepted placements with no observed propagation).
 *
 * ─── Auth strategy (no real Twitch) ─────────────────────────────────────────
 *
 * Mode A — GATEWAY_AUTH_DISABLED=1 (simplest):
 *   All connections are accepted as a single userId="anon". The gauge is shared
 *   across all actor sockets for that canvas. Use when you only want raw throughput.
 *   Connect with no token: `new StressClient({ wsUrl, userId: "anon" })`.
 *
 * Mode B — GATEWAY_DEV_JWT_SECRET=<secret> (realistic per-user gauge):
 *   The gateway verifies HS256 JWTs signed with the shared secret. Each synthetic
 *   user gets its own isolated gauge bucket in Redis.
 *   Mint tokens with `mintTestToken(userId, devSecret)` — userId format
 *   "loadtest:user:N" is clearly artificial and filterable in the Convex placements
 *   table. Pass the resulting JWT as `config.token`.
 *
 * ─── Cleanable test data ─────────────────────────────────────────────────────
 *
 * Point GATEWAY_CANVAS_ID at a `loadtest-*` slug (e.g. "loadtest-default").
 * Redis keys are namespaced `canvas:loadtest-default:*` and can be flushed with:
 *   redis-cli --scan --pattern 'canvas:loadtest-*' | xargs redis-cli del
 * Or drop everything with `docker compose -f docker-compose.loadtest.yml down -v`.
 * The `loadtest:user:*` userId prefix makes Convex placements filterable.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 *   const token = await mintTestToken("loadtest:user:0", process.env.DEV_SECRET!);
 *   const actor = new StressClient({ wsUrl: "ws://localhost:8080", userId: "loadtest:user:0", token });
 *   const observer = new StressClient({ wsUrl: "ws://localhost:8080", userId: "loadtest:observer" });
 *   await Promise.all([actor.connect(), observer.connect()]);
 *   await Promise.all([actor.whenReady, observer.whenReady]);
 *
 *   const propPromise = observer.awaitDelta(10, 20, 5, 3_000);
 *   const record = await actor.place(10, 20, 5);
 *   const observedAt = await propPromise;
 *   if (observedAt !== null && record.sentAtMs > 0)
 *     record.propagationMs = observedAt - record.sentAtMs;
 *
 *   const metrics = actor.collectMetrics();
 */

import { WebSocket } from "ws";
import { SignJWT } from "jose";
import {
  OP_SNAPSHOT,
  OP_DELTA,
  decodeJson,
  encodeJson,
  type ServerMessage,
  type GaugeState,
} from "@canvas/protocol";

// ─── Public types ─────────────────────────────────────────────────────────────

/** Rectangular zone on the canvas to restrict placements (test isolation). */
export interface Zone {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StressClientConfig {
  /** WebSocket base URL, e.g. "ws://localhost:8080". Token appended as ?token=. */
  wsUrl: string;
  /** Logical test user id (for metrics/logging). Use "loadtest:user:<n>" format. */
  userId: string;
  /** Pre-minted JWT. Omit for anonymous/disabled-auth mode. */
  token?: string;
  /** Restrict random placements to this zone. Defaults to full canvas. */
  placementZone?: Zone;
  /** Max ms to wait for WS open. Default: 10_000. */
  connectTimeoutMs?: number;
  /** Max ms to wait for ack/error after place. Default: 5_000. */
  placeTimeoutMs?: number;
}

/** Outcome of a single placement attempt. */
export type PlaceOutcome = "ack" | "cooldown" | "error_other" | "timeout";

export interface PlacementRecord {
  /** Client-generated op id (echoed by gateway in ack/error). */
  cid: string;
  x: number;
  y: number;
  color: number;
  /** Date.now() when the place message was sent. */
  sentAtMs: number;
  /** ms from place-sent to ack-received; undefined on non-ack outcomes. */
  ackLatencyMs?: number;
  /**
   * ms from place-sent to DELTA observed on a separate observer socket.
   * Filled in externally by the orchestrator after `awaitDelta()` resolves.
   */
  propagationMs?: number;
  /**
   * True when the orchestrator registered an observer watcher for this placement
   * (propagation sampling). Only sampled placements count toward pixels-lost, so
   * an un-sampled accepted placement is never mistaken for a fan-out loss.
   */
  propagationSampled?: boolean;
  outcome: PlaceOutcome;
}

export interface PercentileSummary {
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  samples: number;
}

export interface StressMetrics {
  userId: string;
  sessionDurationMs: number;
  placementsAttempted: number;
  placementsAccepted: number;
  placementsCooldown: number;
  placementsOther: number;
  /** Accepted placements whose DELTA was never observed on the observer socket (fan-out failure). */
  pixelsLost: number;
  ackLatency: PercentileSummary;
  propagation: PercentileSummary;
  /**
   * Measured wait durations when the client honoured a cooldown between placements.
   * Represents realistic gauge-paced cadence.
   */
  cooldownWaitsMs: number[];
  /** Gauge state snapshots recorded on each ack/gauge frame. */
  gaugeHistory: Array<{ ts: number } & GaugeState>;
  /** Raw placement records for detailed analysis. */
  placements: PlacementRecord[];
}

// ─── JWT helper ───────────────────────────────────────────────────────────────

/**
 * Mint an HS256 test JWT for Mode B auth (GATEWAY_DEV_JWT_SECRET).
 * The token is valid for 2 hours, plenty for a single stress run.
 * userId should be "loadtest:user:<n>" so Convex placements are filterable.
 */
export async function mintTestToken(userId: string, devSecret: string): Promise<string> {
  const key = new TextEncoder().encode(devSecret);
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(key);
}

// ─── StressClient ─────────────────────────────────────────────────────────────

/**
 * One simulated LivePlace client: connects over WebSocket, subscribes to canvas
 * state, places pixels at the D1-gated cadence, and records fine-grained metrics.
 *
 * A single instance can be used as either an actor (placer) or an observer
 * (watcher), or both. For accurate propagation measurement, use two instances on
 * separate sockets — one as the actor and one as the observer.
 */
export class StressClient {
  readonly userId: string;

  private ws!: WebSocket;
  private readonly wsUrl: string;
  private readonly token?: string;
  private readonly zone?: Zone;
  private readonly connectTimeoutMs: number;
  private readonly placeTimeoutMs: number;

  // Canvas state received from welcome frame
  private canvasWidth = 512;
  private canvasHeight = 512;

  // Live gauge state (updated on every ack/gauge frame)
  private gauge: (GaugeState & { ts: number }) | null = null;

  private connected = false;
  private cidSeq = 0;
  private sessionStart = 0;

  // Pending place promises: cid → resolve
  private readonly pendingPlaces = new Map<
    string,
    {
      x: number;
      y: number;
      color: number;
      sentAt: number;
      resolve: (r: { outcome: PlaceOutcome; gauge?: GaugeState }) => void;
    }
  >();

  // Delta watchers: "x:y:color" → ordered list of (observedAtMs) resolvers
  // The first watcher in the list is notified when the matching pixel arrives.
  private readonly deltaWatchers = new Map<string, Array<(observedAtMs: number) => void>>();

  // Metrics
  private readonly placementLog: PlacementRecord[] = [];
  private readonly gaugeHistory: Array<{ ts: number } & GaugeState> = [];
  private readonly cooldownWaitsMs: number[] = [];

  // Resolves after the initial snapshot is received (canvas ready to accept placements).
  private _readyResolve?: () => void;
  readonly whenReady: Promise<void>;

  constructor(config: StressClientConfig) {
    this.userId = config.userId;
    this.wsUrl = config.wsUrl;
    this.token = config.token;
    this.zone = config.placementZone;
    this.connectTimeoutMs = config.connectTimeoutMs ?? 10_000;
    this.placeTimeoutMs = config.placeTimeoutMs ?? 5_000;
    this.whenReady = new Promise<void>((res) => (this._readyResolve = res));
  }

  // ─── Connection ─────────────────────────────────────────────────────────────

  /**
   * Open the WebSocket connection. Resolves once the socket is open.
   * `whenReady` resolves once the initial snapshot arrives (canvas subscribed).
   */
  connect(): Promise<void> {
    const url = this.token
      ? `${this.wsUrl}/?token=${encodeURIComponent(this.token)}`
      : this.wsUrl;

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url, { perMessageDeflate: false });

      const openTimer = setTimeout(
        () => reject(new Error(`[stress:${this.userId}] connect timeout`)),
        this.connectTimeoutMs,
      );

      this.ws.once("open", () => {
        clearTimeout(openTimer);
        this.sessionStart = Date.now();
        this.connected = true;
        resolve();
      });

      this.ws.on("error", (err) => {
        clearTimeout(openTimer);
        reject(err);
      });

      this.ws.on("message", (data: Buffer, isBinary: boolean) => {
        this._onMessage(data, isBinary);
      });

      this.ws.on("close", () => {
        this.connected = false;
        // Reject all pending places so the caller doesn't hang.
        for (const [cid, pending] of this.pendingPlaces) {
          pending.resolve({ outcome: "error_other" });
          this.pendingPlaces.delete(cid);
        }
      });
    });
  }

  // ─── Message handling ────────────────────────────────────────────────────────

  private _onMessage(data: Buffer, isBinary: boolean): void {
    if (!isBinary) {
      try {
        const msg = decodeJson<ServerMessage>(data.toString("utf8"));
        this._handleJson(msg);
      } catch {
        // silently drop malformed frames
      }
      return;
    }

    const op = data[0];
    if (op === OP_SNAPSHOT) {
      // Initial canvas state received — signal subscribers.
      if (this._readyResolve) {
        this._readyResolve();
        this._readyResolve = undefined;
      }
    } else if (op === OP_DELTA) {
      this._handleDelta(data);
    }
  }

  private _handleJson(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        this.canvasWidth = msg.width;
        this.canvasHeight = msg.height;
        break;

      case "ack": {
        const gauge: GaugeState = { charges: msg.charges, max: msg.max, cooldownUntil: msg.cooldownUntil };
        this._recordGauge(gauge);
        if (msg.cid) {
          const pending = this.pendingPlaces.get(msg.cid);
          if (pending) {
            this.pendingPlaces.delete(msg.cid);
            pending.resolve({ outcome: "ack", gauge });
          }
        }
        break;
      }

      case "gauge": {
        const gauge: GaugeState = { charges: msg.charges, max: msg.max, cooldownUntil: msg.cooldownUntil };
        this._recordGauge(gauge);
        break;
      }

      case "cooldown": {
        // A server-side cooldown rejection ({ t: "cooldown"; until }) carries NO
        // cid — the gauge was empty when the place landed (e.g. the client placed
        // a hair before the charge refilled, a real clock-skew race in prod). It
        // can't be correlated to a specific cid, so resolve the OLDEST pending
        // place (placements are issued sequentially per client, so there is at
        // most one in flight). Recording it as a first-class `cooldown` outcome —
        // not a timeout/error — keeps the cooldown race out of the error rate.
        const gauge: GaugeState = { charges: 0, max: this.gauge?.max ?? 0, cooldownUntil: msg.until };
        this._recordGauge(gauge);
        const oldest = this.pendingPlaces.keys().next();
        if (!oldest.done) {
          const pending = this.pendingPlaces.get(oldest.value)!;
          this.pendingPlaces.delete(oldest.value);
          pending.resolve({ outcome: "cooldown", gauge });
        }
        break;
      }

      case "error":
        if (msg.cid) {
          const pending = this.pendingPlaces.get(msg.cid);
          if (pending) {
            this.pendingPlaces.delete(msg.cid);
            const outcome: PlaceOutcome = msg.code === "cooldown" ? "cooldown" : "error_other";
            pending.resolve({ outcome });
          }
        }
        break;

      default:
        break;
    }
  }

  private _handleDelta(data: Buffer): void {
    // Binary layout: [u8 op][u32 seq][u16 count][{u16 x, u16 y, u8 color} × count]
    const nowMs = Date.now();
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.length < 7) return;
    const count = view.getUint16(5);
    let off = 7;
    for (let i = 0; i < count; i++) {
      if (off + 5 > data.length) break;
      const x = view.getUint16(off);
      const y = view.getUint16(off + 2);
      const color = view.getUint8(off + 4);
      off += 5;

      const key = `${x}:${y}:${color}`;
      const watchers = this.deltaWatchers.get(key);
      if (watchers && watchers.length > 0) {
        const w = watchers.shift()!;
        if (watchers.length === 0) this.deltaWatchers.delete(key);
        w(nowMs);
      }
    }
  }

  private _recordGauge(gauge: GaugeState): void {
    this.gauge = { ...gauge, ts: Date.now() };
    this.gaugeHistory.push({ ts: Date.now(), ...gauge });
  }

  // ─── Placement ───────────────────────────────────────────────────────────────

  /**
   * Place a pixel at (x, y) with the given color index (1–31; use 0 for eraser).
   *
   * Respects D1 cooldown: if the gauge is empty, waits until `cooldownUntil`
   * before sending the next `place` message (mirrors real client behaviour and
   * produces realistic load, not a spam burst).
   *
   * Returns a PlacementRecord. If `propagationMs` is left undefined, the caller
   * is responsible for filling it via `awaitDelta()` on an observer socket.
   */
  async place(x: number, y: number, color: number): Promise<PlacementRecord> {
    // Honour gauge cooldown if known.
    if (this.gauge && this.gauge.charges === 0 && this.gauge.cooldownUntil > 0) {
      const waitMs = Math.max(0, this.gauge.cooldownUntil - Date.now());
      if (waitMs > 0) {
        this.cooldownWaitsMs.push(waitMs);
        await sleep(waitMs);
      }
    }

    if (!this.connected) {
      const record: PlacementRecord = { cid: "", x, y, color, sentAtMs: Date.now(), outcome: "error_other" };
      this.placementLog.push(record);
      return record;
    }

    const cid = `${this.userId}:${++this.cidSeq}`;
    const sentAt = Date.now();

    const result = await new Promise<{ outcome: PlaceOutcome; gauge?: GaugeState }>((resolve) => {
      this.pendingPlaces.set(cid, { x, y, color, sentAt, resolve });
      this.ws.send(encodeJson({ t: "place", x, y, color, cid }));

      // Timeout guard: if no ack/error within placeTimeoutMs, treat as timeout.
      const timer = setTimeout(() => {
        if (this.pendingPlaces.has(cid)) {
          this.pendingPlaces.delete(cid);
          resolve({ outcome: "timeout" });
        }
      }, this.placeTimeoutMs);

      // Clear timeout when resolved normally.
      this.pendingPlaces.set(cid, {
        x,
        y,
        color,
        sentAt,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      });
    });

    const record: PlacementRecord = {
      cid,
      x,
      y,
      color,
      sentAtMs: sentAt,
      ackLatencyMs: result.outcome === "ack" ? Date.now() - sentAt : undefined,
      outcome: result.outcome,
    };
    this.placementLog.push(record);
    return record;
  }

  /**
   * Pick a random (x, y) inside the configured placementZone (or full canvas).
   * Useful for actors that place many pixels without caring about exact positions.
   */
  randomCoord(): { x: number; y: number } {
    const zone = this.zone ?? { x: 0, y: 0, w: this.canvasWidth, h: this.canvasHeight };
    return {
      x: zone.x + Math.floor(Math.random() * zone.w),
      y: zone.y + Math.floor(Math.random() * zone.h),
    };
  }

  // ─── Propagation measurement ──────────────────────────────────────────────────

  /**
   * Register a one-shot watcher for a DELTA frame that contains (x, y, color).
   * Resolves with the epoch ms when the matching pixel was observed, or null
   * if the timeout elapses first.
   *
   * Caution: matches by (x, y, color) key — if the same pixel is placed multiple
   * times concurrently only the first DELTA is captured per watcher. In a
   * single-actor smoke test this is unambiguous; in multi-actor runs, assign
   * each actor a non-overlapping placementZone.
   */
  awaitDelta(x: number, y: number, color: number, timeoutMs: number): Promise<number | null> {
    return new Promise<number | null>((resolve) => {
      const key = `${x}:${y}:${color}`;
      const watchers = this.deltaWatchers.get(key) ?? [];

      let resolved = false;
      const handler = (ms: number) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve(ms);
      };

      watchers.push(handler);
      this.deltaWatchers.set(key, watchers);

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        const ws = this.deltaWatchers.get(key);
        if (ws) {
          const idx = ws.indexOf(handler);
          if (idx !== -1) ws.splice(idx, 1);
          if (ws.length === 0) this.deltaWatchers.delete(key);
        }
        resolve(null);
      }, timeoutMs);
    });
  }

  // ─── Teardown & metrics ───────────────────────────────────────────────────────

  close(): void {
    this.connected = false;
    this.ws?.removeAllListeners();
    this.ws?.terminate();
  }

  /** Collect and return all metrics for this client session. */
  collectMetrics(): StressMetrics {
    const accepted = this.placementLog.filter((p) => p.outcome === "ack");
    const ackLats = accepted.map((p) => p.ackLatencyMs).filter((v): v is number => v !== undefined);
    const propLats = accepted.map((p) => p.propagationMs).filter((v): v is number => v !== undefined);
    const pixelsLost = accepted.filter((p) => p.propagationMs === undefined).length;

    return {
      userId: this.userId,
      sessionDurationMs: this.sessionStart > 0 ? Date.now() - this.sessionStart : 0,
      placementsAttempted: this.placementLog.length,
      placementsAccepted: accepted.length,
      placementsCooldown: this.placementLog.filter((p) => p.outcome === "cooldown").length,
      placementsOther: this.placementLog.filter((p) => p.outcome === "error_other" || p.outcome === "timeout").length,
      pixelsLost,
      ackLatency: pctSummary(ackLats),
      propagation: pctSummary(propLats),
      cooldownWaitsMs: this.cooldownWaitsMs,
      gaugeHistory: this.gaugeHistory,
      placements: this.placementLog,
    };
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)]!;
}

export function pctSummary(values: number[]): PercentileSummary {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.length > 0 ? sorted.reduce((s, v) => s + v, 0) / sorted.length : NaN;
  return {
    min: pct(sorted, 0),
    p50: pct(sorted, 50),
    p95: pct(sorted, 95),
    p99: pct(sorted, 99),
    max: pct(sorted, 100),
    mean: +mean.toFixed(2),
    samples: sorted.length,
  };
}
