/**
 * Tests for eyedropperPick — the one-shot eyedropper helper (S3 — FEN-1732).
 *   node --test apps/web/src/features/canvas/eyedropper.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eyedropperPick } from "./eyedropper.ts";

test("painted cell → returns the palette index", () => {
  assert.equal(eyedropperPick({ x: 3, y: 5 }, () => 7), 7);
});

test("empty cell (colorAt returns 0) → returns null", () => {
  assert.equal(eyedropperPick({ x: 3, y: 5 }, () => 0), null);
});

test("out-of-bounds / unloaded (colorAt returns -1) → returns null", () => {
  assert.equal(eyedropperPick({ x: 99, y: 99 }, () => -1), null);
});

test("null cell (no hover, no cursor) → returns null regardless of colorAt", () => {
  assert.equal(eyedropperPick(null, () => 7), null);
});

test("keyboard-cursor path: cursor roving cell with painted pixel → returns index", () => {
  const grid = new Map<string, number>([["2,4", 3]]);
  const colorAt = (x: number, y: number): number => grid.get(`${x},${y}`) ?? 0;
  assert.equal(eyedropperPick({ x: 2, y: 4 }, colorAt), 3);
});
