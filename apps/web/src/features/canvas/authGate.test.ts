/**
 * Tests for the FEN-115 view-first auth gate — the Definition-of-Done surface
 * for "consentement à la 1re interaction" (UX Lot B).
 *   node --test apps/web/src/features/canvas/authGate.test.ts
 *
 * Covers the acceptance criteria:
 *   - an anonymous viewer can view/zoom/pan/pick-colour/arm without an account
 *   - the FIRST account-requiring interaction (enter-draw / stage-cell / commit)
 *     triggers consent — and NOT only the commit
 *   - the consent returns to the SAME `/c/{slug}` (callbackURL)
 *   - an authenticated viewer is never gated
 *   - cancellation is non-punitive (a consent decision is inert until acted on)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canvasCallbackURL,
  gateInteraction,
  requiresAccount,
  type CanvasInteraction,
} from "./authGate.ts";

const READ_ONLY: CanvasInteraction[] = ["view", "zoom", "pan", "pick-color", "toggle-erase", "arm"];
const ACCOUNT_GATED: CanvasInteraction[] = ["enter-draw", "stage-cell", "validate"];

test("read-only interactions never require an account", () => {
  for (const i of READ_ONLY) {
    assert.equal(requiresAccount(i), false, `${i} should be anonymous`);
  }
});

test("account-requiring interactions are gated — and not only the commit", () => {
  for (const i of ACCOUNT_GATED) {
    assert.equal(requiresAccount(i), true, `${i} should require an account`);
  }
  // The defining spec point: entering draw / first selection gates BEFORE commit.
  assert.equal(requiresAccount("enter-draw"), true);
  assert.equal(requiresAccount("stage-cell"), true);
});

test("anonymous read-only interactions proceed without consent", () => {
  for (const i of READ_ONLY) {
    assert.deepEqual(
      gateInteraction(i, false, { slug: "pixelwar" }),
      { kind: "proceed" },
      `${i} should proceed anonymously`,
    );
  }
});

test("first account-requiring interaction triggers consent back to the same canvas", () => {
  for (const i of ACCOUNT_GATED) {
    assert.deepEqual(
      gateInteraction(i, false, { slug: "pixelwar" }),
      // FEN-433: canonical URL is now /{slug}, not /c/{slug}
      { kind: "consent", callbackURL: "/pixelwar" },
      `${i} should ask for consent`,
    );
  }
});

test("an authenticated viewer is never gated", () => {
  for (const i of [...READ_ONLY, ...ACCOUNT_GATED]) {
    assert.deepEqual(
      gateInteraction(i, true, { slug: "pixelwar" }),
      { kind: "proceed" },
      `${i} should proceed when authenticated`,
    );
  }
});

test("callbackURL returns to the named canonical /{slug} path (FEN-433)", () => {
  assert.equal(canvasCallbackURL("pixelwar"), "/pixelwar");
  // Stable even when consent fires from a non-canonical path.
  assert.equal(canvasCallbackURL("pixelwar", "/canvas"), "/pixelwar");
  // Slug is URL-encoded so unusual slugs survive the redirect.
  assert.equal(canvasCallbackURL("été 2026"), `/${encodeURIComponent("été 2026")}`);
});

test("callbackURL for the default canvas returns to the current path", () => {
  assert.equal(canvasCallbackURL(null, "/"), "/");
  assert.equal(canvasCallbackURL(null, "/canvas"), "/canvas");
  assert.equal(canvasCallbackURL("", "/canvas"), "/canvas");
  assert.equal(canvasCallbackURL(undefined), "/"); // default fallback
});

test("cancellation is non-punitive: a consent decision is inert until acted on", () => {
  // gateInteraction only describes intent; it performs no redirect and mutates
  // nothing. Re-evaluating after an abandoned consent yields the same decision,
  // so the anonymous viewer is never penalised for backing out.
  const first = gateInteraction("stage-cell", false, { slug: "pixelwar" });
  const second = gateInteraction("stage-cell", false, { slug: "pixelwar" });
  assert.deepEqual(first, second);
  assert.equal(first.kind, "consent");
});
