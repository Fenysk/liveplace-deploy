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

const place = (over: Partial<Extract<ClientMessage, { t: "place" }>> = {}): Extract<
  ClientMessage,
  { t: "place" }
> => ({ t: "place", x: 1, y: 2, color: 3, seq: 42, ...over });

test("ok ⇒ ack carrying the post-consume gauge state", async () => {
  const runner = fakeRunner(["ok", 19, 23, NOW + 30_000]);
  const conn = fakeConn({ userId: "user-7", effectiveGaugeMax: 23 });
  await new RedisPlacementHandler(runner, CFG, clock).handlePlace(conn, place());

  assert.deepEqual(conn.sent, [
    { t: "ack", seq: 42, charges: 19, max: 23, cooldownUntil: NOW + 30_000 },
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

test("out_of_bounds / invalid_color ⇒ matching error frames (with seq)", async () => {
  const oob = fakeConn({ userId: "u", effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(fakeRunner(["out_of_bounds", 0, 0, 0]), CFG, clock).handlePlace(oob, place());
  assert.deepEqual(oob.sent, [
    { t: "error", code: "out_of_bounds", message: "pixel out of bounds", seq: 42 },
  ]);

  const bad = fakeConn({ userId: "u", effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(fakeRunner(["invalid_color", 0, 0, 0]), CFG, clock).handlePlace(bad, place());
  assert.deepEqual(bad.sent, [
    { t: "error", code: "invalid_color", message: "invalid palette colour", seq: 42 },
  ]);
});

test("frozen (F8.4) ⇒ rate_limited error (no 'frozen' code in the frozen contract)", async () => {
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(fakeRunner(["frozen", 0, 20, 0]), CFG, clock).handlePlace(conn, place());
  assert.equal(conn.sent[0]!.t, "error");
  assert.equal((conn.sent[0] as { code: string }).code, "rate_limited");
});

test("anonymous user is rejected and never reaches the script", async () => {
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: null, effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(runner, CFG, clock).handlePlace(conn, place());

  assert.equal(runner.calls.length, 0, "the script must not run without a user key");
  assert.deepEqual(conn.sent, [
    { t: "error", code: "unauthenticated", message: "sign in to place pixels", seq: 42 },
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
    { t: "error", code: "internal", message: "placement failed", seq: 42 },
  ]);
});

test("ack falls back to seq 0 when the client omitted its correlation id", async () => {
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(fakeRunner(["ok", 19, 20, 0]), CFG, clock).handlePlace(
    conn,
    place({ seq: undefined }),
  );
  assert.equal((conn.sent[0] as { seq: number }).seq, 0);
});

test("banned (CA6) ⇒ error { banned } (first-class ws code)", async () => {
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(fakeRunner(["banned", 0, 20, 0]), CFG, clock).handlePlace(conn, place());
  assert.deepEqual(conn.sent, [
    { t: "error", code: "banned", message: "you are banned from this canvas", seq: 42 },
  ]);
});

test("CA5: a positive client seq becomes the per-op idempotency claim key", async () => {
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "user-7", effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(runner, CFG, clock).handlePlace(conn, place({ seq: 42 }));

  // placeArgs KEYS order: [pixels, gauge, meta, frozen, stream, bans, op].
  const { keys, argv } = runner.calls[0]!;
  assert.equal(keys[5], "canvas:default:bans", "the per-canvas ban set is always passed (CA6)");
  assert.equal(keys[6], "canvas:default:op:user-7:42", "op claim key is namespaced by canvas/user/op");
  assert.equal(argv[13], "42", "opId ARGV is the client seq");
  assert.ok(Number(argv[14]) > 0, "a positive op TTL is supplied");
});

test("CA5: no idempotency when seq is absent or non-positive (naive client keeps placing)", async () => {
  for (const seq of [undefined, 0, -3]) {
    const runner = fakeRunner(["ok", 19, 20, 0]);
    const conn = fakeConn({ userId: "user-7", effectiveGaugeMax: 20 });
    await new RedisPlacementHandler(runner, CFG, clock).handlePlace(conn, place({ seq }));
    const { keys, argv } = runner.calls[0]!;
    assert.equal(keys[6], "", `op key empty for seq=${String(seq)} → idempotency off`);
    assert.equal(argv[13], "", "opId ARGV empty");
  }
});

test("places under the gateway's configured canvas id (CA6 ban set agrees with pixels)", async () => {
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "user-7", effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(runner, { ...CFG, canvasId: "liveplace" }, clock).handlePlace(
    conn,
    place({ seq: 7 }),
  );
  const { keys } = runner.calls[0]!;
  assert.equal(keys[0], "canvas:liveplace:pixels");
  assert.equal(keys[5], "canvas:liveplace:bans");
  assert.equal(keys[6], "canvas:liveplace:op:user-7:7");
});
