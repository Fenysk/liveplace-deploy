/**
 * Live `ModerationSource` bridge DoD (FEN-754, §8.2). Proves the mapping from
 * the F8 Convex actions to the panel's {@link ModResult}:
 *   - deletePixel → deletePixels with the single clicked cell; ok = dispatched;
 *   - deleteGroup → deleteGroupAt with the clicked coordinate (S8.4 / G2);
 *   - banAuthor   → authorAt then banAndWipe; a null author short-circuits to
 *     `no_author` and banAndWipe is NOT called;
 *   - no canvas resolved → `unavailable`, no backend call;
 *   - any backend rejection degrades to `{ ok: false, detail: "error" }`.
 *
 * Pure (no React/Convex): the bridge is dependency-free by design.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLiveModerationSource,
  type AuthorAtResult,
  type CellActionResult,
} from "./liveModerationSource.ts";

const dispatched = (cellsAffected: number): CellActionResult => ({
  cellsAffected,
  dispatched: true,
  detail: "ok",
});

function spy<A, R>(impl: (a: A) => R | Promise<R>): {
  fn: (a: A) => Promise<R>;
  calls: A[];
} {
  const calls: A[] = [];
  return {
    calls,
    fn: async (a) => {
      calls.push(a);
      return impl(a);
    },
  };
}

function deps(over: Partial<Parameters<typeof createLiveModerationSource>[0]> = {}) {
  return {
    getCanvasId: () => "cv1" as string | null,
    deletePixels: async () => dispatched(1),
    deleteGroupAt: async () => dispatched(3),
    authorAt: async (): Promise<AuthorAtResult | null> => ({ userId: "u-bob", displayName: "Bob" }),
    banAndWipe: async () => dispatched(7),
    ...over,
  };
}

test("deletePixel: targets the single clicked cell, ok = dispatched", async () => {
  const del = spy<{ canvasId: string; cells: Array<{ x: number; y: number }> }, CellActionResult>(
    () => dispatched(1),
  );
  const src = createLiveModerationSource(deps({ deletePixels: del.fn }));

  assert.deepEqual(await src.deletePixel(4, 9), { ok: true, cellsAffected: 1 });
  assert.deepEqual(del.calls, [{ canvasId: "cv1", cells: [{ x: 4, y: 9 }] }]);
});

test("deleteGroup: passes the clicked coordinate to deleteGroupAt (G2)", async () => {
  const grp = spy<{ canvasId: string; x: number; y: number }, CellActionResult>(() => dispatched(5));
  const src = createLiveModerationSource(deps({ deleteGroupAt: grp.fn }));

  assert.deepEqual(await src.deleteGroup(2, 3), { ok: true, cellsAffected: 5 });
  assert.deepEqual(grp.calls, [{ canvasId: "cv1", x: 2, y: 3 }]);
});

test("banAuthor: resolves the author then bans+wipes", async () => {
  const ban = spy<{ canvasId: string; targetUserId: string }, CellActionResult>(() => dispatched(7));
  const src = createLiveModerationSource(deps({ banAndWipe: ban.fn }));

  assert.deepEqual(await src.banAuthor(1, 1), { ok: true, cellsAffected: 7 });
  assert.deepEqual(ban.calls, [{ canvasId: "cv1", targetUserId: "u-bob" }]);
});

test("banAuthor: a null author short-circuits to no_author (no ban issued)", async () => {
  const ban = spy<{ canvasId: string; targetUserId: string }, CellActionResult>(() => dispatched(7));
  const src = createLiveModerationSource(deps({ authorAt: async () => null, banAndWipe: ban.fn }));

  assert.deepEqual(await src.banAuthor(1, 1), { ok: false, cellsAffected: 0, detail: "no_author" });
  assert.equal(ban.calls.length, 0);
});

test("no canvas resolved → unavailable, no backend call", async () => {
  const del = spy<unknown, CellActionResult>(() => dispatched(1));
  const src = createLiveModerationSource(deps({ getCanvasId: () => null, deletePixels: del.fn }));

  assert.deepEqual(await src.deletePixel(0, 0), { ok: false, cellsAffected: 0, detail: "unavailable" });
  assert.equal(del.calls.length, 0);
});

test("a backend rejection degrades to error (never throws)", async () => {
  const src = createLiveModerationSource(
    deps({
      deletePixels: async () => {
        throw new Error("down");
      },
    }),
  );
  assert.deepEqual(await src.deletePixel(0, 0), { ok: false, cellsAffected: 0, detail: "error" });
});

test("reads the live canvas id at call time", async () => {
  let id: string | null = null;
  const grp = spy<{ canvasId: string; x: number; y: number }, CellActionResult>(() => dispatched(2));
  const src = createLiveModerationSource(deps({ getCanvasId: () => id, deleteGroupAt: grp.fn }));

  assert.equal((await src.deleteGroup(1, 1)).detail, "unavailable");
  id = "cv-late";
  assert.deepEqual(await src.deleteGroup(2, 2), { ok: true, cellsAffected: 2 });
  assert.deepEqual(grp.calls, [{ canvasId: "cv-late", x: 2, y: 2 }]);
});
