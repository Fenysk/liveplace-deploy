/**
 * Gallery thumbnail rendering (F12 / FEN-33, ADR-0001/ADR-0006). Off the hot
 * path: the human-facing preview is a *derived* artifact built from the same
 * `OP_SNAPSHOT` blob the worker just wrote durably (`@canvas/protocol`), never
 * produced during a pixel placement (G-Perf3). Everything here is
 * pure/deterministic except the upload+record seam, so the rendering is unit
 * testable on a realistic canvas without touching Redis/Convex.
 *
 * Dependency note: PNG is encoded with Node's built-in `node:zlib` (zero new
 * dependencies) rather than a heavy image lib like `sharp`. Truecolor (RGB,
 * 8-bit) PNG is trivial to emit and is plenty for a ~256px preview.
 */
import { deflateSync } from "node:zlib";
import { decodeSnapshot, PALETTE, type DecodedSnapshot } from "@canvas/protocol";
import type { ConvexDurable } from "./convex.js";

export interface ThumbnailImage {
  buffer: Uint8Array;
  format: "png";
  width: number;
  height: number;
}

/**
 * Target dimensions for a thumbnail whose long side is at most `maxLong`,
 * preserving aspect ratio. Never upscales (a small canvas is returned as-is) and
 * never collapses an axis below 1px.
 */
export function thumbnailDimensions(
  width: number,
  height: number,
  maxLong: number,
): { width: number; height: number } {
  const longSide = Math.max(width, height);
  if (maxLong <= 0 || longSide <= maxLong) return { width, height };
  const scale = maxLong / longSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Box-average downscale of a palette-indexed snapshot into a packed RGB buffer
 * (row-major, 3 bytes/pixel) at the given target size. Averaging source blocks
 * gives a smoother preview than nearest-neighbour for pixel-art canvases; the
 * result is a derived image, so non-palette intermediate colors are fine.
 * Palette indices map via the shared `@canvas/protocol` PALETTE (RGBA tuples).
 */
export function renderRgb(
  snap: DecodedSnapshot,
  target: { width: number; height: number },
): Uint8Array {
  const out = new Uint8Array(target.width * target.height * 3);
  for (let ty = 0; ty < target.height; ty++) {
    const sy0 = Math.floor((ty * snap.height) / target.height);
    const sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) * snap.height) / target.height));
    for (let tx = 0; tx < target.width; tx++) {
      const sx0 = Math.floor((tx * snap.width) / target.width);
      const sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) * snap.width) / target.width));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const row = sy * snap.width;
        for (let sx = sx0; sx < sx1; sx++) {
          const c = PALETTE[snap.pixels[row + sx]!] ?? PALETTE[0]!;
          r += c[0];
          g += c[1];
          b += c[2];
          n++;
        }
      }
      const o = (ty * target.width + tx) * 3;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return out;
}

// --- minimal truecolor PNG encoder (no deps) ----------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

/** Encode a packed RGB buffer as an 8-bit truecolor PNG. */
export function encodePng(rgb: Uint8Array, width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const idv = new DataView(ihdr.buffer);
  idv.setUint32(0, width, false);
  idv.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  // 10..12 = compression / filter / interlace = 0

  // raw scanlines: one filter byte (0 = None) per row, then RGB bytes
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw);

  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Copy a (possibly offset / shared-backed) Uint8Array into a fresh ArrayBuffer. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

/**
 * Decode an `OP_SNAPSHOT` blob and render a downscaled PNG preview whose long
 * side is at most `maxLong`. Pure: same bytes in → same PNG out.
 */
export function renderThumbnail(snapshotBytes: Uint8Array, maxLong: number): ThumbnailImage {
  const snap = decodeSnapshot(toArrayBuffer(snapshotBytes));
  const dims = thumbnailDimensions(snap.width, snap.height, maxLong);
  const rgb = renderRgb(snap, dims);
  return {
    buffer: encodePng(rgb, dims.width, dims.height),
    format: "png",
    width: dims.width,
    height: dims.height,
  };
}

/**
 * Render the gallery thumbnail for an already-built snapshot blob and point the
 * F2 canvas row at it (FEN-33). Reusing the snapshot bytes the worker just
 * produced avoids a second Redis read and keeps the thumbnail's version aligned
 * with the snapshot's. Idempotent + monotonic server-side. Returns the rendered
 * dimensions, or null when there was nothing to render (empty blob).
 */
export async function buildAndRecordThumbnail(
  convex: ConvexDurable,
  slug: string,
  version: number,
  snapshotBytes: Uint8Array,
  maxLong: number,
): Promise<{ width: number; height: number } | null> {
  if (snapshotBytes.byteLength === 0) return null;
  const img = renderThumbnail(snapshotBytes, maxLong);
  await convex.recordGalleryThumbnail(slug, version, img);
  return { width: img.width, height: img.height };
}
