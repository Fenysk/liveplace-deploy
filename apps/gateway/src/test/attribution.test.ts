import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AttributionStore,
  buildRefCookie,
  readRefCookie,
  sanitizeRef,
  type AttributionRedis,
} from "../attribution";

/** Minimal in-memory Redis covering exactly the AttributionRedis surface. */
function fakeAttributionRedis(): AttributionRedis {
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Map<string, string>>();
  const set = (k: string) => sets.get(k) ?? sets.set(k, new Set()).get(k)!;
  const hash = (k: string) => hashes.get(k) ?? hashes.set(k, new Map()).get(k)!;
  return {
    async incr(key) {
      const n = (Number(strings.get(key)) || 0) + 1;
      strings.set(key, String(n));
      return n;
    },
    async get(key) {
      return strings.get(key) ?? null;
    },
    async sadd(key, member) {
      const s = set(key);
      if (s.has(member)) return 0;
      s.add(member);
      return 1;
    },
    async smembers(key) {
      return [...set(key)];
    },
    async scard(key) {
      return set(key).size;
    },
    async hsetnx(key, field, value) {
      const h = hash(key);
      if (h.has(field)) return 0;
      h.set(field, value);
      return 1;
    },
  };
}

test("sanitizeRef normalises and rejects junk", () => {
  assert.equal(sanitizeRef("Batch1-A"), "batch1-a");
  assert.equal(sanitizeRef("  weird ref!! "), "weirdref");
  assert.equal(sanitizeRef("a".repeat(100))?.length, 64);
  assert.equal(sanitizeRef(""), null);
  assert.equal(sanitizeRef("!!!"), null);
  assert.equal(sanitizeRef(null), null);
});

test("readRefCookie extracts and sanitizes lp_ref from a Cookie header", () => {
  assert.equal(readRefCookie("foo=1; lp_ref=batch1-a; bar=2"), "batch1-a");
  assert.equal(readRefCookie("lp_ref=Batch1-A"), "batch1-a");
  assert.equal(readRefCookie("other=x"), null);
  assert.equal(readRefCookie(undefined), null);
});

test("buildRefCookie sets HttpOnly/SameSite/Secure attributes", () => {
  const c = buildRefCookie("batch1-a", { maxAgeSec: 100, secure: true });
  assert.match(c, /^lp_ref=batch1-a/);
  assert.match(c, /Max-Age=100/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Secure/);
  // local http smoke: Secure omitted
  assert.doesNotMatch(buildRefCookie("x", { maxAgeSec: 1, secure: false }), /Secure/);
});

test("visits accumulate; report lists per ref", async () => {
  const store = new AttributionStore(fakeAttributionRedis());
  await store.recordVisit("batch1-a");
  await store.recordVisit("batch1-a");
  await store.recordVisit("batch1-b");
  const rows = await store.report();
  assert.deepEqual(rows, [
    { ref: "batch1-a", visits: 2, signups: 0 },
    { ref: "batch1-b", visits: 1, signups: 0 },
  ]);
});

test("signups are deduped per user; first ref wins", async () => {
  const store = new AttributionStore(fakeAttributionRedis());
  await store.recordSignup("user-1", "batch1-a");
  await store.recordSignup("user-1", "batch1-a"); // reconnect → no double count
  await store.recordSignup("user-1", "batch1-b"); // later, different ref → ignored
  await store.recordSignup("user-2", "batch1-a");
  const rows = await store.report();
  const a = rows.find((r) => r.ref === "batch1-a");
  assert.equal(a?.signups, 2);
  // user-1 stayed pinned to their first ref; batch1-b got no signup row created
  assert.equal(rows.find((r) => r.ref === "batch1-b"), undefined);
});

test("a ref seen only via signup still appears in the report", async () => {
  const store = new AttributionStore(fakeAttributionRedis());
  await store.recordSignup("user-9", "directlink");
  const rows = await store.report();
  assert.deepEqual(rows, [{ ref: "directlink", visits: 0, signups: 1 }]);
});
