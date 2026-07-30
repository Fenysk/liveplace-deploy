/**
 * Tests for the modPreview pure-logic module (FEN-2156 E3-B).
 *   node --experimental-transform-types --test apps/web/src/features/canvas/modPreview.test.ts
 *
 * Covers: computeCanvasDims (dimensioning + cap), pickCountKey (singular/plural),
 * pickEmptyKey (action→AC-F6/F7 key), and catalog parity for all preview keys.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeCanvasDims,
  pickCountKey,
  pickEmptyKey,
  PREVIEW_MAX_PX,
} from "./modPreview.ts";
import { en } from "../../../../../packages/i18n/src/messages/en.ts";
import { fr } from "../../../../../packages/i18n/src/messages/fr.ts";

// ── computeCanvasDims ──────────────────────────────────────────────────────────

test("1×1 bbox → bitmap 1×1, display PREVIEW_MAX_PX × PREVIEW_MAX_PX", () => {
  const d = computeCanvasDims({ minX: 5, minY: 7, maxX: 5, maxY: 7 });
  assert.equal(d.bitmapW, 1);
  assert.equal(d.bitmapH, 1);
  assert.equal(d.displayW, PREVIEW_MAX_PX);
  assert.equal(d.displayH, PREVIEW_MAX_PX);
});

test("48×48 bbox → integer scale 2, display 96×96", () => {
  const d = computeCanvasDims({ minX: 0, minY: 0, maxX: 47, maxY: 47 });
  assert.equal(d.bitmapW, 48);
  assert.equal(d.bitmapH, 48);
  assert.equal(d.displayW, 96);
  assert.equal(d.displayH, 96);
});

test("96×96 bbox → scale 1, display 96×96", () => {
  const d = computeCanvasDims({ minX: 0, minY: 0, maxX: 95, maxY: 95 });
  assert.equal(d.bitmapW, 96);
  assert.equal(d.bitmapH, 96);
  assert.equal(d.displayW, 96);
  assert.equal(d.displayH, 96);
});

test("200×100 bbox → downscale, both display dims ≤ PREVIEW_MAX_PX", () => {
  const d = computeCanvasDims({ minX: 0, minY: 0, maxX: 199, maxY: 99 });
  assert.equal(d.bitmapW, 200);
  assert.equal(d.bitmapH, 100);
  assert.ok(d.displayW <= PREVIEW_MAX_PX, "displayW capped");
  assert.ok(d.displayH <= PREVIEW_MAX_PX, "displayH capped");
});

test("non-square 10×5 bbox → wider display than tall", () => {
  const d = computeCanvasDims({ minX: 0, minY: 0, maxX: 9, maxY: 4 });
  assert.equal(d.bitmapW, 10);
  assert.equal(d.bitmapH, 5);
  assert.ok(d.displayW > d.displayH, "landscape bbox → landscape display");
});

test("non-square 3×12 bbox → taller display than wide", () => {
  const d = computeCanvasDims({ minX: 0, minY: 0, maxX: 2, maxY: 11 });
  assert.equal(d.bitmapW, 3);
  assert.equal(d.bitmapH, 12);
  assert.ok(d.displayH > d.displayW, "portrait bbox → portrait display");
});

test("offset bbox produces same dims as origin-anchored equivalent", () => {
  const a = computeCanvasDims({ minX: 0, minY: 0, maxX: 9, maxY: 4 });
  const b = computeCanvasDims({ minX: 50, minY: 30, maxX: 59, maxY: 34 });
  assert.deepEqual(a, b);
});

// ── pickCountKey ────────────────────────────────────────────────────────────────

test("pickCountKey(1) → singular key (AC-F3)", () => {
  assert.equal(pickCountKey(1), "canvas.mod.preview.count.one");
});

test("pickCountKey(0) → plural key", () => {
  assert.equal(pickCountKey(0), "canvas.mod.preview.count");
});

test("pickCountKey(2) → plural key", () => {
  assert.equal(pickCountKey(2), "canvas.mod.preview.count");
});

test("pickCountKey(4096) → plural key", () => {
  assert.equal(pickCountKey(4096), "canvas.mod.preview.count");
});

// ── pickEmptyKey ────────────────────────────────────────────────────────────────

test("pickEmptyKey(deleteGroup) → AC-F6 key", () => {
  assert.equal(pickEmptyKey("deleteGroup"), "canvas.mod.preview.emptyDelete");
});

test("pickEmptyKey(ban) → AC-F7 key", () => {
  assert.equal(pickEmptyKey("ban"), "canvas.mod.preview.emptyBan");
});

// ── Catalog parity — every preview key exists in both EN and FR ────────────────

const PREVIEW_KEYS = [
  "canvas.mod.preview.count",
  "canvas.mod.preview.count.one",
  "canvas.mod.preview.emptyDelete",
  "canvas.mod.preview.emptyBan",
  "canvas.mod.preview.unavailable",
  "canvas.mod.preview.loading",
] as const;

for (const key of PREVIEW_KEYS) {
  test(`"${key}" exists in EN catalog`, () => {
    assert.ok(key in en, `missing key in EN: ${key}`);
  });
  test(`"${key}" exists in FR catalog`, () => {
    assert.ok(key in fr, `missing key in FR: ${key}`);
  });
  test(`"${key}" is a non-empty string in EN`, () => {
    assert.ok(en[key].length > 0);
  });
  test(`"${key}" is a non-empty string in FR`, () => {
    assert.ok(fr[key].length > 0);
  });
}
