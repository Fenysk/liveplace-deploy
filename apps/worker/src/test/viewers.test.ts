import { test } from "node:test";
import assert from "node:assert/strict";
import type Redis from "ioredis";
import { readGlobalViewerCount } from "../redis.js";

/**
 * F12 gallery viewer-count read (FEN-33). The worker sums the gateway's live
 * per-instance presence keys (`presence:inst:*`) to flush `viewerCount` onto the
 * F2 row off the hot path. These pin the SCAN pagination + mget reduce and the
 * defensive handling of missing / non-numeric values.
 */

interface FakeRedisOpts {
  /** Pages returned by SCAN, in order: each is [nextCursor, keys]. */
  scanPages: Array<[string, string[]]>;
  /** Map of key -> stored string value (absent => null from mget). */
  store: Record<string, string | null>;
}

function fakeRedis(opts: FakeRedisOpts): Redis {
  let i = 0;
  return {
    async scan(_cursor: string, _m: string, _pattern: string, _c: string, _n: number) {
      const page = opts.scanPages[i] ?? ["0", []];
      i++;
      return page;
    },
    async mget(keys: string[]) {
      return keys.map((k) => (k in opts.store ? opts.store[k] : null));
    },
  } as unknown as Redis;
}

test("sums all live per-instance presence keys", async () => {
  const redis = fakeRedis({
    scanPages: [["0", ["presence:inst:a", "presence:inst:b"]]],
    store: { "presence:inst:a": "3", "presence:inst:b": "5" },
  });
  assert.equal(await readGlobalViewerCount(redis), 8);
});

test("follows the SCAN cursor across pages", async () => {
  const redis = fakeRedis({
    scanPages: [
      ["42", ["presence:inst:a"]],
      ["0", ["presence:inst:b"]],
    ],
    store: { "presence:inst:a": "2", "presence:inst:b": "4" },
  });
  assert.equal(await readGlobalViewerCount(redis), 6);
});

test("returns 0 when no instance is live", async () => {
  const redis = fakeRedis({ scanPages: [["0", []]], store: {} });
  assert.equal(await readGlobalViewerCount(redis), 0);
});

test("treats missing / non-numeric values as 0", async () => {
  const redis = fakeRedis({
    scanPages: [["0", ["presence:inst:a", "presence:inst:b", "presence:inst:c"]]],
    store: { "presence:inst:a": "7", "presence:inst:b": null, "presence:inst:c": "oops" },
  });
  assert.equal(await readGlobalViewerCount(redis), 7);
});
