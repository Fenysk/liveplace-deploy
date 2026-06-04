/**
 * A tiny in-memory stand-in for the subset of ioredis the gateway uses. Lets us
 * drive the gateway end-to-end (real HTTP + WebSocket, real coalescing/resync/
 * presence logic) without a Redis server in CI. The cmd and sub handles share
 * one bus, so a PUBLISH reaches the subscriber exactly as Redis pub/sub would.
 *
 * This is test scaffolding — not a Redis implementation. It models only what
 * redis.ts calls: MULTI(get+getBuffer), set/del/scan/mget, subscribe, and the
 * "message"/"ready" events.
 */
import type { RedisPair } from "../redis";

type MessageListener = (channel: string, payload: string) => void;

class FakeBus {
  readonly store = new Map<string, string | Buffer>();
  readonly listeners: MessageListener[] = [];

  publish(channel: string, payload: string): void {
    for (const l of this.listeners) l(channel, payload);
  }
}

class FakeRedis {
  constructor(private readonly bus: FakeBus) {}

  multi() {
    const ops: Array<{ kind: "get" | "getBuffer"; key: string }> = [];
    const chain = {
      get: (key: string) => {
        ops.push({ kind: "get", key });
        return chain;
      },
      getBuffer: (key: string) => {
        ops.push({ kind: "getBuffer", key });
        return chain;
      },
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

  async set(key: string, value: string, _px: "PX", _ttl: number): Promise<"OK"> {
    this.bus.store.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<number> {
    return this.bus.store.delete(key) ? 1 : 0;
  }

  async scan(_cursor: string, _match: "MATCH", pattern: string, _count: "COUNT", _n: number) {
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

  // Minimal Lua surface: only the read-only refill-peek (initial gauge frame,
  // FEN-184) is EVALSHA'd on the connect path these e2e tests exercise. Model a
  // never-placed user as conceptually full at the requested effective max, with no
  // cooldown — enough to assert the gauge frame is pushed. ARGV (post-numKeys) is
  // [gaugeKey, now, interval, amount, max]; reply shape is [charges, max, cooldown].
  async script(_sub: "LOAD", _lua: string): Promise<string> {
    return "sha-fake";
  }

  async evalsha(_sha: string, _numKeys: number, ...args: string[]): Promise<unknown> {
    const max = Number(args[4]);
    return [max, max, 0];
  }

  on(event: "message" | "ready", cb: MessageListener | (() => void)): this {
    if (event === "message") this.bus.listeners.push(cb as MessageListener);
    return this;
  }

  async subscribe(_channel: string): Promise<number> {
    return 1;
  }

  disconnect(): void {
    /* no-op */
  }
}

export interface FakeRedisHarness {
  pair: RedisPair;
  /** Seed a key in the shared store. */
  seed(key: string, value: string | Buffer): void;
  /** Simulate place.lua publishing a fanned-out write. */
  publish(channel: string, payload: string): void;
}

export function createFakeRedis(): FakeRedisHarness {
  const bus = new FakeBus();
  const cmd = new FakeRedis(bus);
  const sub = new FakeRedis(bus);
  return {
    pair: { cmd, sub } as unknown as RedisPair,
    seed: (key, value) => bus.store.set(key, value),
    publish: (channel, payload) => bus.publish(channel, payload),
  };
}
