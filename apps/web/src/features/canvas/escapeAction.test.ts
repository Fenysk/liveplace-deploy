/**
 * Tests for escapeAction — the priority chain for the global Escape key (S2 / FEN-1731).
 * Cheat-sheet Escape is delegated to BottomSheet's useFocusTrap (FEN-1749).
 *   node --test apps/web/src/features/canvas/escapeAction.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeAction } from "./escapeAction.ts";

const cell = { x: 3, y: 7 };

test("inspect non-null → closeInspect (highest priority)", () => {
  assert.equal(escapeAction({ inspect: cell, drawing: true }), "closeInspect");
});

test("drawing, no inspect → cancel", () => {
  assert.equal(escapeAction({ inspect: null, drawing: true }), "cancel");
});

test("idle (no active mode) → null", () => {
  assert.equal(escapeAction({ inspect: null, drawing: false }), null);
});
