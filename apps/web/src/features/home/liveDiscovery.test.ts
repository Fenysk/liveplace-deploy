/**
 * Tests for the live-canvas detection helper (G6 / FEN-611).
 *   node --experimental-transform-types --test apps/web/src/features/home/liveDiscovery.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isLiveCanvas, N_LIVE_MIN } from "./liveDiscovery.ts";

const NOW = Date.UTC(2026, 5, 17, 12, 0, 0);
const LIVE_OFFSET = (N_LIVE_MIN - 2) * 60 * 1000;
const DEAD_OFFSET = (N_LIVE_MIN + 5) * 60 * 1000;

test("isLiveCanvas — recent activity → live", () => {
  assert.equal(isLiveCanvas(NOW - LIVE_OFFSET, NOW), true);
});

test("isLiveCanvas — stale activity → not live", () => {
  assert.equal(isLiveCanvas(NOW - DEAD_OFFSET, NOW), false);
});

test("isLiveCanvas — exactly at threshold → live (inclusive)", () => {
  assert.equal(isLiveCanvas(NOW - N_LIVE_MIN * 60 * 1000, NOW), true);
});
