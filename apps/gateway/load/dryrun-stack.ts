/**
 * FEN-1280 — in-process dry-run stack for the stress-test orchestrator.
 *
 * Stands up a faithful, Redis-less target the orchestrator can drive over real
 * WebSockets so the FULL instrumentation chain (subscribe → place → ack → gauge
 * cooldown → DELTA propagation → metrics aggregation → guard-rails → report) is
 * exercised BEFORE any production run (plan §5: "kill-switch documenté et testé
 * en répétition basse charge AVANT le vrai run").
 *
 * What is REAL here:
 *   - The `Gateway` (HTTP + WebSocket server, coalescer, ring buffer, fan-out),
 *     the auth path (HS256 dev tokens), and the `RedisPlacementHandler` verdict
 *     → frame mapping are the production gateway code, unchanged.
 *
 * What is SUBSTITUTED:
 *   - Redis itself, by an in-memory double. The pixel write + gauge token-bucket
 *     + DELTA publish that `place.lua` performs atomically inside Redis is
 *     emulated by {@link EmulatedPlaceRunner}, which reuses the unit-tested
 *     `refillGauge` arithmetic from `@canvas/redis-scripts` (the same source of
 *     truth the Lua mirrors) so the gauge/cooldown behaviour matches production.
 *
 * This is dry-run scaffolding, NOT a Redis implementation: it models only the
 * commands the gateway issues on the connect + place paths. The production run
 * (separate, GATED issue) points the same orchestrator at the real prod WS URL.
 */
import {
  refillGauge,
  nextRefillAt,
  type GaugeParams,
  type StoredGauge,
} from "@canvas/redis-scripts";
import type { RedisPair } from "../src/redis";
import type { PlaceScriptRunner } from "../src/placement";

type MessageListener = (channel: string, payload: string) => void;
type ReadyListener = () => void;

class Bus {
  readonly store = new Map<string, string | Buffer>();
  readonly sets = new Map<string, Set<string>>();
  readonly hashes = new Map<string, Map<string, string>>();
  readonly messageListeners: MessageListener[] = [];
  readonly readyListeners: ReadyListener[] = [];
  publish(channel: string, payload: string): void {
    for (const l of this.messageListeners) l(channel, payload);
  }
  fireReady(): void {
    for (const l of this.readyListeners) l();
  }
}

/**
 * The subset of ioredis the gateway touches on the connect/snapshot/presence
 * paths. `evalsha` returns the read-only refill-peek shape ([charges, max,
 * cooldownUntil]) — for a never-placed user that is [max, max, 0], which is all
 * the initial `gauge` frame needs. The hot place path does NOT go through here:
 * it uses the injected {@link EmulatedPlaceRunner} instead.
 */
class DryRunRedis {
  constructor(private readonly bus: Bus) {}

  multi() {
    const ops: Array<{ kind: "get" | "getBuffer"; key: string }> = [];
    const chain = {
      get: (key: string) => (ops.push({ kind: "get", key }), chain),
      getBuffer: (key: string) => (ops.push({ kind: "getBuffer", key }), chain),
      exec: async () =>
        ops.map((op) => {
          const v = this.bus.store.get(op.key);
          if (op.kind === "getBuffer") {
            return [null, v === undefined ? null : Buffer.isBuffer(v) ? v : Buffer.from(String(v))];
          }
          return [null, v === undefined ? null : typeof v === "string" ? v : v.toString()];
        }),
    };
    return chain;
  }

  async set(key: string, value: string): Promise<"OK"> {
    this.bus.store.set(key, value);
    return "OK";
  }
  async del(key: string): Promise<number> {
    return this.bus.store.delete(key) ? 1 : 0;
  }
  async scan(_cursor: string, _match: "MATCH", pattern: string) {
    const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
    const keys = [...this.bus.store.keys()].filter((k) => k.startsWith(prefix));
    return ["0", keys] as [string, string[]];
  }
  async mget(keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => {
      const v = this.bus.store.get(k);
      return v === undefined ? null : typeof v === "string" ? v : v.toString();
    });
  }
  async incr(key: string): Promise<number> {
    const n = (Number(this.bus.store.get(key)) || 0) + 1;
    this.bus.store.set(key, String(n));
    return n;
  }
  async get(key: string): Promise<string | null> {
    const v = this.bus.store.get(key);
    return v === undefined ? null : typeof v === "string" ? v : v.toString();
  }
  async sadd(key: string, member: string): Promise<number> {
    const s = this.bus.sets.get(key) ?? this.bus.sets.set(key, new Set()).get(key)!;
    if (s.has(member)) return 0;
    s.add(member);
    return 1;
  }
  async smembers(key: string): Promise<string[]> {
    return [...(this.bus.sets.get(key) ?? [])];
  }
  async scard(key: string): Promise<number> {
    return this.bus.sets.get(key)?.size ?? 0;
  }
  async hsetnx(key: string, field: string, value: string): Promise<number> {
    const h = this.bus.hashes.get(key) ?? this.bus.hashes.set(key, new Map()).get(key)!;
    if (h.has(field)) return 0;
    h.set(field, value);
    return 1;
  }
  async script(_sub: "LOAD", _lua: string): Promise<string> {
    return "sha-fake";
  }
  async evalsha(_sha: string, _numKeys: number, ...args: string[]): Promise<unknown> {
    // refill-peek.lua reply for a never-placed user: [charges, max, cooldownUntil].
    // ARGV (post-numKeys) is [now, interval, amount, max, ttl]; arrive full.
    const max = Number(args[3]);
    return [max, max, 0];
  }
  on(event: "message" | "ready", cb: MessageListener | ReadyListener): this {
    if (event === "message") this.bus.messageListeners.push(cb as MessageListener);
    if (event === "ready") this.bus.readyListeners.push(cb as ReadyListener);
    return this;
  }
  async subscribe(_channel: string): Promise<number> {
    return 1;
  }
  disconnect(): void {
    /* no-op */
  }
}

/**
 * Emulates `place.lua` in process: gauge token-bucket (refill → check → consume)
 * using the canonical `refillGauge`, bounds + palette validation, and a DELTA
 * publish onto the gateway's delta channel so propagation latency is measurable.
 *
 * The KEYS/ARGV split mirrors `placeArgs` exactly (see redis-scripts/index.ts):
 *   KEYS = [pixels, gaugeKey, meta, frozen, stream, bans, opKey]
 *   ARGV = [x, y, width, height, color, paletteSize, now, refillIntervalMs,
 *           refillAmount, gaugeMax, gaugeTtlMs, deltaChannel, userId, opId,
 *           opTtlMs, streamMaxLen]
 * Reply = [status, charges, max, cooldownUntil] (parsePlaceResult).
 */
export class EmulatedPlaceRunner implements PlaceScriptRunner {
  /** Per-user gauge state, keyed by the gauge Redis key (KEYS[1]). */
  private readonly gauges = new Map<string, StoredGauge>();

  constructor(private readonly bus: Bus) {}

  async run(keys: readonly string[], argv: readonly string[]): Promise<unknown> {
    const gaugeKey = keys[1]!;
    const metaKey = keys[2]!;
    const x = Number(argv[0]);
    const y = Number(argv[1]);
    const width = Number(argv[2]);
    const height = Number(argv[3]);
    const color = Number(argv[4]);
    const paletteSize = Number(argv[5]);
    const now = Number(argv[6]);
    const params: GaugeParams = {
      refillIntervalMs: Number(argv[7]),
      refillAmount: Number(argv[8]),
      gaugeMax: Number(argv[9]),
      gaugeTtlMs: Number(argv[10]),
    };
    const deltaChannel = argv[11]!;

    const state = refillGauge(this.gauges.get(gaugeKey) ?? null, now, params);

    if (x < 0 || x >= width || y < 0 || y >= height) {
      this.gauges.set(gaugeKey, { charges: state.charges, ts: state.ts });
      return ["out_of_bounds", state.charges, params.gaugeMax, nextRefillAt(state, params)];
    }
    if (!Number.isInteger(color) || color < 0 || color >= paletteSize) {
      this.gauges.set(gaugeKey, { charges: state.charges, ts: state.ts });
      return ["invalid_color", state.charges, params.gaugeMax, nextRefillAt(state, params)];
    }
    if (state.charges <= 0) {
      this.gauges.set(gaugeKey, { charges: state.charges, ts: state.ts });
      return ["cooldown", 0, params.gaugeMax, state.ts + params.refillIntervalMs];
    }

    // Consume one charge and fan the write out, exactly as place.lua does.
    const charges = state.charges - 1;
    this.gauges.set(gaugeKey, { charges, ts: state.ts });
    const version = (Number(this.bus.store.get(metaKey)) || 0) + 1;
    this.bus.store.set(metaKey, String(version));
    this.bus.publish(deltaChannel, `${version},${x},${y},${color}`);
    const cooldownUntil = charges > 0 ? 0 : nextRefillAt({ charges, max: params.gaugeMax, ts: state.ts }, params);
    return ["ok", charges, params.gaugeMax, cooldownUntil];
  }
}

export interface DryRunStack {
  pair: RedisPair;
  placeRunner: EmulatedPlaceRunner;
  /** Seed a key in the shared store (e.g. the empty canvas snapshot). */
  seed(key: string, value: string | Buffer): void;
  /** Mimic ioredis 'ready' so the gateway's ring buffer initialises. */
  fireReady(): void;
}

/**
 * Build a single shared bus + a RedisPair (cmd/sub) + the emulated place runner,
 * all wired to the same in-memory store and pub/sub bus so a place fans out to
 * every connected gateway socket exactly as production Redis pub/sub would.
 */
export function createDryRunStack(): DryRunStack {
  const bus = new Bus();
  const cmd = new DryRunRedis(bus);
  const sub = new DryRunRedis(bus);
  return {
    pair: { cmd, sub } as unknown as RedisPair,
    placeRunner: new EmulatedPlaceRunner(bus),
    seed: (key, value) => bus.store.set(key, value),
    fireReady: () => bus.fireReady(),
  };
}
