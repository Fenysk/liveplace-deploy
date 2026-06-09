import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconstructPixels } from "../restore.js";
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
