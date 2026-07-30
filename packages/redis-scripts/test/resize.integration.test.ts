/**
 * Redis-backed integration test for grid-resize.lua (FEN-1802).
 * Verifies R1: resize populated canvas 20→10 and 10→20.
 *
 * Skipped unless REDIS_URL is set; run with:
 *   REDIS_URL=redis://localhost:6379 pnpm --filter @canvas/redis-scripts exec \
 *     tsx --test test/resize.integration.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

const REDIS_URL = process.env.REDIS_URL;

test("grid-resize.lua R1a — shrink populated 20×20 → 10×10", { skip: !REDIS_URL }, async () => {
  const { GRID_RESIZE_LUA, resizeGridArgs, parseResizeGridResult, canvasKeys } =
    await import("../src/index.ts");
  const { default: Redis } = await import("ioredis");

  const redis = new Redis(REDIS_URL!);
  const canvasId = `resize-shrink-${process.pid}`;
  const K = canvasKeys(canvasId);

  try {
    await redis.del(K.pixels, K.meta);

    // Seed a 20×20 grid: cell (x, y) = x + y*20 + 1 (nonzero for all)
    const oldW = 20, oldH = 20;
    const src = Buffer.alloc(oldW * oldH);
    for (let y = 0; y < oldH; y++) {
      for (let x = 0; x < oldW; x++) {
        src[y * oldW + x] = ((x + y * 20) & 0xff) || 1; // ensure non-zero
      }
    }
    await redis.set(K.pixels, src);

    // Resize to 10×10
    const newW = 10, newH = 10;
    const { keys, argv } = resizeGridArgs({ canvasId, oldWidth: oldW, oldHeight: oldH, newWidth: newW, newHeight: newH });
    const raw = await redis.eval(GRID_RESIZE_LUA, keys.length, ...keys, ...argv);
    const { surviving } = parseResizeGridResult(raw);

    const buf = (await redis.getBuffer(K.pixels))!;
    assert.equal(buf.length, newW * newH, "buffer size equals new dims");

    // All in-frame pixels preserved at the correct row-major position
    for (let y = 0; y < newH; y++) {
      for (let x = 0; x < newW; x++) {
        const expected = src[y * oldW + x]!;
        assert.equal(buf[y * newW + x], expected, `cell (${x},${y}) preserved`);
      }
    }

    // surviving count matches non-zero pixels we preserved
    let expectedSurviving = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) expectedSurviving++;
    assert.equal(surviving, expectedSurviving, "surviving count accurate");
  } finally {
    await redis.del(K.pixels, K.meta);
    redis.disconnect();
  }
});

test("grid-resize.lua R1b — enlarge populated 10×10 → 20×20", { skip: !REDIS_URL }, async () => {
  const { GRID_RESIZE_LUA, resizeGridArgs, canvasKeys } =
    await import("../src/index.ts");
  const { default: Redis } = await import("ioredis");

  const redis = new Redis(REDIS_URL!);
  const canvasId = `resize-enlarge-${process.pid}`;
  const K = canvasKeys(canvasId);

  try {
    await redis.del(K.pixels, K.meta);

    // Seed a 10×10 grid: cell (x, y) = x + y*10 + 1
    const oldW = 10, oldH = 10;
    const src = Buffer.alloc(oldW * oldH);
    for (let y = 0; y < oldH; y++) {
      for (let x = 0; x < oldW; x++) {
        src[y * oldW + x] = ((x + y * 10) & 0xff) || 1;
      }
    }
    await redis.set(K.pixels, src);

    // Resize to 20×20
    const newW = 20, newH = 20;
    const { keys, argv } = resizeGridArgs({ canvasId, oldWidth: oldW, oldHeight: oldH, newWidth: newW, newHeight: newH });
    await redis.eval(GRID_RESIZE_LUA, keys.length, ...keys, ...argv);

    const buf = (await redis.getBuffer(K.pixels))!;
    assert.equal(buf.length, newW * newH, "buffer size equals new dims");

    // In-frame cells preserved at the new stride
    for (let y = 0; y < oldH; y++) {
      for (let x = 0; x < oldW; x++) {
        assert.equal(buf[y * newW + x], src[y * oldW + x], `in-frame cell (${x},${y}) preserved`);
      }
    }

    // New columns (x >= oldW) in original rows must be 0
    for (let y = 0; y < oldH; y++) {
      for (let x = oldW; x < newW; x++) {
        assert.equal(buf[y * newW + x], 0, `new column (${x},${y}) zero`);
      }
    }

    // New rows (y >= oldH) entirely zero
    for (let y = oldH; y < newH; y++) {
      for (let x = 0; x < newW; x++) {
        assert.equal(buf[y * newW + x], 0, `new row cell (${x},${y}) zero`);
      }
    }
  } finally {
    await redis.del(K.pixels, K.meta);
    redis.disconnect();
  }
});
