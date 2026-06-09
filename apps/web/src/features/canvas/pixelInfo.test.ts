/**
 * Tests for the FEN-249 pixel-info view-model — the Definition-of-Done surface
 * for the refonte "clic → infos → Dessiner → Confirmer" pose flow.
 *   node --test apps/web/src/features/canvas/pixelInfo.test.ts
 *
 * Covers the acceptance criteria that live in the pure reducer:
 *   - a painted cell with a resolved placer → coords + author (known)
 *   - a never-posed (empty) cell → coords + "no author", NOT an error (empty)
 *   - an in-flight author lookup → loading; an unloaded canvas → loading
 *   - a resolved-to-nothing lookup (anonymous / backend not wired) → unknown
 *   - the inert author source resolves to null (no client-side guessing)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { derivePixelInfo, inertPixelAuthorSource } from "./pixelInfo.ts";
import { EMPTY_COLOR } from "./selection.ts";

test("painted cell with a resolved placer → known + login + coords", () => {
  const vm = derivePixelInfo({ x: 12, y: 7, color: 5, author: { login: "alice" } });
  assert.equal(vm.x, 12);
  assert.equal(vm.y, 7);
  assert.equal(vm.isEmpty, false);
  assert.equal(vm.authorState, "known");
  assert.equal(vm.authorLogin, "alice");
});

test("empty cell → empty author state, coords kept, never an error", () => {
  const vm = derivePixelInfo({ x: 0, y: 0, color: EMPTY_COLOR, author: null });
  assert.equal(vm.isEmpty, true);
  assert.equal(vm.authorState, "empty");
  assert.equal(vm.authorLogin, null);
  assert.equal(vm.x, 0);
  assert.equal(vm.y, 0);
});

test("empty cell ignores any author value (empty wins)", () => {
  // Defensive: even if a stale author resolves for a now-empty cell, the empty
  // colour is authoritative and we must not show a placer for a blank pixel.
  const vm = derivePixelInfo({ x: 3, y: 4, color: EMPTY_COLOR, author: { login: "ghost" } });
  assert.equal(vm.authorState, "empty");
  assert.equal(vm.authorLogin, null);
});

test("painted cell, author lookup in flight (undefined) → loading", () => {
  const vm = derivePixelInfo({ x: 1, y: 2, color: 9, author: undefined });
  assert.equal(vm.authorState, "loading");
  assert.equal(vm.authorLogin, null);
  assert.equal(vm.isEmpty, false);
});

test("painted cell, lookup resolved to nothing → unknown (no fabrication)", () => {
  const vm = derivePixelInfo({ x: 8, y: 9, color: 2, author: null });
  assert.equal(vm.authorState, "unknown");
  assert.equal(vm.authorLogin, null);
});

test("unloaded canvas (color < 0) → loading regardless of author", () => {
  const vm = derivePixelInfo({ x: 5, y: 5, color: -1, author: { login: "x" } });
  assert.equal(vm.authorState, "loading");
  assert.equal(vm.isEmpty, false);
  assert.equal(vm.authorLogin, null);
});

test("inert author source resolves to null (backend hook pending)", async () => {
  assert.equal(await inertPixelAuthorSource.authorAt(10, 20), null);
});
