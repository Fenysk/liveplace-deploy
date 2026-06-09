import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeSnapshot } from "@canvas/protocol";
import {
  thumbnailDimensions,
  encodePng,
  renderThumbnail,
} from "../thumbnail.js";

/**
 * Gallery thumbnail rendering (F12 / FEN-33). Pure, deterministic — same bytes
 * in → same PNG out — so it is fully testable without Redis/Convex.
 */

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

test("thumbnailDimensions never upscales a small canvas", () => {
  assert.deepEqual(thumbnailDimensions(100, 80, 256), { width: 100, height: 80 });
});

test("thumbnailDimensions caps the long side, preserving aspect ratio", () => {
  assert.deepEqual(thumbnailDimensions(1000, 500, 256), { width: 256, height: 128 });
});

test("thumbnailDimensions never collapses an axis below 1px", () => {
  const d = thumbnailDimensions(1000, 1, 256);
  assert.equal(d.width, 256);
  assert.equal(d.height, 1);
});

test("thumbnailDimensions: maxLong <= 0 disables scaling", () => {
  assert.deepEqual(thumbnailDimensions(1000, 1000, 0), { width: 1000, height: 1000 });
});

test("encodePng emits a valid PNG signature + IHDR dimensions", () => {
  const rgb = new Uint8Array(2 * 2 * 3); // 2x2 black
  const png = encodePng(rgb, 2, 2);
  assert.deepEqual([...png.subarray(0, 8)], PNG_SIG);
  // IHDR width/height are the first two u32 after the 8-byte sig + 8-byte chunk header.
  const dv = new DataView(png.buffer, png.byteOffset);
  assert.equal(dv.getUint32(16, false), 2, "IHDR width");
  assert.equal(dv.getUint32(20, false), 2, "IHDR height");
});

test("renderThumbnail decodes an OP_SNAPSHOT blob and downscales to a PNG", () => {
  const w = 8;
  const h = 8;
  const pixels = new Uint8Array(w * h);
  for (let i = 0; i < pixels.length; i++) pixels[i] = i % 4; // a few palette indices
  const blob = new Uint8Array(encodeSnapshot(pixels, 7, w, h));

  const img = renderThumbnail(blob, 4);
  assert.equal(img.format, "png");
  assert.equal(img.width, 4);
  assert.equal(img.height, 4);
  assert.deepEqual([...img.buffer.subarray(0, 8)], PNG_SIG);
});

test("renderThumbnail returns the canvas as-is when already within the cap", () => {
  const blob = new Uint8Array(encodeSnapshot(new Uint8Array(4 * 4), 1, 4, 4));
  const img = renderThumbnail(blob, 256);
  assert.equal(img.width, 4);
  assert.equal(img.height, 4);
});
