/**
 * Unit tests for the account-deletion Redis purge (FEN-1966, C-4 §3c/§3d).
 * Drives PurgeUserService against an in-memory PurgeRedis fake and checks the
 * exact key inventory the contract freezes: per-canvas gauge/op/ban membership
 * for member canvases, the whole `canvas:{id}:*` namespace for owned canvases,
 * and the attribution funnel unpin — plus idempotency (a re-run is a no-op).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PurgeUserService, parsePurgeUserBody, type PurgeRedis } from "../purgeUser";
import { ModerationRequestError } from "../moderation";

/** Minimal in-memory PurgeRedis: flat keys + sets + hashes, glob-free SCAN. */
class FakePurgeRedis implements PurgeRedis {
  readonly keys = new Set<string>();
  readonly sets = new Map<string, Set<string>>();
  readonly hashes = new Map<string, Map<string, string>>();

  async del(...ks: string[]): Promise<number> {
    let n = 0;
    for (const k of ks) {
      if (this.keys.delete(k)) n++;
      if (this.sets.delete(k)) n++;
    }
    return n;
  }
  async srem(key: string, member: string): Promise<number> {
    return this.sets.get(key)?.delete(member) ? 1 : 0;
  }
  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }
  async hdel(key: string, field: string): Promise<number> {
    return this.hashes.get(key)?.delete(field) ? 1 : 0;
  }
  async scan(
    _cursor: string,
    _m: "MATCH",
    pattern: string,
    _c: "COUNT",
    _n: number,
  ): Promise<[string, string[]]> {
    const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
    const all = [...this.keys, ...this.sets.keys()];
    return ["0", all.filter((k) => k.startsWith(prefix))];
  }

  seedSet(key: string, ...members: string[]): void {
    this.sets.set(key, new Set(members));
  }
  seedHash(key: string, field: string, value: string): void {
    const h = this.hashes.get(key) ?? this.hashes.set(key, new Map()).get(key)!;
    h.set(field, value);
  }
}

const USER = "user_gone";
const OTHER = "user_stays";

function seedWorld(r: FakePurgeRedis): void {
  // Member canvas cA: the user's gauge, two op keys, ban membership — plus
  // OTHER's keys and the canvas bitmap, which must all survive.
  r.keys.add(`canvas:cA:gauge:${USER}`);
  r.keys.add(`canvas:cA:op:${USER}:op1`);
  r.keys.add(`canvas:cA:op:${USER}:op2`);
  r.keys.add(`canvas:cA:gauge:${OTHER}`);
  r.keys.add(`canvas:cA:op:${OTHER}:op9`);
  r.keys.add("canvas:cA:pixels");
  r.seedSet("canvas:cA:bans", USER, OTHER);
  // Owned canvas cP: the whole namespace dies, including keys naming OTHER.
  r.keys.add("canvas:cP:pixels");
  r.keys.add("canvas:cP:meta");
  r.keys.add("canvas:cP:stream");
  r.keys.add(`canvas:cP:gauge:${OTHER}`);
  r.seedSet("canvas:cP:bans", OTHER);
  // Attribution: the user is pinned to ref "dm1" alongside OTHER.
  r.seedHash("attr:userref", USER, "dm1");
  r.seedHash("attr:userref", OTHER, "dm1");
  r.seedSet("attr:signups:dm1", USER, OTHER);
}

test("purges member-canvas keys, owned namespace and attribution; leaves others intact", async () => {
  const r = new FakePurgeRedis();
  seedWorld(r);
  const result = await new PurgeUserService(r).purgeUser({
    userId: USER,
    canvasIds: ["cA"],
    ownedCanvasIds: ["cP"],
  });

  // Member canvas cA: user-scoped keys gone, everything else intact.
  assert.equal(r.keys.has(`canvas:cA:gauge:${USER}`), false);
  assert.equal(r.keys.has(`canvas:cA:op:${USER}:op1`), false);
  assert.equal(r.keys.has(`canvas:cA:op:${USER}:op2`), false);
  assert.equal(r.keys.has(`canvas:cA:gauge:${OTHER}`), true);
  assert.equal(r.keys.has(`canvas:cA:op:${OTHER}:op9`), true);
  assert.equal(r.keys.has("canvas:cA:pixels"), true);
  assert.deepEqual([...r.sets.get("canvas:cA:bans")!], [OTHER]);

  // Owned canvas cP: the entire namespace is swept, whoever the keys name.
  const cpKeys = [...r.keys, ...r.sets.keys()].filter((k) => k.startsWith("canvas:cP:"));
  assert.deepEqual(cpKeys, []);

  // Attribution: user unpinned + removed from the signup set; OTHER intact.
  assert.equal(r.hashes.get("attr:userref")?.has(USER), false);
  assert.equal(r.hashes.get("attr:userref")?.get(OTHER), "dm1");
  assert.deepEqual([...r.sets.get("attr:signups:dm1")!], [OTHER]);

  assert.equal(result.bansRemoved, 1);
  assert.equal(result.attributionCleared, true);
  assert.ok(result.keysDeleted >= 8); // 3 cA user keys + 5 cP namespace keys
});

test("re-running the same purge is a clean no-op (idempotency)", async () => {
  const r = new FakePurgeRedis();
  seedWorld(r);
  const svc = new PurgeUserService(r);
  const req = { userId: USER, canvasIds: ["cA"], ownedCanvasIds: ["cP"] };
  await svc.purgeUser(req);
  const second = await svc.purgeUser(req);
  assert.deepEqual(second, { keysDeleted: 0, bansRemoved: 0, attributionCleared: false });
});

test("a canvas listed as both member and owned is swept once, wholesale", async () => {
  const r = new FakePurgeRedis();
  r.keys.add(`canvas:cP:gauge:${USER}`);
  r.keys.add("canvas:cP:pixels");
  const result = await new PurgeUserService(r).purgeUser({
    userId: USER,
    canvasIds: ["cP"],
    ownedCanvasIds: ["cP"],
  });
  assert.equal(result.keysDeleted, 2);
  assert.deepEqual([...r.keys].filter((k) => k.startsWith("canvas:cP:")), []);
});

test("parsePurgeUserBody validates and defaults", () => {
  assert.deepEqual(parsePurgeUserBody({ userId: "u1" }), {
    userId: "u1",
    canvasIds: [],
    ownedCanvasIds: [],
  });
  assert.deepEqual(
    parsePurgeUserBody({ userId: "u1", canvasIds: ["a"], ownedCanvasIds: ["b"] }),
    { userId: "u1", canvasIds: ["a"], ownedCanvasIds: ["b"] },
  );
  assert.throws(() => parsePurgeUserBody({}), ModerationRequestError);
  assert.throws(() => parsePurgeUserBody({ userId: "" }), ModerationRequestError);
  assert.throws(
    () => parsePurgeUserBody({ userId: "u1", canvasIds: "nope" }),
    ModerationRequestError,
  );
  assert.throws(
    () => parsePurgeUserBody({ userId: "u1", ownedCanvasIds: [""] }),
    ModerationRequestError,
  );
});
