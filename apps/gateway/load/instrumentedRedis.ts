/**
 * Instrumented in-memory Redis for the FEN-50 fan-out load proof.
 *
 * Same shape as src/test/fakeRedis.ts (the subset of ioredis redis.ts calls),
 * but every command is COUNTED, split by handle (cmd vs sub) and by command
 * name. That lets the harness assert the CA1 invariant directly: placing one
 * pixel while N sockets are connected issues ZERO extra Redis commands on the
 * fan-out path, and the delta subscription count stays 1 regardless of N.
 *
 * Using an instrumented in-process Redis is a STRONGER proof of the command-
 * count-stays-flat claim than a live server: we observe the exact command
 * stream the gateway issues, with no sampling. The in-process fan-out loop
 * (Gateway.flush over this.clients) and the WebSocket sockets are the real
 * gateway code either way — only the Redis transport is substituted.
 */
import type { RedisPair } from "../src/redis";

type MessageListener = (channel: string, payload: string) => void;
type ReadyListener = () => void;

export interface CommandCounts {
  /** Per-command-name invocation counts (e.g. { multi: 3, set: 1, subscribe: 1 }). */
  byName: Record<string, number>;
  /** Total commands across all names. */
  total: number;
  /** subscribe() invocations — the CA1 "one delta subscription" check. */
  subscribeCalls: number;
}

class Counter implements CommandCounts {
  byName: Record<string, number> = {};
  total = 0;
  subscribeCalls = 0;
  bump(name: string): void {
    this.byName[name] = (this.byName[name] ?? 0) + 1;
    this.total++;
  }
  snapshot(): CommandCounts {
    return { byName: { ...this.byName }, total: this.total, subscribeCalls: this.subscribeCalls };
  }
}

class Bus {
  readonly store = new Map<string, string | Buffer>();
  readonly messageListeners: MessageListener[] = [];
  readonly readyListeners: ReadyListener[] = [];
  publish(channel: string, payload: string): void {
    for (const l of this.messageListeners) l(channel, payload);
  }
  fireReady(): void {
    for (const l of this.readyListeners) l();
  }
}

class InstrumentedRedis {
  constructor(
    private readonly bus: Bus,
    private readonly counts: Counter,
  ) {}

  multi() {
    this.counts.bump("multi");
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
    this.counts.bump("set");
    this.bus.store.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<number> {
    this.counts.bump("del");
    return this.bus.store.delete(key) ? 1 : 0;
  }

  async scan(_cursor: string, _match: "MATCH", pattern: string) {
    this.counts.bump("scan");
    const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
    const keys = [...this.bus.store.keys()].filter((k) => k.startsWith(prefix));
    return ["0", keys] as [string, string[]];
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    this.counts.bump("mget");
    return keys.map((k) => {
      const v = this.bus.store.get(k);
      return v === undefined ? null : typeof v === "string" ? v : v.toString();
    });
  }

  on(event: "message" | "ready", cb: MessageListener | ReadyListener): this {
    if (event === "message") this.bus.messageListeners.push(cb as MessageListener);
    if (event === "ready") this.bus.readyListeners.push(cb as ReadyListener);
    return this;
  }

  async subscribe(_channel: string): Promise<number> {
    this.counts.bump("subscribe");
    this.counts.subscribeCalls++;
    return 1;
  }

  disconnect(): void {
    /* no-op */
  }
}

export interface InstrumentedHarness {
  pair: RedisPair;
  /** Counts for the command handle (snapshot reads, presence). */
  cmd: Counter;
  /** Counts for the subscriber handle (subscribe + delivered messages). */
  sub: Counter;
  seed(key: string, value: string | Buffer): void;
  /** Simulate place.lua publishing one fanned-out write onto DELTA_CHANNEL. */
  publish(channel: string, payload: string): void;
  fireReady(): void;
}

export function createInstrumentedRedis(): InstrumentedHarness {
  const bus = new Bus();
  const cmdCounts = new Counter();
  const subCounts = new Counter();
  const cmd = new InstrumentedRedis(bus, cmdCounts);
  const sub = new InstrumentedRedis(bus, subCounts);
  return {
    pair: { cmd, sub } as unknown as RedisPair,
    cmd: cmdCounts,
    sub: subCounts,
    seed: (key, value) => bus.store.set(key, value),
    publish: (channel, payload) => bus.publish(channel, payload),
    fireReady: () => bus.fireReady(),
  };
}
