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
import { DEFAULT_GAUGE, DEFAULT_CANVAS_ID } from "@canvas/redis-scripts";
import type { ClientMessage, ServerMessage } from "@canvas/protocol";
import { RedisPlacementHandler, type PlaceScriptRunner } from "../placement";
import type { Connection } from "../connection";

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
function fakeConn(opts: {
  userId: string | null;
  effectiveGaugeMax: number;
  canvasId?: string;
}): Connection & { sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  return {
    sent,
    user: { userId: opts.userId },
    gauge: { effectiveGaugeMax: opts.effectiveGaugeMax },
    canvasId: opts.canvasId ?? DEFAULT_CANVAS_ID,
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

  // FEN-63: ack echoes the client's opaque `cid` (D8: seq removed from ack).
  assert.deepEqual(conn.sent, [
    { t: "ack", cid: CID, charges: 19, max: 23, cooldownUntil: NOW + 30_000 },
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
  assert.equal(
    runner.calls[0]!.keys[1],
    "canvas:default:gauge:user-7",
    "gauge key is namespaced by (canvas, user) — FEN-1616",
  );
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

test("ack omits cid when the client placed without a correlation id", async () => {
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(fakeRunner(["ok", 19, 20, 0]), CFG, clock).handlePlace(
    conn,
    place({ cid: undefined }),
  );
  const ack = conn.sent[0] as { cid?: string };
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

// ── FEN-1722: F2 bounds guard ──────────────────────────────────────────────────

test("FEN-1722: x out-of-bounds is rejected before the script runs", async () => {
  // CFG has width:4, height:4 — x=4 is one past the right edge
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(runner, CFG, clock).handlePlace(conn, place({ x: 4, y: 0 }));
  assert.equal(runner.calls.length, 0, "script must not run for OOB placement");
  assert.deepEqual(conn.sent, [
    { t: "error", code: "out_of_bounds", message: "pixel out of bounds", cid: CID },
  ]);
});

test("FEN-1722: y out-of-bounds is rejected before the script runs", async () => {
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(runner, CFG, clock).handlePlace(conn, place({ x: 0, y: 4 }));
  assert.equal(runner.calls.length, 0, "script must not run for OOB placement");
  assert.deepEqual(conn.sent, [
    { t: "error", code: "out_of_bounds", message: "pixel out of bounds", cid: CID },
  ]);
});

test("FEN-1722: negative x is rejected before the script runs", async () => {
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(runner, CFG, clock).handlePlace(conn, place({ x: -1, y: 0 }));
  assert.equal(runner.calls.length, 0, "negative coord is OOB");
  assert.deepEqual(conn.sent, [
    { t: "error", code: "out_of_bounds", message: "pixel out of bounds", cid: CID },
  ]);
});

test("FEN-1722: in-bounds corner (x=3, y=3 on 4×4) still reaches the script", async () => {
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20 });
  await new RedisPlacementHandler(runner, CFG, clock).handlePlace(conn, place({ x: 3, y: 3 }));
  assert.equal(runner.calls.length, 1, "in-bounds placement must reach the script");
});

test("places under the connection's canvas id (CA6 ban set agrees with pixels)", async () => {
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "user-7", effectiveGaugeMax: 20, canvasId: "liveplace" });
  await new RedisPlacementHandler(runner, CFG, clock).handlePlace(conn, place({ cid: "op-7" }));
  const { keys } = runner.calls[0]!;
  assert.equal(keys[0], "canvas:liveplace:pixels");
  assert.equal(keys[5], "canvas:liveplace:bans");
  assert.equal(keys[6], "canvas:liveplace:op:user-7:op-7");
});

// ── FEN-1762: per-canvas dims — bounds guard uses durable geometry ─────────────

/** Minimal CanvasDimsProvider that returns a static size for any canvasId (always "ready"). */
function staticDimsProvider(width: number, height: number) {
  return {
    getDimsOrFallback: (_canvasId: string) => ({ width, height }),
    getDimsIfReady: (_canvasId: string) => ({ width, height }),
  };
}

/** CanvasDimsProvider whose dims are not resolved yet (simulates cold-connect race). */
function notReadyDimsProvider() {
  return {
    getDimsOrFallback: (_canvasId: string) => ({ width: 512, height: 512 }),
    getDimsIfReady: (_canvasId: string) => null,
  };
}

test("FEN-1762: 10×10 canvas rejects x=11 via per-canvas dimsProvider", async () => {
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20, canvasId: "small-canvas" });
  const cfg = { ...CFG, width: 512, height: 512, dimsProvider: staticDimsProvider(10, 10) };
  await new RedisPlacementHandler(runner, cfg, clock).handlePlace(conn, place({ x: 11, y: 0 }));
  assert.equal(runner.calls.length, 0, "script must not run for OOB placement on 10×10");
  assert.deepEqual(conn.sent, [
    { t: "error", code: "out_of_bounds", message: "pixel out of bounds", cid: CID },
  ]);
});

test("FEN-1762: 10×10 canvas rejects x=10 (first pixel past right edge)", async () => {
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20, canvasId: "small-canvas" });
  const cfg = { ...CFG, width: 512, height: 512, dimsProvider: staticDimsProvider(10, 10) };
  await new RedisPlacementHandler(runner, cfg, clock).handlePlace(conn, place({ x: 10, y: 0 }));
  assert.equal(runner.calls.length, 0, "x=10 is out of bounds for a 10-wide canvas (indices 0–9)");
});

test("FEN-1762: 10×10 canvas accepts x=9 (last valid column)", async () => {
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20, canvasId: "small-canvas" });
  const cfg = { ...CFG, width: 512, height: 512, dimsProvider: staticDimsProvider(10, 10) };
  await new RedisPlacementHandler(runner, cfg, clock).handlePlace(conn, place({ x: 9, y: 9 }));
  assert.equal(runner.calls.length, 1, "x=9 y=9 is in bounds for a 10×10 canvas");
});

test("FEN-1762: 100×100 canvas accepts x=50 y=50 (centre)", async () => {
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20, canvasId: "large-canvas" });
  const cfg = { ...CFG, width: 10, height: 10, dimsProvider: staticDimsProvider(100, 100) };
  await new RedisPlacementHandler(runner, cfg, clock).handlePlace(conn, place({ x: 50, y: 50 }));
  assert.equal(runner.calls.length, 1, "x=50 y=50 must be in bounds for a 100×100 canvas");
});

test("FEN-1762: 100×100 canvas passes the right width/height to the Lua script", async () => {
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20, canvasId: "large-canvas" });
  const cfg = { ...CFG, width: 10, height: 10, dimsProvider: staticDimsProvider(100, 100) };
  await new RedisPlacementHandler(runner, cfg, clock).handlePlace(conn, place({ x: 50, y: 50 }));
  const { argv } = runner.calls[0]!;
  // placeArgs ARGV: x,y,width,height,color,paletteSize,...
  assert.equal(argv[2], "100", "width handed to Lua must be the per-canvas dim, not the env default");
  assert.equal(argv[3], "100", "height handed to Lua must be the per-canvas dim, not the env default");
});

// ── FEN-1795: fail-closed bounds guard — no silent fallback to 512 ──────────

test("FEN-1795: placement rejected when dims not yet resolved (cold-connect race)", async () => {
  // dimsProvider returns null — simulates canvas subscribed but Convex fetch not yet done.
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20, canvasId: "small-canvas" });
  const cfg = { ...CFG, width: 512, height: 512, dimsProvider: notReadyDimsProvider() };
  // x=400, y=400 would pass the 512-fallback guard but is OOB on a real 10×10 canvas.
  await new RedisPlacementHandler(runner, cfg, clock).handlePlace(conn, place({ x: 400, y: 400 }));
  assert.equal(runner.calls.length, 0, "script must not run when dims are not yet resolved");
  const err = conn.sent[0] as { t: string; code: string };
  assert.equal(err.t, "error");
  assert.equal(err.code, "internal", "fail-closed produces an internal error, not a silent OOB pass");
});

test("FEN-1795: placement rejected when dims not resolved even for small coords", async () => {
  // Ensures the gate is on the dims-ready check, not on the coord range.
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20, canvasId: "small-canvas" });
  const cfg = { ...CFG, width: 512, height: 512, dimsProvider: notReadyDimsProvider() };
  await new RedisPlacementHandler(runner, cfg, clock).handlePlace(conn, place({ x: 1, y: 1 }));
  assert.equal(runner.calls.length, 0, "even a small-coord placement is rejected when dims not ready");
  const err = conn.sent[0] as { t: string; code: string };
  assert.equal(err.t, "error");
  assert.equal(err.code, "internal");
});

test("FEN-1795: in-bounds placement succeeds once dims ARE resolved", async () => {
  // Once the cache has dims the provider returns them and the placement goes through.
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20, canvasId: "small-canvas" });
  const cfg = { ...CFG, width: 512, height: 512, dimsProvider: staticDimsProvider(10, 10) };
  await new RedisPlacementHandler(runner, cfg, clock).handlePlace(conn, place({ x: 5, y: 5 }));
  assert.equal(runner.calls.length, 1, "x=5 y=5 is in bounds for a 10×10 canvas and should reach the script");
});

test("FEN-1795: OOB placement on 10×10 canvas still rejected when dims are resolved", async () => {
  // Guards against regression: the OOB guard still works after the fail-closed change.
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20, canvasId: "small-canvas" });
  const cfg = { ...CFG, width: 512, height: 512, dimsProvider: staticDimsProvider(10, 10) };
  await new RedisPlacementHandler(runner, cfg, clock).handlePlace(conn, place({ x: 400, y: 400 }));
  assert.equal(runner.calls.length, 0, "x=400 is OOB on a 10×10 canvas");
  assert.deepEqual(conn.sent, [
    { t: "error", code: "out_of_bounds", message: "pixel out of bounds", cid: CID },
  ]);
});

// ── FEN-1813 (round 3): forceResolve self-heal after resize scheduling gap ──

/**
 * Provider that simulates stale cached dims (from before a resize) but offers a
 * forceResolve() that returns the new dims (as if Convex already committed the mutation).
 * Models the scheduling gap: Convex mutation committed (new dims) but
 * notifyGatewayResize (runAfter(0)) has not yet reached the gateway.
 */
function staleDimsProvider(staleWidth: number, staleHeight: number, freshWidth: number, freshHeight: number) {
  return {
    getDimsOrFallback: (_canvasId: string) => ({ width: staleWidth, height: staleHeight }),
    getDimsIfReady: (_canvasId: string) => ({ width: staleWidth, height: staleHeight }),
    forceResolve: async (_canvasId: string) => ({ width: freshWidth, height: freshHeight }),
  };
}

test("FEN-1813/gap: placement at coords within NEW bounds succeeds via forceResolve after stale cache", async () => {
  // Simulates: canvas resized 10→20, Convex mutation committed, but gateway dimsCache
  // still has 10×10 (notifyGatewayResize not yet fired). Client already sees 20×20
  // via Convex reactivity and places at (15,15). forceResolve() must self-heal.
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20, canvasId: "canvas-1" });
  const cfg = { ...CFG, width: 512, height: 512, dimsProvider: staleDimsProvider(10, 10, 20, 20) };
  await new RedisPlacementHandler(runner, cfg, clock).handlePlace(conn, place({ x: 15, y: 15 }));
  assert.equal(runner.calls.length, 1, "placement must reach the script after stale-dims self-heal via forceResolve");
  assert.deepEqual(conn.sent, [
    { t: "ack", seq: 0, cid: CID, charges: 19, max: 20, cooldownUntil: 0 },
  ]);
  // Lua must receive the NEW dims (20×20), not the stale 10×10
  const { argv } = runner.calls[0]!;
  assert.equal(argv[2], "20", "width passed to Lua must be the fresh Convex dims");
  assert.equal(argv[3], "20", "height passed to Lua must be the fresh Convex dims");
});

test("FEN-1813/gap: truly OOB placement is still rejected even after forceResolve", async () => {
  // coords (50,50) are outside BOTH stale (10×10) and fresh (20×20) dims → real OOB
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20, canvasId: "canvas-1" });
  const cfg = { ...CFG, width: 512, height: 512, dimsProvider: staleDimsProvider(10, 10, 20, 20) };
  await new RedisPlacementHandler(runner, cfg, clock).handlePlace(conn, place({ x: 50, y: 50 }));
  assert.equal(runner.calls.length, 0, "x=50 y=50 is OOB even on 20×20; must be rejected");
  assert.deepEqual(conn.sent, [
    { t: "error", code: "out_of_bounds", message: "pixel out of bounds", cid: CID },
  ]);
});

test("FEN-1813/gap: no forceResolve provider — OOB still rejected immediately", async () => {
  // When dimsProvider has no forceResolve (e.g. static test provider), OOB is
  // rejected immediately without any async call — hot path regression guard.
  const runner = fakeRunner(["ok", 19, 20, 0]);
  const conn = fakeConn({ userId: "u", effectiveGaugeMax: 20, canvasId: "canvas-1" });
  const cfg = { ...CFG, width: 512, height: 512, dimsProvider: staticDimsProvider(10, 10) };
  await new RedisPlacementHandler(runner, cfg, clock).handlePlace(conn, place({ x: 15, y: 15 }));
  assert.equal(runner.calls.length, 0, "OOB on 10×10 without forceResolve must be rejected");
  assert.deepEqual(conn.sent, [
    { t: "error", code: "out_of_bounds", message: "pixel out of bounds", cid: CID },
  ]);
});
