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
  // FEN-242 attribution: set + hash keyspaces (disjoint from `store` strings).
  readonly sets = new Map<string, Set<string>>();
  readonly hashes = new Map<string, Map<string, string>>();
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

  // FEN-242 attribution surface (AttributionRedis): counters, sets, first-wins hash.
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

  // Minimal Lua surface.
  //
  // grid-resize.lua: KEYS=[pixels], ARGV=[oldW, oldH, newW, newH].
  //   Identified by the "grid-resize.lua" comment in the Lua source; implements
  //   the row-major crop/pad in TypeScript so resize tests pass without Redis
  //   (FEN-1802).  Returns the count of surviving non-zero pixels, matching the
  //   real script (parseResizeGridResult expects a single integer).
  //
  // gauge scripts (refill-peek, grant): model a never-placed user as full at
  //   the effective max, no cooldown.  KEYS=[gaugeKey], ARGV=[now,…,max].
  private readonly scriptKinds = new Map<string, "grid-resize" | "gauge">();
  private shaSeq = 0;

  async script(_sub: "LOAD", lua: string): Promise<string> {
    const sha = `sha-${++this.shaSeq}`;
    this.scriptKinds.set(sha, lua.includes("grid-resize.lua") ? "grid-resize" : "gauge");
    return sha;
  }

  async evalsha(sha: string, _numKeys: number, ...args: string[]): Promise<unknown> {
    if (this.scriptKinds.get(sha) === "grid-resize") {
      // args = [pixelsKey, oldW, oldH, newW, newH]
      const pixelsKey = args[0]!;
      const oldW = Number(args[1]);
      const oldH = Number(args[2]);
      const newW = Number(args[3]);
      const newH = Number(args[4]);
      const raw = this.bus.store.get(pixelsKey);
      const oldBuf =
        raw instanceof Buffer ? raw
        : raw != null ? Buffer.from(String(raw), "binary")
        : null;
      const copyW = Math.min(oldW, newW);
      const copyH = Math.min(oldH, newH);
      const newPixels = Buffer.alloc(newW * newH, 0);
      let surviving = 0;
      if (oldBuf && oldBuf.length > 0) {
        for (let row = 0; row < copyH; row++) {
          for (let col = 0; col < copyW; col++) {
            const v = oldBuf[row * oldW + col] ?? 0;
            newPixels[row * newW + col] = v;
            if (v !== 0) surviving++;
          }
        }
      }
      this.bus.store.set(pixelsKey, newPixels);
      return surviving;
    }
    // gauge scripts: args = [gaugeKey, now, interval, amount, max]
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

  async unsubscribe(_channel: string): Promise<number> {
    return 0;
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
