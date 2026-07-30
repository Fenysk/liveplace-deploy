/**
 * Integration test: drive {@link OptimisticPlacement} through a real
 * {@link BufferSurface} (palette-index pixel buffer) and assert the buffer the
 * renderer would draw is correct at each stage of the pose→ack→rollback flow.
 *
 * This is the headless equivalent of the FEN-65 visual capture: the same
 * controller + the same pixel buffer, just rendered to assertions instead of a
 * PNG.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OptimisticPlacement } from "./placement.ts";
import { BufferSurface } from "./bufferSurface.ts";

const PALETTE_SIZE = 32;

function makeController(surface: BufferSurface, feedback: string[] = []) {
  let n = 0;
  const placement = new OptimisticPlacement({
    width: surface.width,
    height: surface.height,
    paletteSize: PALETTE_SIZE,
    surface,
    now: () => 1_000_000,
    genCid: () => `cid-${++n}`,
    onFeedback: (f) => feedback.push(`${f.kind}:${f.messageKey}`),
  });
  return placement;
}

test("optimistic pose paints immediately and an ack keeps it", () => {
  const surface = new BufferSurface(8, 8, 0);
  const placement = makeController(surface);

  const msg = placement.place(3, 4, 5);
  assert.ok(msg, "place returns a wire message");
  assert.equal(surface.getPixel(3, 4), 5, "optimistic pixel painted before ack");
  assert.equal(placement.pendingCount, 1);

  placement.handle({ t: "ack", cid: msg!.cid!, charges: 4, max: 5, cooldownUntil: 0 });
  assert.equal(surface.getPixel(3, 4), 5, "ack confirms — pixel stays");
  assert.equal(placement.pendingCount, 0, "no longer pending");
});

test("a refusal (error) rolls the optimistic pose back to its prior colour", () => {
  const surface = new BufferSurface(8, 8, 0);
  surface.setPixel(3, 4, 7); // a previously-set colour under the new pose
  const feedback: string[] = [];
  const placement = makeController(surface, feedback);

  const msg = placement.place(3, 4, 5);
  assert.equal(surface.getPixel(3, 4), 5, "optimistic paint over the old colour");

  placement.handle({ t: "error", code: "banned", message: "banned", cid: msg!.cid! });
  assert.equal(surface.getPixel(3, 4), 7, "rollback restores the prior colour");
  assert.equal(placement.pendingCount, 0);
  assert.ok(feedback.includes("banned:canvas.feedback.banned"), "banned feedback emitted");
});

test("a cooldown frame rolls back the oldest un-acked pose (no cid)", () => {
  const surface = new BufferSurface(8, 8, 0);
  const feedback: string[] = [];
  const placement = makeController(surface, feedback);
  // seed a non-empty gauge so the local empty-block doesn't pre-reject
  placement.handle({ t: "gauge", charges: 1, max: 5, cooldownUntil: 0 });

  const a = placement.place(1, 1, 5);
  assert.ok(a);
  assert.equal(surface.getPixel(1, 1), 5);

  placement.handle({ t: "cooldown", until: 1_005_000 });
  assert.equal(surface.getPixel(1, 1), 0, "cooldown rolled the pose back");
  assert.ok(feedback.some((f) => f.startsWith("cooldown:")), "cooldown feedback emitted");
});
