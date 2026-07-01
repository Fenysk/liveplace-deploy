/**
 * Unit tests for the F5 placement handler (../placement.ts, FEN-15).
 *
 * These cover the gateway-side glue: building the place.lua call from a client
 * `place` message and mapping each script verdict to the right protocol frame.
 * The gauge arithmetic itself (D1 CA1–CA4) is proven by the redis-scripts gauge
 * unit tests and place.integration.test.ts; here we assert:
 *   - the EFFECTIVE max (base + F6 bonus, read from conn.gauge) is the gaugeMax
 *     handed to the script — the seam FEN-27 depends on (D1 CA3);
 *   - ok → ack with the post-consume gauge; cooldown → cooldown { until };
 *     out_of_bounds / invalid_color / frozen → the matching error frames;
 *   - an anonymous user never reaches the script; a script error is contained.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GAUGE } from "@canvas/redis-scripts";
import type { ClientMessage, ServerMessage } from "@canvas/protocol";
import { RedisPlacementHandler, type PlaceScriptRunner } from "../placement";
import type { Connection } from "../gateway";

const CFG = { width: 4, height: 4, paletteSize: 17, gauge: { ...DEFAULT_GAUGE } };
const NOW = 1_700_000_000_000;
const clock = () => NOW;

/** A runner that records its call and returns a canned place.lua result array. */
function fakeRunner(result: unknown[]): PlaceScriptRunner & {
  calls: Array<{ keys: readonly string[]; argv: readonly string[] }>;
} {
  const calls: Array<{ keys: readonly string[]; argv: readonly string[] }> = [];
  return {
    calls,
    async run(keys, argv) {
      calls.push({ keys, argv });
      return result;
    },
  };
}

/** Minimal Connection stand-in: records the frames the handler sends back. */
function fakeConn(opts: { userId: string | null; effectiveGaugeMax: number }): Connection & {
  sent: ServerMessage[];
} {
  const sent: ServerMessage[] = [];
  return {
    sent,
    user: { userId: opts.userId },
    gauge: { effectiveGaugeMax: opts.effectiveGaugeMax },
    sendJson(msg: ServerMessage) {
      sent.push(msg);
    },
  } as unknown as Connection & { sent: ServerMessage[] };
}

const CID = "sess-abc:7";

const place = (over: Partial<Extract<ClientMessage, { t: "place" }>> = {}): Extract<
  ClientMessage,
  { t: "place" }
> => ({ t: "place", x: 1, y: 2, color: 3, cid: CID, ...over });

test("ok ⇒ ack carrying the post-consume gauge state + echoed cid", async () => {
  const runner = fakeRunner(["ok", 19, 23, NOW + 30_000]);
  const conn = fakeConn({ userId: "user-7", effectiveGaugeMax: 23 });
  await new RedisPlacementHandler(runner, CFG, clock).handlePlace(conn, place());

  // FEN-63: ack echoes the client's opaque `cid`; `seq` is the gateway global
  // frame seq (0 here — assigned downstream on the broadcast delta, not synchronously).
  assert.deepEqual(conn.sent, [
    { t: "ack", seq: 0, cid: CID, charges: 19, max: 23, cooldownUntil: NOW + 30_000 },
  ]);
});

test("passes the EFFECTIVE max (base + bonus) as gaugeMax — the FEN-27 seam (CA3)", async () => {
  const runner = fakeRunner(["ok", 24, 25, 0]);
  const conn = fakeConn({ userId: "user-7", effectiveGaugeMax: 25 }); // base 20 + 5 bonus
  await new RedisPlacementHandler(runner, CFG, clock).handlePlace(conn, place());

  // placeArgs ARGV order: x,y,width,height,color,paletteSize,nowMs,
  // refillIntervalMs,refillAmount,gaugeMax,gaugeTtlMs,deltaChannel → gaugeMax is index 9.
  const { argv } = runner.calls[0]!;
  assert.equal(argv[9], "25", "gaugeMax handed to place.lua must be the effective max");
  assert.equal(argv[6], String(NOW), "nowMs comes from the injected clock");
  assert.equal(runner.calls[0]!.keys[1], "gauge:user-7", "gauge key is namespaced by user");
});

test("cooldown ⇒ cooldown { until } (empty gauge)", async () => {
  const runner = fakeRunner(["cooldown", 0, 20, NOW + 30_000]);
  const conn = fakeConn({ userId: "user-7", effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(runner, CFG, clock).handlePlace(conn, place());

  assert.deepEqual(conn.sent, [{ t: "cooldown", until: NOW + 30_000 }]);
});

test("out_of_bounds / invalid_color ⇒ matching error frames (with echoed cid)", async () => {
  const oob = fakeConn({ userId: "u", effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(fakeRunner(["out_of_bounds", 0, 0, 0]), CFG, clock).handlePlace(oob, place());
  assert.deepEqual(oob.sent, [
    { t: "error", code: "out_of_bounds", message: "pixel out of bounds", cid: CID },
  ]);

  const bad = fakeConn({ userId: "u", effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(fakeRunner(["invalid_color", 0, 0, 0]), CFG, clock).handlePlace(bad, place());
  assert.deepEqual(bad.sent, [
    { t: "error", code: "invalid_color", message: "invalid palette colour", cid: CID },
  ]);
});

test("frozen (F8.4) ⇒ frozen error (ADR-0006, PROTOCOL_VERSION 2 — distinct from rate_limited)", async () => {
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(fakeRunner(["frozen", 0, 20, 0]), CFG, clock).handlePlace(conn, place());
  assert.equal(conn.sent[0]!.t, "error");
  assert.equal((conn.sent[0] as { code: string }).code, "frozen");
});

test("anonymous user is rejected and never reaches the script", async () => {
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: null, effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(runner, CFG, clock).handlePlace(conn, place());

  assert.equal(runner.calls.length, 0, "the script must not run without a user key");
  assert.deepEqual(conn.sent, [
    { t: "error", code: "unauthenticated", message: "sign in to place pixels", cid: CID },
  ]);
});

test("a script failure is contained as an internal error, not a throw", async () => {
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20 });
  const runner: PlaceScriptRunner = {
    async run() {
      throw new Error("NOSCRIPT");
    },
  };
  await new RedisPlacementHandler(runner, CFG, clock).handlePlace(conn, place());
  assert.deepEqual(conn.sent, [
    { t: "error", code: "internal", message: "placement failed", cid: CID },
  ]);
});

test("ack omits cid (seq 0) when the client placed without a correlation id", async () => {
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(fakeRunner(["ok", 19, 20, 0]), CFG, clock).handlePlace(
    conn,
    place({ cid: undefined }),
  );
  const ack = conn.sent[0] as { seq: number; cid?: string };
  assert.equal(ack.seq, 0);
  assert.equal(ack.cid, undefined, "no cid echoed when the client didn't tag the placement");
});

test("banned (CA6) ⇒ error { banned } (first-class ws code)", async () => {
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(fakeRunner(["banned", 0, 20, 0]), CFG, clock).handlePlace(conn, place());
  assert.deepEqual(conn.sent, [
    { t: "error", code: "banned", message: "you are banned from this canvas", cid: CID },
  ]);
});

test("CA5: an opaque client cid becomes the per-op idempotency claim key (FEN-63)", async () => {
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "user-7", effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(runner, CFG, clock).handlePlace(conn, place({ cid: CID }));

  // placeArgs KEYS order: [pixels, gauge, meta, frozen, stream, bans, op].
  const { keys, argv } = runner.calls[0]!;
  assert.equal(keys[5], "canvas:default:bans", "the per-canvas ban set is always passed (CA6)");
  assert.equal(keys[6], `canvas:default:op:user-7:${CID}`, "op claim key is namespaced by canvas/user/cid");
  assert.equal(argv[13], CID, "opId ARGV is the client cid");
  assert.ok(Number(argv[14]) > 0, "a positive op TTL is supplied");
});

test("CA5: no idempotency when cid is absent or empty (naive client keeps placing)", async () => {
  for (const cid of [undefined, ""]) {
    const runner = fakeRunner(["ok", 19, 20, 0]);
    const conn = fakeConn({ userId: "user-7", effectiveGaugeMax: 20 });
    await new RedisPlacementHandler(runner, CFG, clock).handlePlace(conn, place({ cid }));
    const { keys, argv } = runner.calls[0]!;
    assert.equal(keys[6], "", `op key empty for cid=${JSON.stringify(cid)} → idempotency off`);
    assert.equal(argv[13], "", "opId ARGV empty");
  }
});

test("CA5: an over-long cid disables idempotency rather than keying an unbounded op key", async () => {
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "user-7", effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(runner, CFG, clock).handlePlace(conn, place({ cid: "x".repeat(200) }));
  const { keys, argv } = runner.calls[0]!;
  assert.equal(keys[6], "", "over-long cid → no op claim (no clipped-key collisions)");
  assert.equal(argv[13], "", "opId ARGV empty for an over-long cid");
});

test("places under the gateway's configured canvas id (CA6 ban set agrees with pixels)", async () => {
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "user-7", effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(runner, { ...CFG, canvasId: "liveplace" }, clock).handlePlace(
    conn,
    place({ cid: "op-7" }),
  );
  const { keys } = runner.calls[0]!;
  assert.equal(keys[0], "canvas:liveplace:pixels");
  assert.equal(keys[5], "canvas:liveplace:bans");
  assert.equal(keys[6], "canvas:liveplace:op:user-7:op-7");
});
