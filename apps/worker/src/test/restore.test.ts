import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cropPadPixels, reconstructPixels, restoreIfNeeded } from "../restore.js";
import { encodeSnapshot } from "@canvas/protocol";
import { canvasKeys } from "@canvas/redis-scripts";
import type { PlacementRecord } from "../convex.js";

const W = 4;
const H = 4;

function p(x: number, y: number, color: number, version: number): PlacementRecord {
  return { x, y, color, version, ts: version };
}

describe("reconstructPixels", () => {
  it("replays only placements newer than the snapshot version", () => {
    const base = new Uint8Array(W * H); // all 0
    base[0] = 7; // baked into the snapshot at (0,0)
    const placements = [
      p(0, 0, 9, 5), // <= snapshotVersion → ignored (already baked)
      p(1, 1, 3, 11),
      p(2, 0, 4, 12),
    ];
    const { pixels, version } = reconstructPixels(base, W, H, 10, placements);
    assert.equal(pixels[0], 7, "snapshot pixel preserved");
    assert.equal(pixels[1 * W + 1], 3);
    assert.equal(pixels[0 * W + 2], 4);
    assert.equal(version, 12, "head version is the max replayed version");
  });

  it("skips out-of-bounds and invalid-color rows defensively", () => {
    const base = new Uint8Array(W * H);
    const placements = [
      p(99, 99, 1, 20), // out of bounds
      p(1, 1, 99999, 21), // invalid color index
      p(3, 3, 2, 22), // valid
    ];
    const { pixels, version } = reconstructPixels(base, W, H, 0, placements);
    assert.equal(pixels[3 * W + 3], 2);
    assert.equal(version, 22);
  });

  it("returns the snapshot version when there is no newer tail", () => {
    const base = new Uint8Array(W * H);
    const { version } = reconstructPixels(base, W, H, 42, []);
    assert.equal(version, 42);
  });
});

// ── R1: cropPadPixels ────────────────────────────────────────────────────────
// Verifies the row-major crop/pad used by restoreIfNeeded and mirrored by
// grid-resize.lua.  A flat subarray copy would scramble row offsets when the
// stride changes; these tests confirm the 2-D correctness (FEN-1802).

describe("cropPadPixels", () => {
  // Build a W×H pixel array with cell (x,y) = x + y*10 for easy tracing.
  function grid(w: number, h: number): Uint8Array {
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x + y * 10) & 0xff;
    return px;
  }

  it("R1a — shrink 20×20 → 10×10: in-frame pixels preserved, out-of-frame zero", () => {
    const src = grid(20, 20);
    const out = cropPadPixels(src, 20, 20, 10, 10);
    assert.equal(out.length, 10 * 10);
    // Check several in-frame cells
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        assert.equal(out[y * 10 + x], src[y * 20 + x], `cell (${x},${y}) preserved`);
      }
    }
  });

  it("R1b — enlarge 10×10 → 20×20: original pixels preserved, new area zero", () => {
    const src = grid(10, 10);
    const out = cropPadPixels(src, 10, 10, 20, 20);
    assert.equal(out.length, 20 * 20);
    // In-frame cells preserved at the correct 2-D position (stride = 20)
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        assert.equal(out[y * 20 + x], src[y * 10 + x], `cell (${x},${y}) preserved`);
      }
    }
    // New columns (x >= 10) in the original rows must be 0
    for (let y = 0; y < 10; y++) {
      for (let x = 10; x < 20; x++) {
        assert.equal(out[y * 20 + x], 0, `new column (${x},${y}) zero`);
      }
    }
    // New rows (y >= 10) must be entirely 0
    for (let y = 10; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        assert.equal(out[y * 20 + x], 0, `new row (${x},${y}) zero`);
      }
    }
  });

  it("identity — same dims returns the input unchanged", () => {
    const src = grid(10, 10);
    assert.strictEqual(cropPadPixels(src, 10, 10, 10, 10), src);
  });

  it("shrink to 1×1 keeps only (0,0)", () => {
    const src = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]); // 3×3
    const out = cropPadPixels(src, 3, 3, 1, 1);
    assert.deepEqual([...out], [1]);
  });
});

// ── R2: restoreIfNeeded dim-mismatch ────────────────────────────────────────
// A snapshot recorded at 20×20 restored onto a durable 10×10 canvas must be
// 2-D cropped, not flat-sliced (FEN-1802/C-C).

describe("restoreIfNeeded — dim mismatch (R2)", () => {
  // Build a minimal fake Redis that satisfies metaExists + writeRestoredCanvas.
  // RESTORE_LUA: eval(lua, 2, keys.meta, keys.pixels, Buffer(pixels), version)
  //   KEYS[1]=meta, KEYS[2]=pixels, ARGV[1]=pixelBuffer, ARGV[2]=version
  //   → args = [metaKey, pixelsKey, Buffer, versionStr]
  function buildFakeRedis() {
    const store = new Map<string, string | Buffer>();
    return {
      store,
      async eval(_lua: string, _numKeys: number, ...args: unknown[]): Promise<unknown> {
        const metaKey = args[0] as string;
        if (store.has(metaKey)) return 0;
        store.set(args[1] as string, args[2] as Buffer);   // pixelsKey → Buffer
        store.set(metaKey, args[3] as string);              // metaKey → version
        return 1;
      },
      async exists(key: string): Promise<number> {
        return store.has(key) ? 1 : 0;
      },
      async get() { return null; },
      async set() { return "OK"; },
    } as unknown as import("ioredis").default;
  }

  // Build a fake Convex that returns a snapshot encoded at (snapW×snapH) with
  // a known pixel at (0,0)=colorA and (snapW,0)=colorB (to detect stride bugs).
  function fakeConvex(snapW: number, snapH: number, durW: number, _durH: number) {
    const pixels = new Uint8Array(snapW * snapH);
    pixels[0] = 42;           // (0,0): always in-frame
    if (snapW > durW) pixels[durW] = 99; // (durW, 0): out-of-frame on shrink
    const encoded = encodeSnapshot(pixels, 1, snapW, snapH);
    const url = "data:test";
    // patch global fetch for this test
    (global as Record<string, unknown>)["fetch"] = async () => ({
      ok: true,
      arrayBuffer: async () => encoded,
    });
    return {
      async getLatestSnapshot(_slug: string) { return { url, version: 1 }; },
      async getPlacementsSince() { return []; },
    } as unknown as import("../convex.js").ConvexDurable;
  }

  it("R2 — snapshot 20×20 restored onto durable 10×10 is 2-D cropped", async () => {
    const snapW = 20, snapH = 20, durW = 10, durH = 10;
    const redis = buildFakeRedis();
    const convex = fakeConvex(snapW, snapH, durW, durH);

    const result = await restoreIfNeeded(redis, convex, "test-slug", durW, durH, 5_000, "test-slug");
    assert.equal(result.restored, true, "should restore");

    // The restored pixel buffer must be durW*durH bytes
    const k = canvasKeys("test-slug");
    const buf = (redis as unknown as { store: Map<string, Buffer> }).store.get(k.pixels) as Buffer;
    assert.equal(buf.length, durW * durH, "restored buffer is 10×10");

    // (0,0) = 42 preserved (in-frame)
    assert.equal(buf[0], 42, "in-frame pixel (0,0) preserved");

    // (durW,0) = out-of-frame on the 10-wide grid — must be 0, not 99
    // A flat crop would put buf[durW]=99 (wrong stride). A 2-D crop keeps it 0.
    assert.equal(buf[durW], 0, "out-of-frame pixel zeroed (not flat-copied)");
  });
});
