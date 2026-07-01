/**
 * Live `PixelAuthorSource` bridge DoD (FEN-297 / FEN-755). Proves the mapping
 * from the viewer-facing `canvases:pixelAuthor` query result to the panel's
 * occupancy model:
 *   - a resolved login → `{ login, avatarUrl, ts }` (panel shows real pseudo + avatar);
 *   - `ts: null` (empty / erased cell) → `null` (panel closed for this cell);
 *   - anonymous occupied cell → `{ login: null, avatarUrl: null, ts }`;
 *   - no canvas resolved yet → `null`, query NOT called;
 *   - query passes through the live canvas id + cell coords;
 *   - a query rejection degrades to `null` (inert behaviour, never throws).
 *
 * Pure (no React/Convex): the bridge is dependency-free by design.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLivePixelAuthorSource,
  type PixelAuthorResult,
} from "./livePixelAuthorSource.ts";

/** A query spy recording its args and returning a configurable result. */
function querySpy(result: PixelAuthorResult | Error): {
  fn: (a: { canvasId: string; x: number; y: number }) => Promise<PixelAuthorResult>;
  calls: Array<{ canvasId: string; x: number; y: number }>;
} {
  const calls: Array<{ canvasId: string; x: number; y: number }> = [];
  return {
    calls,
    fn: async (a) => {
      calls.push(a);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test("resolves a known login to the panel occupancy model", async () => {
  const q = querySpy({ author: "pixelqueen", avatarUrl: "https://cdn.twitch.tv/pq.png", ts: 9999 });
  const src = createLivePixelAuthorSource({ getCanvasId: () => "cv1", query: q.fn });

  assert.deepEqual(await src.authorAt(12, 34), {
    login: "pixelqueen",
    avatarUrl: "https://cdn.twitch.tv/pq.png",
    ts: 9999,
  });
  assert.deepEqual(q.calls, [{ canvasId: "cv1", x: 12, y: 34 }]);
});

test("maps ts:null (empty cell) to null (panel hides attribution row)", async () => {
  const q = querySpy({ author: null, avatarUrl: null, ts: null });
  const src = createLivePixelAuthorSource({ getCanvasId: () => "cv1", query: q.fn });

  assert.equal(await src.authorAt(0, 0), null);
  assert.equal(q.calls.length, 1);
});

test("anonymous occupied cell → occupancy with login:null and ts", async () => {
  const q = querySpy({ author: null, avatarUrl: null, ts: 1234567890 });
  const src = createLivePixelAuthorSource({ getCanvasId: () => "cv1", query: q.fn });

  assert.deepEqual(await src.authorAt(5, 5), { login: null, avatarUrl: null, ts: 1234567890 });
});

test("returns null and does NOT query while no canvas is resolved", async () => {
  const q = querySpy({ author: "nope", avatarUrl: null, ts: 1 });
  const src = createLivePixelAuthorSource({ getCanvasId: () => null, query: q.fn });

  assert.equal(await src.authorAt(5, 5), null);
  assert.equal(q.calls.length, 0);
});

test("reads the live canvas id at call time", async () => {
  const q = querySpy({ author: "late", avatarUrl: null, ts: 42 });
  let id: string | null = null;
  const src = createLivePixelAuthorSource({ getCanvasId: () => id, query: q.fn });

  assert.equal(await src.authorAt(1, 1), null); // still null → no query
  id = "cv-late";
  assert.deepEqual(await src.authorAt(2, 3), { login: "late", avatarUrl: null, ts: 42 });
  assert.deepEqual(q.calls, [{ canvasId: "cv-late", x: 2, y: 3 }]);
});

test("degrades a query failure to null (never throws into the click handler)", async () => {
  const q = querySpy(new Error("backend down"));
  const src = createLivePixelAuthorSource({ getCanvasId: () => "cv1", query: q.fn });

  assert.equal(await src.authorAt(7, 8), null);
});

test("null avatarUrl passes through (no avatar for this profile)", async () => {
  const q = querySpy({ author: "noavatar", avatarUrl: null, ts: 100 });
  const src = createLivePixelAuthorSource({ getCanvasId: () => "cv1", query: q.fn });

  assert.deepEqual(await src.authorAt(9, 9), { login: "noavatar", avatarUrl: null, ts: 100 });
});
