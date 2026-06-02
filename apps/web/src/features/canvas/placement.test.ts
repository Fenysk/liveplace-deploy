/**
 * Tests for the F4 optimistic placement controller (FEN-60).
 *   node --test apps/web/src/features/canvas/placement.test.ts
 *
 * Covers the acceptance criteria:
 *   - optimistic paint on place, confirmed by `ack`, gauge from the `ack`
 *   - rollback on `cooldown` / `error`, with the right i18n feedback
 *   - reconnect: un-acked ops re-sent with the SAME seq (CA5 idempotency)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  OptimisticPlacement,
  EMPTY_COLOR,
  type PlacementSurface,
  type PlacementFeedback,
} from "./placement.ts";
import type { GaugeState } from "@canvas/protocol";

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
  const ctrl = new OptimisticPlacement({
    width: W,
    height: H,
    paletteSize: PALETTE,
    surface,
    now,
    blockWhenEmpty,
    onGauge: (g) => gauges.push(g),
    onFeedback: (f) => feedback.push(f),
  });
  return { ctrl, surface, gauges, feedback };
}

// ── optimistic paint + ack ───────────────────────────────────────────────────

test("place paints immediately and emits a positive monotonic seq", () => {
  const { ctrl, surface } = makeCtrl();
  const m1 = ctrl.place(10, 20, 5);
  const m2 = ctrl.place(11, 20, 6);
  assert.deepEqual(m1, { t: "place", x: 10, y: 20, color: 5, seq: 1 });
  assert.deepEqual(m2, { t: "place", x: 11, y: 20, color: 6, seq: 2 });
  assert.equal(surface.at(10, 20), 5, "pixel is painted optimistically");
  assert.equal(surface.at(11, 20), 6);
  assert.equal(ctrl.pendingCount, 2);
});

test("ack confirms the op: pixel stays, gauge comes from the ack, pending clears", () => {
  const { ctrl, surface, gauges } = makeCtrl();
  const m = ctrl.place(3, 4, 7)!;
  ctrl.handle({ t: "ack", seq: m.seq!, charges: 19, max: 23, cooldownUntil: 1_030_000 });
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

test("error frame rolls the optimistic pixel back to its previous colour", () => {
  const { ctrl, surface, feedback } = makeCtrl();
  surface.setPixel(8, 9, 2); // previous authoritative colour
  const m = ctrl.place(8, 9, 5)!;
  assert.equal(surface.at(8, 9), 5);
  ctrl.handle({ t: "error", code: "rate_limited", message: "slow down", seq: m.seq });
  assert.equal(surface.at(8, 9), 2, "reverted to the pre-place colour");
  assert.equal(ctrl.pendingCount, 0);
  assert.equal(feedback.at(-1)!.messageKey, "canvas.feedback.rateLimited");
});

test("banned error surfaces the banned feedback and rolls back", () => {
  const { ctrl, surface, feedback } = makeCtrl();
  const m = ctrl.place(1, 1, 5)!;
  ctrl.handle({ t: "error", code: "banned", message: "banned", seq: m.seq });
  assert.equal(surface.at(1, 1), EMPTY_COLOR);
  assert.deepEqual(
    { kind: feedback.at(-1)!.kind, key: feedback.at(-1)!.messageKey },
    { kind: "banned", key: "canvas.feedback.banned" },
  );
});

test("cooldown frame (no seq) rolls back the OLDEST un-acked op and reports a countdown", () => {
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
  assert.equal(a.seq, 1);
});

test("interleaved ack then cooldown correlate to the right ops (FIFO under TCP order)", () => {
  const { ctrl, surface } = makeCtrl();
  const a = ctrl.place(0, 0, 5)!; // seq 1
  const b = ctrl.place(1, 1, 6)!; // seq 2
  ctrl.handle({ t: "ack", seq: a.seq!, charges: 1, max: 10, cooldownUntil: 0 }); // confirms A
  ctrl.handle({ t: "cooldown", until: 1_000_000 }); // refuses the now-oldest, B
  assert.equal(surface.at(0, 0), 5, "A confirmed");
  assert.equal(surface.at(1, 1), EMPTY_COLOR, "B rolled back");
  assert.equal(ctrl.pendingCount, 0);
  assert.equal(b.seq, 2);
});

// ── local validation (no wasted seq / send) ──────────────────────────────────

test("out-of-bounds and bad colour are rejected locally without burning a seq", () => {
  const { ctrl, feedback } = makeCtrl();
  assert.equal(ctrl.place(-1, 0, 5), null);
  assert.equal(ctrl.place(0, 0, 999), null);
  assert.equal(feedback[0]!.messageKey, "canvas.feedback.outOfBounds");
  assert.equal(feedback[1]!.messageKey, "canvas.feedback.invalidColor");
  // next valid op is still seq 1 — rejected ops never incremented the counter
  assert.equal(ctrl.place(0, 0, 5)!.seq, 1);
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

test("resendQueue returns un-acked ops with the SAME seq, oldest-first", () => {
  const { ctrl } = makeCtrl();
  const a = ctrl.place(0, 0, 5)!;
  const b = ctrl.place(1, 0, 6)!;
  const c = ctrl.place(2, 0, 7)!;
  // ack the middle one — only A and C remain un-acked
  ctrl.handle({ t: "ack", seq: b.seq!, charges: 5, max: 10, cooldownUntil: 0 });
  const queue = ctrl.resendQueue();
  assert.deepEqual(
    queue.map((m) => m.seq),
    [a.seq, c.seq],
    "same seqs, oldest-first, ack'd op excluded",
  );
  // a replay must not allocate new seqs
  assert.deepEqual(queue[0], { t: "place", x: 0, y: 0, color: 5, seq: a.seq });
});

test("repaintPending re-applies optimistic pixels onto a replaced buffer and keeps rollback correct", () => {
  const { ctrl, surface } = makeCtrl();
  const m = ctrl.place(4, 4, 5)!;
  // simulate a fresh snapshot replacing the buffer: the cell is now colour 3
  surface.setPixel(4, 4, 3);
  ctrl.repaintPending();
  assert.equal(surface.at(4, 4), 5, "optimistic pixel re-applied on top of the new base");
  // a subsequent refusal must revert to the NEW base (3), not the stale 0
  ctrl.handle({ t: "error", code: "internal", message: "x", seq: m.seq });
  assert.equal(surface.at(4, 4), 3);
});

test("a duplicate or unknown ack/error seq is a harmless no-op", () => {
  const { ctrl, surface } = makeCtrl();
  const m = ctrl.place(0, 0, 5)!;
  ctrl.handle({ t: "ack", seq: m.seq!, charges: 1, max: 2, cooldownUntil: 0 });
  // late duplicate ack and a stray error for an already-cleared op
  ctrl.handle({ t: "ack", seq: m.seq!, charges: 1, max: 2, cooldownUntil: 0 });
  ctrl.handle({ t: "error", code: "internal", message: "x", seq: 999 });
  assert.equal(surface.at(0, 0), 5, "confirmed pixel untouched by stray frames");
  assert.equal(ctrl.pendingCount, 0);
});
