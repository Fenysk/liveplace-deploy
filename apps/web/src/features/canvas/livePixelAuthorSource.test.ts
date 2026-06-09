/**
 * Live `PixelAuthorSource` bridge DoD (FEN-297). Proves the mapping from the
 * viewer-facing `canvases:pixelAuthor` query result to the panel's author model:
 *   - a resolved login → `{ login }` (panel shows the real pseudo);
 *   - `author: null` → `null` (panel shows "Placed anonymously", FEN-332);
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

test("resolves a known login to the panel author model", async () => {
  const q = querySpy({ author: "pixelqueen" });
  const src = createLivePixelAuthorSource({ getCanvasId: () => "cv1", query: q.fn });

  assert.deepEqual(await src.authorAt(12, 34), { login: "pixelqueen" });
  assert.deepEqual(q.calls, [{ canvasId: "cv1", x: 12, y: 34 }]);
});

test("maps a null author to null (panel shows 'Placed anonymously')", async () => {
  const q = querySpy({ author: null });
  const src = createLivePixelAuthorSource({ getCanvasId: () => "cv1", query: q.fn });

  assert.equal(await src.authorAt(0, 0), null);
  assert.equal(q.calls.length, 1);
});

test("returns null and does NOT query while no canvas is resolved", async () => {
  const q = querySpy({ author: "nope" });
  const src = createLivePixelAuthorSource({ getCanvasId: () => null, query: q.fn });

  assert.equal(await src.authorAt(5, 5), null);
  assert.equal(q.calls.length, 0);
});

test("reads the live canvas id at call time", async () => {
  const q = querySpy({ author: "late" });
  let id: string | null = null;
  const src = createLivePixelAuthorSource({ getCanvasId: () => id, query: q.fn });

  assert.equal(await src.authorAt(1, 1), null); // still null → no query
  id = "cv-late";
  assert.deepEqual(await src.authorAt(2, 3), { login: "late" });
  assert.deepEqual(q.calls, [{ canvasId: "cv-late", x: 2, y: 3 }]);
});

test("degrades a query failure to null (never throws into the click handler)", async () => {
  const q = querySpy(new Error("backend down"));
  const src = createLivePixelAuthorSource({ getCanvasId: () => "cv1", query: q.fn });

  assert.equal(await src.authorAt(7, 8), null);
});

test("treats an empty-string login as no author", async () => {
  const q = querySpy({ author: "" });
  const src = createLivePixelAuthorSource({ getCanvasId: () => "cv1", query: q.fn });

  assert.equal(await src.authorAt(9, 9), null);
});
