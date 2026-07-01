/**
 * BottomSheet pure-logic tests (FEN-1330 / FEN-1336 S0).
 *
 * Le runner Node.js (`node --experimental-transform-types --test`) ne supporte
 * pas JSX ni jsdom. Les tests de rendu React (montage poignée, Escape, focus-trap,
 * prefers-reduced-motion CSS) sont couverts par le stream T (QA navigateur).
 *
 * Divergences documentées (DoD §4) :
 *   1. Fichier .test.ts (non .test.tsx) : le glob runner est `src/**\/*.test.ts`
 *      et --experimental-transform-types ne compile pas JSX.
 *   2. Les helpers testés vivent dans bottomSheetHelpers.ts (CSS-free) plutôt
 *      que dans BottomSheet.tsx qui importe du CSS (incompatible avec Node).
 *   3. Tests de rendu (modal backdrop, Escape key, focus-trap cycle) → Stream T.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveShowHandle,
  resolveDragDismiss,
  shouldDismissOnDrag,
} from "./bottomSheetHelpers.ts";

// ── resolveShowHandle ─────────────────────────────────────────────────────
// AC2 : poignée commune, visibilité conditionnelle homogène.

test("resolveShowHandle: modal par défaut → showHandle=true", () => {
  assert.equal(resolveShowHandle(undefined, "modal"), true);
});

test("resolveShowHandle: modeless par défaut → showHandle=false", () => {
  assert.equal(resolveShowHandle(undefined, "modeless"), false);
});

test("resolveShowHandle: prop explicite true en modeless → true", () => {
  assert.equal(resolveShowHandle(true, "modeless"), true);
});

test("resolveShowHandle: prop explicite false en modal → false", () => {
  assert.equal(resolveShowHandle(false, "modal"), false);
});

// ── resolveDragDismiss ────────────────────────────────────────────────────
// AC3 : drag-dismiss actif par défaut quand showHandle l'est.

test("resolveDragDismiss: défaut suit showHandle=true", () => {
  assert.equal(resolveDragDismiss(undefined, true), true);
});

test("resolveDragDismiss: défaut suit showHandle=false", () => {
  assert.equal(resolveDragDismiss(undefined, false), false);
});

test("resolveDragDismiss: prop explicite false même si showHandle=true", () => {
  assert.equal(resolveDragDismiss(false, true), false);
});

test("resolveDragDismiss: prop explicite true même si showHandle=false", () => {
  assert.equal(resolveDragDismiss(true, false), true);
});

// ── shouldDismissOnDrag ───────────────────────────────────────────────────
// AC3 : seuil proportionnel (plus de seuil px fixe de S).

test("shouldDismissOnDrag: dy > 25% hauteur → ferme", () => {
  assert.equal(shouldDismissOnDrag(51, 200, 0.25), true);
});

test("shouldDismissOnDrag: dy = 25% exactement → NE ferme PAS (strictement supérieur)", () => {
  assert.equal(shouldDismissOnDrag(50, 200, 0.25), false);
});

test("shouldDismissOnDrag: dy < 25% hauteur → NE ferme PAS", () => {
  assert.equal(shouldDismissOnDrag(49, 200, 0.25), false);
});

test("shouldDismissOnDrag: threshold par défaut = 0.25 (valeur de R, --dock-snap-ratio)", () => {
  const height = 400;
  assert.equal(shouldDismissOnDrag(height * 0.25 + 1, height), true);
  assert.equal(shouldDismissOnDrag(height * 0.25 - 1, height), false);
});

test("shouldDismissOnDrag: dismissThreshold personnalisé (prop)", () => {
  assert.equal(shouldDismissOnDrag(101, 200, 0.5), true);
  assert.equal(shouldDismissOnDrag(99, 200, 0.5), false);
});

test("shouldDismissOnDrag: drag vers le haut (dy ≤ 0) → jamais de fermeture", () => {
  assert.equal(shouldDismissOnDrag(0, 200, 0.25), false);
  assert.equal(shouldDismissOnDrag(-10, 200, 0.25), false);
});

test("shouldDismissOnDrag: hauteur zéro (edge case) → false par convention", () => {
  // 0 > 0 * 0.25 = 0 → false
  assert.equal(shouldDismissOnDrag(0, 0, 0.25), false);
});
