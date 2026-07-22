/**
 * Tests for the F4 optimistic placement controller (FEN-60, migrated to the
 * ratified `cid` op id in FEN-70).
 *   node --test apps/web/src/features/canvas/placement.test.ts
 *
 * Covers the acceptance criteria:
 *   - optimistic paint on place, tagged with an opaque `cid`, confirmed by `ack.cid`
 *   - rollback on `cooldown` / `error.cid`, with the right i18n feedback
 *   - reconnect: un-acked ops re-sent with the SAME `cid` (CA5 idempotency)
 *   - the default cid generator is opaque and non-resetting (no false-replay)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  OptimisticPlacement,
  EMPTY_COLOR,
  defaultCidGen,
  type PlacementSurface,
  type PlacementFeedback,
} from "./placement.ts";
import type { ErrorCode, GaugeState } from "@canvas/protocol";

const W = 512;
const H = 512;
const PALETTE = 32;

/** A Map-backed surface; missing pixels read as EMPTY_COLOR (0). */
function makeSurface(): PlacementSurface & { at(x: number, y: number): number } {
  const px = new Map<string, number>();
  const key = (x: number, y: number) => `${x},${y}`;
  return {
    getPixel: (x, y) => px.get(key(x, y)) ?? EMPTY_COLOR,
    setPixel: (x, y, c) => void px.set(key(x, y), c),
    at: (x, y) => px.get(key(x, y)) ?? EMPTY_COLOR,
  };
}

interface Harness {
  ctrl: OptimisticPlacement;
  surface: ReturnType<typeof makeSurface>;
  gauges: GaugeState[];
  feedback: PlacementFeedback[];
}

function makeCtrl(now = () => 1_000_000, blockWhenEmpty = true): Harness {
  const surface = makeSurface();
  const gauges: GaugeState[] = [];
  const feedback: PlacementFeedback[] = [];
  // Deterministic opaque cid for assertions: `op-1`, `op-2`, … . Production uses
  // the injected default (a UUID); the controller treats `cid` as opaque either way.
  let n = 0;
  const ctrl = new OptimisticPlacement({
    width: W,
    height: H,
    paletteSize: PALETTE,
    surface,
    now,
    genCid: () => `op-${++n}`,
    blockWhenEmpty,
    onGauge: (g) => gauges.push(g),
    onFeedback: (f) => feedback.push(f),
  });
  return { ctrl, surface, gauges, feedback };
}

// ── optimistic paint + ack ───────────────────────────────────────────────────

test("place paints immediately and tags the op with an opaque cid", () => {
  const { ctrl, surface } = makeCtrl();
  const m1 = ctrl.place(10, 20, 5);
  const m2 = ctrl.place(11, 20, 6);
  assert.deepEqual(m1, { t: "place", x: 10, y: 20, color: 5, cid: "op-1" });
  assert.deepEqual(m2, { t: "place", x: 11, y: 20, color: 6, cid: "op-2" });
  assert.equal("seq" in (m1 as object), false, "place no longer carries seq");
  assert.equal(surface.at(10, 20), 5, "pixel is painted optimistically");
  assert.equal(surface.at(11, 20), 6);
  assert.equal(ctrl.pendingCount, 2);
});

test("ack confirms the op via its cid: pixel stays, gauge from the ack, pending clears", () => {
  const { ctrl, surface, gauges } = makeCtrl();
  const m = ctrl.place(3, 4, 7)!;
  ctrl.handle({ t: "ack", cid: m.cid, charges: 19, max: 23, cooldownUntil: 1_030_000 });
  assert.equal(surface.at(3, 4), 7, "confirmed pixel is kept");
  assert.equal(ctrl.pendingCount, 0, "ack clears the pending op");
  assert.deepEqual(gauges.at(-1), { charges: 19, max: 23, cooldownUntil: 1_030_000 });
});

test("erase places the empty colour", () => {
  const { ctrl, surface } = makeCtrl();
  surface.setPixel(5, 5, 9); // pre-existing pixel
  const m = ctrl.place(5, 5, EMPTY_COLOR)!;
  assert.equal(m.color, EMPTY_COLOR);
  assert.equal(surface.at(5, 5), EMPTY_COLOR);
});

// ── rollback paths ───────────────────────────────────────────────────────────

test("error frame rolls the optimistic pixel back to its previous colour (matched by cid)", () => {
  const { ctrl, surface, feedback } = makeCtrl();
  surface.setPixel(8, 9, 2); // previous authoritative colour
  const m = ctrl.place(8, 9, 5)!;
  assert.equal(surface.at(8, 9), 5);
  ctrl.handle({ t: "error", code: "rate_limited", message: "slow down", cid: m.cid });
  assert.equal(surface.at(8, 9), 2, "reverted to the pre-place colour");
  assert.equal(ctrl.pendingCount, 0);
  assert.equal(feedback.at(-1)!.messageKey, "canvas.feedback.rateLimited");
});

test("banned error surfaces the banned feedback and rolls back", () => {
  const { ctrl, surface, feedback } = makeCtrl();
  const m = ctrl.place(1, 1, 5)!;
  ctrl.handle({ t: "error", code: "banned", message: "banned", cid: m.cid });
  assert.equal(surface.at(1, 1), EMPTY_COLOR);
  assert.deepEqual(
    { kind: feedback.at(-1)!.kind, key: feedback.at(-1)!.messageKey },
    { kind: "banned", key: "canvas.feedback.banned" },
  );
});

test("cooldown frame (no cid) rolls back the OLDEST un-acked op and reports a countdown", () => {
  const now = () => 1_000_000;
  const { ctrl, surface, feedback, gauges } = makeCtrl(now);
  const a = ctrl.place(0, 0, 3)!; // oldest
  ctrl.place(1, 0, 4); // newer
  ctrl.handle({ t: "cooldown", until: 1_000_000 + 12_000 });
  assert.equal(surface.at(0, 0), EMPTY_COLOR, "oldest op rolled back");
  assert.equal(surface.at(1, 0), 4, "newer op untouched");
  assert.equal(ctrl.pendingCount, 1);
  const f = feedback.at(-1)!;
  assert.equal(f.kind, "cooldown");
  assert.equal(f.messageKey, "canvas.feedback.cooldown");
  assert.equal(f.params!.seconds, 12, "ceil((until-now)/1000)");
  assert.equal(gauges.at(-1)!.charges, 0, "gauge reflects empty during cooldown");
  assert.equal(a.cid, "op-1");
});

test("interleaved ack then cooldown correlate to the right ops (cid commit, FIFO cooldown)", () => {
  const { ctrl, surface } = makeCtrl();
  const a = ctrl.place(0, 0, 5)!; // op-1
  const b = ctrl.place(1, 1, 6)!; // op-2
  ctrl.handle({ t: "ack", cid: a.cid, charges: 1, max: 10, cooldownUntil: 0 }); // confirms A by cid
  ctrl.handle({ t: "cooldown", until: 1_000_000 }); // refuses the now-oldest, B (no cid → FIFO)
  assert.equal(surface.at(0, 0), 5, "A confirmed");
  assert.equal(surface.at(1, 1), EMPTY_COLOR, "B rolled back");
  assert.equal(ctrl.pendingCount, 0);
  assert.equal(b.cid, "op-2");
});

// ── local validation (no wasted cid / send) ──────────────────────────────────

test("out-of-bounds and bad colour are rejected locally without minting a cid", () => {
  const { ctrl, feedback } = makeCtrl();
  assert.equal(ctrl.place(-1, 0, 5), null);
  assert.equal(ctrl.place(0, 0, 999), null);
  assert.equal(feedback[0]!.messageKey, "canvas.feedback.outOfBounds");
  assert.equal(feedback[1]!.messageKey, "canvas.feedback.invalidColor");
  // next valid op is still op-1 — rejected ops never advanced the generator
  assert.equal(ctrl.place(0, 0, 5)!.cid, "op-1");
});

test("place is blocked locally when the gauge is known-empty", () => {
  const now = () => 1_000_000;
  const { ctrl, feedback } = makeCtrl(now);
  ctrl.handle({ t: "gauge", charges: 0, max: 10, cooldownUntil: 1_000_000 + 5_000 });
  const m = ctrl.place(2, 2, 5);
  assert.equal(m, null, "no send when the gauge is empty");
  const f = feedback.at(-1)!;
  assert.equal(f.kind, "cooldown");
  assert.equal(f.params!.seconds, 5);
});

test("blockWhenEmpty=false still attempts the send when empty", () => {
  const { ctrl } = makeCtrl(() => 1_000_000, false);
  ctrl.handle({ t: "gauge", charges: 0, max: 10, cooldownUntil: 1_000_000 + 5_000 });
  assert.notEqual(ctrl.place(2, 2, 5), null);
});

// ── reconnect / idempotency (CA5) ────────────────────────────────────────────

test("resendQueue returns un-acked ops with the SAME cid, oldest-first", () => {
  const { ctrl } = makeCtrl();
  const a = ctrl.place(0, 0, 5)!;
  const b = ctrl.place(1, 0, 6)!;
  const c = ctrl.place(2, 0, 7)!;
  // ack the middle one by its cid — only A and C remain un-acked
  ctrl.handle({ t: "ack", cid: b.cid, charges: 5, max: 10, cooldownUntil: 0 });
  const queue = ctrl.resendQueue();
  assert.deepEqual(
    queue.map((m) => m.cid),
    [a.cid, c.cid],
    "same cids, oldest-first, ack'd op excluded",
  );
  // a replay must reuse the ORIGINAL cid (so the gateway's SET NX dedups it)
  assert.deepEqual(queue[0], { t: "place", x: 0, y: 0, color: 5, cid: a.cid });
});

test("repaintPending re-applies optimistic pixels onto a replaced buffer and keeps rollback correct", () => {
  const { ctrl, surface } = makeCtrl();
  const m = ctrl.place(4, 4, 5)!;
  // simulate a fresh snapshot replacing the buffer: the cell is now colour 3
  surface.setPixel(4, 4, 3);
  ctrl.repaintPending();
  assert.equal(surface.at(4, 4), 5, "optimistic pixel re-applied on top of the new base");
  // a subsequent refusal must revert to the NEW base (3), not the stale 0
  ctrl.handle({ t: "error", code: "internal", message: "x", cid: m.cid });
  assert.equal(surface.at(4, 4), 3);
});

test("a duplicate or unknown ack/error cid is a harmless no-op", () => {
  const { ctrl, surface } = makeCtrl();
  const m = ctrl.place(0, 0, 5)!;
  ctrl.handle({ t: "ack", cid: m.cid, charges: 1, max: 2, cooldownUntil: 0 });
  // late duplicate ack and a stray error for an already-cleared / unknown op
  ctrl.handle({ t: "ack", cid: m.cid, charges: 1, max: 2, cooldownUntil: 0 });
  ctrl.handle({ t: "error", code: "internal", message: "x", cid: "op-does-not-exist" });
  assert.equal(surface.at(0, 0), 5, "confirmed pixel untouched by stray frames");
  assert.equal(ctrl.pendingCount, 0);
});

// ── onCommitted trigger gating (G3 first-pose confetti, FEN-587) ─────────────

test("onCommitted fires with erased=false on a paint ack", () => {
  const committed: Array<{ cid: string; erased: boolean }> = [];
  const surface = makeSurface();
  let n = 0;
  const ctrl = new OptimisticPlacement({
    width: W, height: H, paletteSize: PALETTE, surface,
    genCid: () => `op-${++n}`,
    onCommitted: (info) => committed.push(info),
  });
  const m = ctrl.place(1, 2, 5)!;
  ctrl.handle({ t: "ack", cid: m.cid, charges: 10, max: 10, cooldownUntil: 0 });
  assert.equal(committed.length, 1);
  assert.deepEqual(committed[0], { cid: "op-1", erased: false });
});

test("onCommitted fires with erased=true when the op painted EMPTY_COLOR", () => {
  const committed: Array<{ cid: string; erased: boolean }> = [];
  const surface = makeSurface();
  surface.setPixel(3, 3, 7); // pre-existing pixel
  let n = 0;
  const ctrl = new OptimisticPlacement({
    width: W, height: H, paletteSize: PALETTE, surface,
    genCid: () => `op-${++n}`,
    onCommitted: (info) => committed.push(info),
  });
  const m = ctrl.place(3, 3, EMPTY_COLOR)!;
  ctrl.handle({ t: "ack", cid: m.cid, charges: 10, max: 10, cooldownUntil: 0 });
  assert.equal(committed.length, 1);
  assert.deepEqual(committed[0], { cid: "op-1", erased: true });
});

test("onCommitted does NOT fire on an error rollback", () => {
  const committed: Array<{ cid: string; erased: boolean }> = [];
  const surface = makeSurface();
  let n = 0;
  const ctrl = new OptimisticPlacement({
    width: W, height: H, paletteSize: PALETTE, surface,
    genCid: () => `op-${++n}`,
    onCommitted: (info) => committed.push(info),
  });
  const m = ctrl.place(0, 0, 5)!;
  ctrl.handle({ t: "error", code: "rate_limited", message: "slow", cid: m.cid });
  assert.equal(committed.length, 0, "rollback must not emit onCommitted");
});

test("onCommitted does NOT fire on a cooldown rollback", () => {
  const committed: Array<{ cid: string; erased: boolean }> = [];
  const surface = makeSurface();
  let n = 0;
  const ctrl = new OptimisticPlacement({
    width: W, height: H, paletteSize: PALETTE, surface,
    genCid: () => `op-${++n}`,
    onCommitted: (info) => committed.push(info),
  });
  ctrl.place(0, 0, 5);
  ctrl.handle({ t: "cooldown", until: 2_000_000 });
  assert.equal(committed.length, 0, "cooldown rollback must not emit onCommitted");
});

test("onCommitted does NOT fire for a duplicate/stale ack whose pending entry is already gone", () => {
  const committed: Array<{ cid: string; erased: boolean }> = [];
  const surface = makeSurface();
  let n = 0;
  const ctrl = new OptimisticPlacement({
    width: W, height: H, paletteSize: PALETTE, surface,
    genCid: () => `op-${++n}`,
    onCommitted: (info) => committed.push(info),
  });
  const m = ctrl.place(0, 0, 5)!;
  ctrl.handle({ t: "ack", cid: m.cid, charges: 10, max: 10, cooldownUntil: 0 });
  assert.equal(committed.length, 1, "first ack fires");
  // Duplicate ack for an already-cleared cid — entry is gone, no second fire.
  ctrl.handle({ t: "ack", cid: m.cid, charges: 10, max: 10, cooldownUntil: 0 });
  assert.equal(committed.length, 1, "duplicate ack must not re-fire onCommitted");
});

test("onCommitted fires per-op (multiple sequential placements)", () => {
  const committed: Array<{ cid: string; erased: boolean }> = [];
  const surface = makeSurface();
  let n = 0;
  const ctrl = new OptimisticPlacement({
    width: W, height: H, paletteSize: PALETTE, surface,
    genCid: () => `op-${++n}`,
    onCommitted: (info) => committed.push(info),
  });
  const a = ctrl.place(0, 0, 3)!;
  const b = ctrl.place(1, 0, EMPTY_COLOR)!;
  ctrl.handle({ t: "ack", cid: a.cid, charges: 9, max: 10, cooldownUntil: 0 });
  ctrl.handle({ t: "ack", cid: b.cid, charges: 8, max: 10, cooldownUntil: 0 });
  assert.equal(committed.length, 2);
  assert.deepEqual(committed[0], { cid: "op-1", erased: false });
  assert.deepEqual(committed[1], { cid: "op-2", erased: true });
});

// ── all ErrorCode values map to a distinct i18n key (C3 exhaustive sweep) ──────

/**
 * For each server ErrorCode: an `error` frame must roll back the pixel AND
 * emit a feedback carrying the expected i18n messageKey (no string literals
 * in the controller itself). C3 criterion from FEN-643.
 */
const ERROR_CODE_CASES: Array<{ code: ErrorCode; messageKey: string; kind: string }> = [
  { code: "unauthenticated", messageKey: "canvas.feedback.signInRequired", kind: "rejected" },
  { code: "cooldown", messageKey: "canvas.feedback.cooldown", kind: "cooldown" },
  { code: "out_of_bounds", messageKey: "canvas.feedback.outOfBounds", kind: "rejected" },
  { code: "invalid_color", messageKey: "canvas.feedback.invalidColor", kind: "rejected" },
  { code: "rate_limited", messageKey: "canvas.feedback.rateLimited", kind: "rejected" },
  { code: "banned", messageKey: "canvas.feedback.banned", kind: "banned" },
  { code: "internal", messageKey: "canvas.feedback.error", kind: "error" },
  { code: "frozen", messageKey: "canvas.feedback.frozen", kind: "rejected" },
  { code: "bad_request", messageKey: "canvas.feedback.badRequest", kind: "error" },
];

for (const { code, messageKey, kind } of ERROR_CODE_CASES) {
  test(`error { code: "${code}" } → rollback pixel + feedback key "${messageKey}"`, () => {
    const { ctrl, surface, feedback } = makeCtrl();
    surface.setPixel(2, 3, 4); // pre-existing colour to restore on rollback
    const m = ctrl.place(2, 3, 7)!;
    assert.equal(surface.at(2, 3), 7, "optimistic paint");
    ctrl.handle({ t: "error", code, message: "test", cid: m.cid });
    assert.equal(surface.at(2, 3), 4, `rollback for code="${code}"`);
    assert.equal(ctrl.pendingCount, 0);
    const f = feedback.at(-1)!;
    assert.equal(f.messageKey, messageKey, `i18n key for code="${code}"`);
    assert.equal(f.kind, kind, `feedback kind for code="${code}"`);
    assert.equal(f.code, code, "code forwarded on feedback");
  });
}

// ── setDims: bounds update after resize (FEN-1821) ──────────────────────────

test("setDims allows placement in newly-expanded area without sending a WS message first", () => {
  // Start with a 10×10 canvas (like a real small canvas).
  const surface = makeSurface();
  const feedback: PlacementFeedback[] = [];
  let n = 0;
  const ctrl = new OptimisticPlacement({
    width: 10,
    height: 10,
    paletteSize: PALETTE,
    surface,
    genCid: () => `op-${++n}`,
    onFeedback: (f) => feedback.push(f),
  });

  // Before resize: placing at (15, 15) is rejected locally (out of bounds).
  assert.equal(ctrl.place(15, 15, 5), null);
  assert.equal(feedback[0]!.messageKey, "canvas.feedback.outOfBounds");

  // Simulate canvas resize to 20×20 (Convex reactive update).
  ctrl.setDims(20, 20);

  // After resize: placing in new area (e.g. x=15, y=15) must succeed.
  const msg = ctrl.place(15, 15, 5);
  assert.notEqual(msg, null, "placement in newly-expanded area should succeed after setDims");
  assert.deepEqual(msg, { t: "place", x: 15, y: 15, color: 5, cid: "op-1" });
  assert.equal(surface.at(15, 15), 5, "pixel painted optimistically");

  // Old area still works.
  assert.notEqual(ctrl.place(0, 0, 3), null, "placement in original area still works");
});

test("setDims rejects placement outside the new (reduced) bounds", () => {
  const surface = makeSurface();
  const feedback: PlacementFeedback[] = [];
  let n = 0;
  const ctrl = new OptimisticPlacement({
    width: 20,
    height: 20,
    paletteSize: PALETTE,
    surface,
    genCid: () => `op-${++n}`,
    onFeedback: (f) => feedback.push(f),
  });

  // Place succeeds at (15, 15) before resize.
  assert.notEqual(ctrl.place(15, 15, 5), null);

  // Resize down to 10×10.
  ctrl.setDims(10, 10);

  // (15, 15) is now out of bounds.
  assert.equal(ctrl.place(15, 15, 3), null);
  assert.equal(feedback.at(-1)!.messageKey, "canvas.feedback.outOfBounds");
});

// ── default cid generator (opaque, non-resetting) ─────────────────────────────

test("defaultCidGen yields opaque, unique, non-integer ids (no false-replay risk)", () => {
  const a = defaultCidGen();
  const b = defaultCidGen();
  assert.equal(typeof a, "string");
  assert.notEqual(a, b, "each op gets a distinct cid");
  // opaque token, NOT a per-session integer that could reset to "1" on restart
  assert.equal(/^\d+$/.test(a), false, "cid is not a bare integer counter");
  assert.ok(a.length >= 8, "cid is a substantial opaque token");
});

test("a controller using the default cid generator round-trips commit + rollback", () => {
  const surface = makeSurface();
  const ctrl = new OptimisticPlacement({ width: W, height: H, paletteSize: PALETTE, surface });
  const m1 = ctrl.place(7, 7, 5)!; // committed
  const m2 = ctrl.place(8, 8, 6)!; // rolled back
  assert.notEqual(m1.cid, m2.cid);
  ctrl.handle({ t: "ack", cid: m1.cid, charges: 1, max: 10, cooldownUntil: 0 });
  ctrl.handle({ t: "error", code: "rate_limited", message: "slow", cid: m2.cid });
  assert.equal(surface.at(7, 7), 5, "ack'd pixel kept");
  assert.equal(surface.at(8, 8), EMPTY_COLOR, "errored pixel rolled back");
  assert.equal(ctrl.pendingCount, 0);
});
