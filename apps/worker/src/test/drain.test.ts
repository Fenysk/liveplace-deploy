import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canvasKeys, STREAM_FIELDS } from "@canvas/redis-scripts";
import { drainOnce } from "../drain.js";
import type { ConvexDurable, ApplyFlushResult, PlacementRecord } from "../convex.js";

const SLUG = "test-canvas";
const STREAM = canvasKeys(SLUG).stream;

function entry(id: string, x: number, y: number, color: number, version: number): [string, string[]] {
  const map: Record<string, string> = {
    x: String(x),
    y: String(y),
    color: String(color),
    version: String(version),
    userId: "u",
    ts: String(version),
  };
  return [id, STREAM_FIELDS.flatMap((f) => [f, map[f]!])];
}

function cmp(a: string, b: string): number {
  const [am, as] = a.split("-").map(Number);
  const [bm, bs] = b.split("-").map(Number);
  return am !== bm ? am! - bm! : (as ?? 0) - (bs ?? 0);
}

/** In-memory stand-in for the two Redis calls drainOnce makes (xread/xtrim). */
class FakeRedis {
  entries: Array<[string, string[]]>;
  trims: string[] = [];
  constructor(entries: Array<[string, string[]]>) {
    this.entries = entries;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async xread(...args: any[]): Promise<any> {
    const count = Number(args[1]);
    const key = args[3];
    const cursor = args[4];
    if (key !== STREAM) return null;
    const after = this.entries.filter(([id]) => cmp(id, cursor) > 0).slice(0, count);
    return after.length ? [[key, after]] : null;
  }
  async xtrim(_key: string, _strategy: string, minId: string): Promise<number> {
    this.trims.push(minId);
    const before = this.entries.length;
    this.entries = this.entries.filter(([id]) => cmp(id, minId) >= 0);
    return before - this.entries.length;
  }
}

class FakeConvex {
  calls: Array<{ lastStreamId: string; placements: PlacementRecord[] }> = [];
  constructor(private readonly result: ApplyFlushResult) {}
  async applyFlush(
    _slug: string,
    lastStreamId: string,
    placements: PlacementRecord[],
  ): Promise<ApplyFlushResult> {
    this.calls.push({ lastStreamId, placements });
    return { ...this.result, inserted: placements.length, maxVersion: this.result.maxVersion };
  }
}

function deps(redis: FakeRedis, convex: FakeConvex) {
  return {
    redis: redis as unknown as import("ioredis").default,
    convex: convex as unknown as ConvexDurable,
    slug: SLUG,
    maxBatch: 500,
    now: () => 123,
  };
}

describe("drainOnce", () => {
  it("flushes a batch, advances the cursor, and trims after confirmation", async () => {
    const redis = new FakeRedis([entry("1-0", 0, 0, 1, 1), entry("2-0", 1, 0, 2, 2)]);
    const convex = new FakeConvex({ canvasFound: true, maxVersion: 2, inserted: 0 });
    const out = await drainOnce(deps(redis, convex), "0");

    assert.equal(out.empty, false);
    assert.equal(out.canvasFound, true);
    assert.equal(out.inserted, 2);
    assert.equal(out.cursor, "2-0", "cursor advances to the last drained id");
    assert.equal(convex.calls[0]!.lastStreamId, "2-0");
    assert.deepEqual(redis.trims, ["2-0"], "trims the drained tail exactly once");
  });

  it("does NOT advance the cursor or trim when the canvas row is missing", async () => {
    const redis = new FakeRedis([entry("1-0", 0, 0, 1, 1)]);
    const convex = new FakeConvex({ canvasFound: false, maxVersion: 0, inserted: 0 });
    const out = await drainOnce(deps(redis, convex), "0");

    assert.equal(out.canvasFound, false);
    assert.equal(out.cursor, "0", "cursor stays put until the row exists");
    assert.deepEqual(redis.trims, [], "never trims undrained entries");
  });

  it("reports empty when the stream has nothing past the cursor", async () => {
    const redis = new FakeRedis([entry("1-0", 0, 0, 1, 1)]);
    const convex = new FakeConvex({ canvasFound: true, maxVersion: 1, inserted: 0 });
    const out = await drainOnce(deps(redis, convex), "1-0");

    assert.equal(out.empty, true);
    assert.equal(out.read, 0);
    assert.equal(convex.calls.length, 0, "no flush call when nothing to drain");
    assert.equal(out.cursor, "1-0");
  });
});
