/**
 * Tests for the viewer moderation-event legibility reducer (Lot I, FEN-121).
 * Definition-of-Done for the viewer half: prove the watcher learns "a collective
 * event happened" without jargon, and — critically — that a plain network resync
 * never reads as a moderation event (that is the anxiety the lot exists to avoid).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveModerationNotice, type CanvasLiveness } from "./moderationNotice.ts";
import { en } from "../../../../../packages/i18n/src/messages/en.ts";
import { fr } from "../../../../../packages/i18n/src/messages/fr.ts";

const calm: CanvasLiveness = { frozen: false, bulkChangeSeq: 0 };

test("no change between identical snapshots → no notice", () => {
  assert.equal(deriveModerationNotice(calm, calm), null);
});

test("a server-initiated bulk overwrite surfaces the non-anxiogène area-changed notice", () => {
  const notice = deriveModerationNotice(calm, { frozen: false, bulkChangeSeq: 1 });
  assert.ok(notice);
  assert.equal(notice.kind, "areaChanged");
  assert.equal(notice.messageKey, "canvas.moderation.areaChanged");
});

test("freeze (open → frozen) surfaces the paused notice", () => {
  const notice = deriveModerationNotice(calm, { frozen: true, bulkChangeSeq: 0 });
  assert.ok(notice);
  assert.equal(notice.kind, "paused");
  assert.equal(notice.messageKey, "canvas.moderation.paused");
});

test("reopen (frozen → open) surfaces the gentle recovery notice", () => {
  const notice = deriveModerationNotice(
    { frozen: true, bulkChangeSeq: 0 },
    { frozen: false, bulkChangeSeq: 0 },
  );
  assert.ok(notice);
  assert.equal(notice.kind, "reopened");
  assert.equal(notice.messageKey, "canvas.moderation.reopened");
});

test("a ban-and-wipe both freezes and overwrites → the area-change wins (most salient)", () => {
  const notice = deriveModerationNotice(calm, { frozen: true, bulkChangeSeq: 1 });
  assert.ok(notice);
  assert.equal(notice.kind, "areaChanged");
});

test("staying frozen with no new overwrite → no repeated notice", () => {
  const frozen: CanvasLiveness = { frozen: true, bulkChangeSeq: 2 };
  assert.equal(deriveModerationNotice(frozen, frozen), null);
});

test("every notice is polite (informational, never an assertive alert) and transient", () => {
  for (const next of [
    { frozen: false, bulkChangeSeq: 1 },
    { frozen: true, bulkChangeSeq: 0 },
  ] satisfies CanvasLiveness[]) {
    const notice = deriveModerationNotice(calm, next);
    assert.ok(notice);
    assert.equal(notice.ariaLive, "polite");
    assert.ok(notice.autoDismissMs > 0, "notice auto-dismisses, never lingers like an error");
  }
});

test("every moderation notice key resolves in BOTH catalogs (FR/EN parity, C6)", () => {
  const keys = [
    "canvas.moderation.areaChanged",
    "canvas.moderation.paused",
    "canvas.moderation.reopened",
  ];
  for (const k of keys) {
    assert.ok(k in en, `missing EN key: ${k}`);
    assert.ok(k in fr, `missing FR key: ${k}`);
  }
});

test("a reconnect that does NOT bump bulkChangeSeq is silent (network resync ≠ moderation)", () => {
  // net.ts only bumps bulkChangeSeq for server-initiated mass overwrites, never
  // for the client's own reconnect resync. So with the counter unchanged and no
  // freeze transition, a fresh-snapshot-on-reconnect produces no anxiety notice.
  const before: CanvasLiveness = { frozen: false, bulkChangeSeq: 5 };
  const afterReconnect: CanvasLiveness = { frozen: false, bulkChangeSeq: 5 };
  assert.equal(deriveModerationNotice(before, afterReconnect), null);
});
