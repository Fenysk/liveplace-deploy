import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canvasKeys } from "@canvas/redis-scripts";
import { decodeSnapshot } from "@canvas/protocol";
import { hardRebuildFromPlacements, rebuildAtBoot, rebuildSummary } from "../rebuild.js";
import type { ConvexDurable, PlacementRecord } from "../convex.js";

const SLUG = "fenysk";
// Convex _id returned by fakeConvex's getCanvasDurable — now used as the Redis namespace (FEN-1613).
const CANVAS_ID = "c1";
const W = 4;
const H = 4;

function p(x: number, y: number, color: number, version: number, userId?: string): PlacementRecord {
  return { x, y, color, version, userId, ts: version };
}

/**
 * Minimal in-memory Redis emulating exactly the two ops the rebuild path uses:
 * the OVERWRITE_LUA eval (monotonic meta + pixels write) and the MULTI snapshot
 * read (get meta + getBuffer pixels). meta is stored as a string, pixels as a
 * Buffer — matching how ioredis returns them.
 */
class FakeRedis {
  store = new Map<string, string | Buffer>();

  seed(key: string, val: string | Buffer): void {
    this.store.set(key, val);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async eval(_script: string, numkeys: number, ...args: any[]): Promise<number> {
    const keys = args.slice(0, numkeys) as string[];
    const argv = args.slice(numkeys);
    const metaKey = keys[0]!;
    const pixelsKey = keys[1]!;
    const requested = Number(argv[0]);
    const buf = argv[1] as Buffer;
    const cur = Number(this.store.get(metaKey) ?? "0");
    const effective = cur > requested ? cur : requested;
    this.store.set(metaKey, String(effective));
    this.store.set(pixelsKey, buf);
    return effective;
  }

  // FEN-1598: the one-shot marker (get/set) and the anti-wipe live-grid probe
  // (getBuffer) — the raw string/buffer ops the guard code uses directly.
  async get(key: string): Promise<string | null> {
    const v = this.store.get(key);
    return v == null ? null : String(v);
  }

  async set(key: string, val: string): Promise<"OK"> {
    this.store.set(key, val);
    return "OK";
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    const v = this.store.get(key);
    if (v == null) return null;
    return Buffer.isBuffer(v) ? v : Buffer.from(String(v));
  }

  multi(): FakeMulti {
    return new FakeMulti(this);
  }
}

class FakeMulti {
  private ops: Array<{ kind: "get" | "getBuffer"; key: string }> = [];
  constructor(private redis: FakeRedis) {}
  get(key: string): this {
    this.ops.push({ kind: "get", key });
    return this;
  }
  getBuffer(key: string): this {
    this.ops.push({ kind: "getBuffer", key });
    return this;
  }
  async exec(): Promise<Array<[Error | null, unknown]>> {
    return this.ops.map((op) => {
      const v = this.redis.store.get(op.key) ?? null;
      if (op.kind === "get") return [null, v == null ? null : String(v)];
      return [null, v == null ? null : Buffer.isBuffer(v) ? v : Buffer.from(String(v))];
    });
  }
}

/** Convex stub: serves geometry + placements, captures the recorded snapshot. */
function fakeConvex(opts: {
  durable: { width: number; height: number } | null;
  placements: PlacementRecord[];
}): { convex: ConvexDurable; recorded: Array<{ version: number; bytes: Uint8Array }> } {
  const recorded: Array<{ version: number; bytes: Uint8Array }> = [];
  const convex = {
    async getCanvasDurable() {
      return opts.durable
        ? { canvasId: "c1", slug: SLUG, width: opts.durable.width, height: opts.durable.height, status: "active", lastSnapshotAt: null }
        : null;
    },
    async getPlacementsSince(_slug: string, afterVersion: number, limit: number) {
      return opts.placements
        .filter((r) => r.version > afterVersion)
        .sort((a, b) => a.version - b.version)
        .slice(0, limit)
        .map((r) => ({ ...r, canvasId: "c1" }));
    },
    async recordSnapshot(_slug: string, version: number, bytes: Uint8Array) {
      recorded.push({ version, bytes });
      return { canvasFound: true };
    },
  } as unknown as ConvexDurable;
  return { convex, recorded };
}

describe("hardRebuildFromPlacements", () => {
  it("rebuilds the grid from v0, overwriting a comingled snapshot, and records a fresh snapshot", async () => {
    const redis = new FakeRedis();
    // Pre-existing (stale/comingled) grid: full of index 5, high live counter.
    // Seeded under CANVAS_ID (Convex _id) — the rebuild now uses durable.canvasId as
    // the Redis namespace (FEN-1613), not the slug.
    redis.seed(canvasKeys(CANVAS_ID).meta, "900");
    redis.seed(canvasKeys(CANVAS_ID).pixels, Buffer.alloc(W * H, 5));

    const placements = [
      p(0, 0, 3, 10, "keep"),
      p(1, 1, 7, 20, "keep"),
      p(1, 1, 4, 25, "keep"), // last-write-wins at (1,1) → 4
    ];
    const { convex, recorded } = fakeConvex({ durable: { width: W, height: H }, placements });

    const r = await hardRebuildFromPlacements(redis as never, convex, SLUG, { now: () => 1000 });

    assert.equal(r.ok, true);
    assert.equal(r.placements, 3);
    assert.equal(r.nonEmpty, 2, "only (0,0) and (1,1) painted");
    // Counter must NOT regress below the live head (900), even though replay max is 25.
    assert.equal(r.version, 900, "meta clamped up to the live counter");

    // Grid was overwritten under CANVAS_ID (Convex _id): (0,0)=3, (1,1)=4, rest cleared.
    const grid = redis.store.get(canvasKeys(CANVAS_ID).pixels) as Buffer;
    assert.equal(grid[0], 3);
    assert.equal(grid[1 * W + 1], 4);
    assert.equal(grid[2], 0, "old comingled pixel cleared");

    // Fresh snapshot recorded from the rebuilt grid, stamped at the effective version.
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.version, 900);
    // Copy into a fresh Uint8Array so `.buffer` is a plain ArrayBuffer (the
    // recorded blob may be a subarray view over a larger/shared buffer).
    const decoded = decodeSnapshot(new Uint8Array(recorded[0]!.bytes).buffer);
    assert.equal(decoded.pixels[0], 3);
    assert.equal(decoded.pixels[1 * W + 1], 4);
  });

  it("populates an empty slug with no prior grid (trishael case) and adopts the replay version", async () => {
    const redis = new FakeRedis(); // no seeded grid → meta absent (== 0)
    const placements = [p(2, 2, 6, 30, "trishael"), p(3, 3, 8, 34, "trishael")];
    const { convex, recorded } = fakeConvex({ durable: { width: W, height: H }, placements });

    const r = await hardRebuildFromPlacements(redis as never, convex, SLUG, { now: () => 1 });

    assert.equal(r.ok, true);
    assert.equal(r.nonEmpty, 2);
    assert.equal(r.version, 34, "no live counter → adopts the replay max version");
    const grid = redis.store.get(canvasKeys(CANVAS_ID).pixels) as Buffer;
    assert.equal(grid[2 * W + 2], 6);
    assert.equal(grid[3 * W + 3], 8);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.version, 34);
  });

  it("FEN-1584: reconstructs at the ENGINE dims, not the smaller durable F2 dims (placements beyond the F2 box still render)", async () => {
    const redis = new FakeRedis();
    // Durable F2 row is incoherently small (mirrors prod: fenysk 50×50). A
    // placement at (5,6) lives OUTSIDE this 4×4 box but INSIDE the 8×8 engine grid.
    const ENGINE = 8;
    const placements = [
      p(1, 1, 3, 10, "keep"), // inside both boxes
      p(5, 6, 7, 20, "keep"), // OUTSIDE the 4×4 F2 box → dropped by the old (buggy) code
    ];
    const { convex, recorded } = fakeConvex({ durable: { width: W, height: H }, placements });

    // Pass the engine geometry explicitly (as apps/worker/src/index.ts now does).
    const r = await hardRebuildFromPlacements(redis as never, convex, SLUG, {
      now: () => 500,
      width: ENGINE,
      height: ENGINE,
    });

    assert.equal(r.ok, true);
    assert.equal(r.width, ENGINE, "rebuilt at engine width, not F2 width");
    assert.equal(r.height, ENGINE);
    assert.equal(r.nonEmpty, 2, "BOTH placements render — the out-of-F2-box one is no longer dropped");

    const grid = redis.store.get(canvasKeys(CANVAS_ID).pixels) as Buffer;
    assert.equal(grid.length, ENGINE * ENGINE, "grid sized to the engine dims");
    assert.equal(grid[1 * ENGINE + 1], 3);
    assert.equal(grid[6 * ENGINE + 5], 7, "the (5,6) placement is painted in the 512²-style space");

    // Snapshot is recorded at the engine dims too, so cold-restore re-hydrates correctly.
    assert.equal(recorded.length, 1);
    const decoded = decodeSnapshot(new Uint8Array(recorded[0]!.bytes).buffer);
    assert.equal(decoded.width, ENGINE);
    assert.equal(decoded.pixels[6 * ENGINE + 5], 7);
  });

  it("bails without touching Redis when the durable canvas row is missing", async () => {
    const redis = new FakeRedis();
    const { convex, recorded } = fakeConvex({ durable: null, placements: [] });
    const r = await hardRebuildFromPlacements(redis as never, convex, SLUG);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no_durable_canvas");
    assert.equal(recorded.length, 0);
    assert.equal(redis.store.size, 0, "no writes");
  });

  it("emits a compact scrapeable summary line", () => {
    const line = rebuildSummary({
      slug: SLUG,
      ok: true,
      reason: "rebuilt_from_placements",
      width: W,
      height: H,
      placements: 279,
      nonEmpty: 250,
      version: 900,
      snapshotVersion: 900,
      snapshotBytes: 1234,
    });
    assert.match(line, /FEN1576_REBUILD slug=fenysk ok=true reason=rebuilt_from_placements/);
    assert.match(line, /placements=279 nonEmpty=250 version=900 snapV=900 bytes=1234 geom=4x4/);
  });
});

/**
 * FEN-1586 — the boot orchestrator's bounded readiness retry. A Convex-reach
 * failure (secret not yet seeded on a cold force-deploy) surfaces as a THROW from
 * getCanvasDurable/getPlacementsSince; a genuine missing row surfaces as a returned
 * result. So throws are retried (bounded); returned results are terminal.
 */
describe("rebuildAtBoot (FEN-1586 readiness retry)", () => {
  // Convex stub whose getCanvasDurable throws for the first `failFirst` calls
  // (simulating worker:run rejecting until GATEWAY_INTERNAL_SECRET is seeded),
  // then serves geometry + placements normally.
  function flakyConvex(opts: {
    failFirst: number;
    durable?: { width: number; height: number } | null;
    placements?: PlacementRecord[];
  }): { convex: ConvexDurable; calls: () => number; recorded: Array<{ version: number }> } {
    const durable = opts.durable === undefined ? { width: W, height: H } : opts.durable;
    const placements = opts.placements ?? [p(0, 0, 3, 10, "keep")];
    const recorded: Array<{ version: number }> = [];
    let getCanvasCalls = 0;
    const convex = {
      async getCanvasDurable() {
        getCanvasCalls++;
        if (getCanvasCalls <= opts.failFirst) throw new Error("worker:run rejected: bad secret");
        return durable
          ? { canvasId: "c1", slug: SLUG, width: durable.width, height: durable.height, status: "active", lastSnapshotAt: null }
          : null;
      },
      async getPlacementsSince(_slug: string, afterVersion: number, limit: number) {
        return placements
          .filter((r) => r.version > afterVersion)
          .sort((a, b) => a.version - b.version)
          .slice(0, limit)
          .map((r) => ({ ...r, canvasId: "c1" }));
      },
      async recordSnapshot(_slug: string, version: number) {
        recorded.push({ version });
        return { canvasFound: true };
      },
    } as unknown as ConvexDurable;
    return { convex, calls: () => getCanvasCalls, recorded };
  }

  function capture(): { log: (m: string, e?: Record<string, unknown>) => void; lines: string[] } {
    const lines: string[] = [];
    return { log: (m) => lines.push(m), lines };
  }

  it("retries on a thrown Convex error then runs the rebuild once the secret is seeded", async () => {
    const redis = new FakeRedis();
    const { convex, recorded } = flakyConvex({ failFirst: 3 });
    const { log, lines } = capture();
    let slept = 0;

    await rebuildAtBoot(
      { slugs: [SLUG], width: W, height: H, secretPresent: true, maxAttempts: 10, retryDelayMs: 5, force: false, forceEmpty: false },
      { redis: redis as never, convex, log, sleep: async () => void slept++, now: () => 1 },
    );

    assert.equal(slept, 3, "slept between the 3 failing attempts (before the 4th succeeds)");
    assert.ok(lines.some((l) => l.includes("succeeded after retry")), "logs a retry-success line");
    assert.ok(lines.some((l) => /FEN1576_REBUILD slug=fenysk ok=true/.test(l)), "runs the actual rebuild");
    assert.ok(!lines.some((l) => l.includes("FEN1586_REBUILD_ABORTED")), "no abort line");
    assert.equal(recorded.length, 1, "a fresh snapshot was recorded");
  });

  it("emits an explicit non-silent abort line after exhausting attempts (secret never seeded)", async () => {
    const redis = new FakeRedis();
    const { convex, calls, recorded } = flakyConvex({ failFirst: 1_000 }); // never recovers
    const { log, lines } = capture();

    await rebuildAtBoot(
      { slugs: [SLUG], width: W, height: H, secretPresent: false, maxAttempts: 4, retryDelayMs: 1, force: false, forceEmpty: false },
      { redis: redis as never, convex, log, sleep: async () => {}, now: () => 1 },
    );

    assert.equal(calls(), 4, "attempted exactly maxAttempts times");
    const abort = lines.find((l) => l.includes("FEN1586_REBUILD_ABORTED"));
    assert.ok(abort, "emits an explicit scrapeable abort line (not silent)");
    assert.match(abort!, /slug=fenysk reason=convex_unready attempts=4 secretPresent=false/);
    assert.equal(recorded.length, 0, "no snapshot recorded — grid untouched");
    assert.equal(redis.store.size, 0, "no Redis writes on abort");
  });

  it("does NOT retry a genuine missing durable row (returned result is terminal)", async () => {
    const redis = new FakeRedis();
    const { convex, calls } = flakyConvex({ failFirst: 0, durable: null }); // reachable, no row
    const { log, lines } = capture();
    let slept = 0;

    await rebuildAtBoot(
      { slugs: [SLUG], width: W, height: H, secretPresent: true, maxAttempts: 10, retryDelayMs: 5, force: false, forceEmpty: false },
      { redis: redis as never, convex, log, sleep: async () => void slept++, now: () => 1 },
    );

    assert.equal(calls(), 1, "getCanvasDurable called once — no_durable_canvas is not retried");
    assert.equal(slept, 0, "never slept");
    assert.ok(lines.some((l) => /FEN1576_REBUILD slug=fenysk ok=false reason=no_durable_canvas/.test(l)));
    assert.ok(!lines.some((l) => l.includes("FEN1586_REBUILD_ABORTED")), "a definitive answer is not an abort");
  });

  it("isolates slugs: one exhausting does not stop another from rebuilding", async () => {
    const redis = new FakeRedis();
    // 'bad' throws forever; 'fenysk' is served. Interleave via a per-slug stub.
    const recorded: Array<{ version: number }> = [];
    const convex = {
      async getCanvasDurable(slug: string) {
        if (slug === "bad") throw new Error("worker:run rejected");
        return { canvasId: "c1", slug, width: W, height: H, status: "active", lastSnapshotAt: null };
      },
      async getPlacementsSince() {
        return [{ ...p(0, 0, 3, 10, "keep"), canvasId: "c1" }];
      },
      async recordSnapshot(_slug: string, version: number) {
        recorded.push({ version });
        return { canvasFound: true };
      },
    } as unknown as ConvexDurable;
    const { log, lines } = capture();

    await rebuildAtBoot(
      { slugs: ["bad", "fenysk"], width: W, height: H, secretPresent: true, maxAttempts: 2, retryDelayMs: 1, force: false, forceEmpty: false },
      { redis: redis as never, convex, log, sleep: async () => {}, now: () => 1 },
    );

    assert.ok(lines.some((l) => /FEN1586_REBUILD_ABORTED slug=bad/.test(l)), "'bad' aborts explicitly");
    assert.ok(lines.some((l) => /FEN1576_REBUILD slug=fenysk ok=true/.test(l)), "'fenysk' still rebuilds");
    assert.equal(recorded.length, 1, "only fenysk recorded a snapshot");
  });
});

// Marker key scoped to CANVAS_ID (_id, "c1") — post N8 the marker uses the
// Convex _id namespace (canvasKeys(canvasId).rebuiltAt), not slug.
const MARKER = canvasKeys(CANVAS_ID).rebuiltAt;

/**
 * FEN-1598 anti-wipe guard — an empty replay must NOT clobber+snapshot a
 * populated live grid (irreversible under snapshot-only restore) unless the
 * operator explicitly forces it.
 */
describe("hardRebuildFromPlacements anti-wipe guard (FEN-1598)", () => {
  function seedPopulated(redis: FakeRedis): void {
    // Seed under CANVAS_ID (Convex _id) — after FEN-1613 the rebuild reads/writes
    // canvas:{convexId}:* not canvas:{slug}:* (matches the gateway's namespace).
    redis.seed(canvasKeys(CANVAS_ID).meta, "900");
    redis.seed(canvasKeys(CANVAS_ID).pixels, Buffer.alloc(W * H, 5)); // every cell painted (5)
  }

  it("ABORTS when the replay has NO placements but the live grid is populated", async () => {
    const redis = new FakeRedis();
    seedPopulated(redis);
    const { convex, recorded } = fakeConvex({ durable: { width: W, height: H }, placements: [] });

    const r = await hardRebuildFromPlacements(redis as never, convex, SLUG, { now: () => 1000 });

    assert.equal(r.ok, false);
    assert.equal(r.reason, "empty_replay_abort");
    assert.equal(r.liveNonEmpty, W * H, "reported the painted-cell count it refused to wipe");
    assert.equal(recorded.length, 0, "no snapshot recorded — the blank was never persisted");
    const grid = redis.store.get(canvasKeys(CANVAS_ID).pixels) as Buffer;
    assert.ok(grid.every((b) => b === 5), "live grid untouched (still fully painted)");
    assert.equal(redis.store.get(canvasKeys(CANVAS_ID).meta), "900", "meta counter untouched");
  });

  it("ABORTS when placements exist but all reconstruct to 0 painted cells (nonEmpty===0)", async () => {
    const redis = new FakeRedis();
    seedPopulated(redis);
    // Placements are present but paint color 0 (== unpainted) → nonEmpty is 0.
    const placements = [p(0, 0, 0, 10, "x"), p(1, 1, 0, 20, "x")];
    const { convex, recorded } = fakeConvex({ durable: { width: W, height: H }, placements });

    const r = await hardRebuildFromPlacements(redis as never, convex, SLUG, { now: () => 1000 });

    assert.equal(r.ok, false);
    assert.equal(r.reason, "empty_replay_abort");
    assert.equal(recorded.length, 0);
    const grid = redis.store.get(canvasKeys(CANVAS_ID).pixels) as Buffer;
    assert.ok(grid.every((b) => b === 5), "live grid untouched");
  });

  it("PROCEEDS with an empty replay when REBUILD_FORCE_EMPTY is set (deliberate clear)", async () => {
    const redis = new FakeRedis();
    seedPopulated(redis);
    const { convex, recorded } = fakeConvex({ durable: { width: W, height: H }, placements: [] });

    const r = await hardRebuildFromPlacements(redis as never, convex, SLUG, {
      now: () => 1000,
      forceEmpty: true,
    });

    assert.equal(r.ok, true, "forced empty rebuild runs");
    assert.equal(r.nonEmpty, 0);
    assert.equal(recorded.length, 1, "the (deliberately) empty grid is snapshotted");
    const grid = redis.store.get(canvasKeys(CANVAS_ID).pixels) as Buffer;
    assert.ok(grid.every((b) => b === 0), "grid cleared as requested");
  });

  it("PROCEEDS with an empty replay when the live grid is ALSO empty/absent (nothing to lose)", async () => {
    const redis = new FakeRedis(); // no seeded pixels → live grid absent
    const { convex, recorded } = fakeConvex({ durable: { width: W, height: H }, placements: [] });

    const r = await hardRebuildFromPlacements(redis as never, convex, SLUG, { now: () => 1000 });

    assert.equal(r.ok, true, "blank→blank is a legitimate no-op, not an abort");
    assert.equal(recorded.length, 1);
  });
});

/**
 * FEN-1598 one-shot lock — a persistent `rebuiltAt:<slug>` marker stops a
 * crash-loop / forgotten REBUILD_SLUGS env from replaying the rebuild every boot.
 */
describe("rebuildAtBoot one-shot lock (FEN-1598)", () => {
  function countingConvex(): { convex: ConvexDurable; canvasCalls: () => number; recorded: Array<{ version: number }> } {
    let canvasCalls = 0;
    const recorded: Array<{ version: number }> = [];
    const convex = {
      async getCanvasDurable() {
        canvasCalls++;
        return { canvasId: "c1", slug: SLUG, width: W, height: H, status: "active", lastSnapshotAt: null };
      },
      async getPlacementsSince(_slug: string, afterVersion: number) {
        return [p(0, 0, 3, 10, "keep")].filter((r) => r.version > afterVersion).map((r) => ({ ...r, canvasId: "c1" }));
      },
      async recordSnapshot(_slug: string, version: number) {
        recorded.push({ version });
        return { canvasFound: true };
      },
    } as unknown as ConvexDurable;
    return { convex, canvasCalls: () => canvasCalls, recorded };
  }

  function capture(): { log: (m: string) => void; lines: string[] } {
    const lines: string[] = [];
    return { log: (m) => lines.push(m), lines };
  }

  it("stamps the marker after a successful rebuild", async () => {
    const redis = new FakeRedis();
    const { convex, recorded } = countingConvex();
    const { log } = capture();

    await rebuildAtBoot(
      { slugs: [SLUG], width: W, height: H, secretPresent: true, maxAttempts: 3, retryDelayMs: 1, force: false, forceEmpty: false },
      { redis: redis as never, convex, log, sleep: async () => {}, now: () => 4242 },
    );

    assert.equal(recorded.length, 1, "rebuilt once");
    assert.equal(redis.store.get(MARKER), "4242", "marker stamped with now()");
  });

  it("SKIPS a slug that already carries the marker (second boot, no force)", async () => {
    const redis = new FakeRedis();
    redis.seed(MARKER, "1111"); // prior successful rebuild
    const { convex, canvasCalls, recorded } = countingConvex();
    const { log, lines } = capture();

    await rebuildAtBoot(
      { slugs: [SLUG], width: W, height: H, secretPresent: true, maxAttempts: 3, retryDelayMs: 1, force: false, forceEmpty: false },
      { redis: redis as never, convex, log, sleep: async () => {}, now: () => 2222 },
    );

    assert.equal(canvasCalls(), 1, "1 Convex call to resolve canvasId for marker check (N8: marker uses _id not slug)");
    assert.equal(recorded.length, 0, "no snapshot — the destructive path never ran");
    assert.ok(lines.some((l) => /FEN1598_REBUILD_SKIPPED slug=fenysk reason=already_rebuilt rebuiltAt=1111/.test(l)));
    assert.equal(redis.store.get(MARKER), "1111", "marker unchanged");
  });

  it("RE-RUNS despite the marker when REBUILD_FORCE is set", async () => {
    const redis = new FakeRedis();
    redis.seed(MARKER, "1111");
    const { convex, canvasCalls, recorded } = countingConvex();
    const { log, lines } = capture();

    await rebuildAtBoot(
      { slugs: [SLUG], width: W, height: H, secretPresent: true, maxAttempts: 3, retryDelayMs: 1, force: true, forceEmpty: false },
      { redis: redis as never, convex, log, sleep: async () => {}, now: () => 3333 },
    );

    assert.ok(canvasCalls() >= 1, "forced re-run does the Convex work");
    assert.equal(recorded.length, 1, "rebuilt again");
    assert.ok(!lines.some((l) => l.includes("FEN1598_REBUILD_SKIPPED")), "not skipped");
    assert.equal(redis.store.get(MARKER), "3333", "marker refreshed to the new run");
  });

  it("does NOT stamp the marker on an anti-wipe abort (stays retriable next boot)", async () => {
    const redis = new FakeRedis();
    // Seed under CANVAS_ID — the guard reads canvas:{convexId}:pixels after FEN-1613.
    redis.seed(canvasKeys(CANVAS_ID).meta, "900");
    redis.seed(canvasKeys(CANVAS_ID).pixels, Buffer.alloc(W * H, 5)); // populated live grid
    // Convex serves the row but NO placements → empty replay → anti-wipe abort.
    const { convex, recorded } = fakeConvex({ durable: { width: W, height: H }, placements: [] });
    const { log, lines } = capture();

    await rebuildAtBoot(
      { slugs: [SLUG], width: W, height: H, secretPresent: true, maxAttempts: 3, retryDelayMs: 1, force: false, forceEmpty: false },
      { redis: redis as never, convex, log, sleep: async () => {}, now: () => 5555 },
    );

    assert.equal(recorded.length, 0, "no snapshot — grid never wiped");
    assert.equal(redis.store.has(MARKER), false, "NO marker — the operator can fix the data and re-run");
    assert.ok(lines.some((l) => /FEN1576_REBUILD slug=fenysk ok=false reason=empty_replay_abort/.test(l)));
    const grid = redis.store.get(canvasKeys(CANVAS_ID).pixels) as Buffer;
    assert.ok(grid.every((b) => b === 5), "live grid intact");
  });
});
