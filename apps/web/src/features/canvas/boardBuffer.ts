/**
 * Pure pixel-buffer for the canvas board — zero DOM dependencies.
 *
 * Owns the Uint8 palette-index array (`pixels`) and its Uint32 RGBA mirror
 * (`imageView`) so the renderer can blit both arrays without holding this
 * object's internal state. All binary frame routing lives here so the logic
 * can be exercised in headless Node tests without a canvas context.
 *
 * Architecture notes:
 * - Snapshot load is O(width*height) once (fills pixels + imageView in one pass).
 * - Delta apply is O(writes): each `setPixel` updates one cell in both arrays.
 * - Resize is O(width*height) once: row-copies the old buffer then rebuilds imageView.
 * - `imageView` uses the same packed little-endian RGBA layout as the browser's
 *   `ImageData` (Uint32Array view over the 4-byte-per-pixel data buffer), so the
 *   renderer can copy it directly into an `ImageData` buffer with one `set()` call.
 */
import {
  PALETTE,
  binaryOpcode,
  decodeDelta,
  decodeSnapshot,
  OP_DELTA,
  OP_SNAPSHOT,
  type DecodedSnapshot,
} from "@canvas/protocol";

/** Pack a palette RGBA tuple little-endian for a Uint32 ImageData view. */
function packRgba([r, g, b, a]: readonly [number, number, number, number]): number {
  return ((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff);
}

/** Palette index → packed little-endian RGBA (fixed contract, computed once). */
export const PALETTE_RGBA = new Uint32Array(PALETTE.map((c) => packRgba(c)));

/**
 * Packed RGBA for an empty cell (transparent). Index 0 is rendered transparent
 * so the CSS checkerboard layer shows through (FEN-418 D1).
 */
export const TRANSPARENT = packRgba([0, 0, 0, 0]);

/**
 * Pure pixel-buffer for one canvas board.
 *
 * All fields are intentionally public — this is a value-class whose lifetime is
 * owned entirely by a single {@link CanvasRenderer}. The renderer reads `pixels`
 * and `imageView` directly after mutations (no copy needed for snapshot loads).
 */
export class BoardBuffer {
  width = 0;
  height = 0;
  /** Palette index per cell (row-major). */
  pixels: Uint8Array = new Uint8Array(0);
  /** Packed little-endian RGBA per cell — mirrors `pixels` after every write. */
  imageView: Uint32Array = new Uint32Array(0);
  /** Highest write seq reflected by the buffer (resync cursor). */
  appliedSeq = -1;
  loaded = false;

  /**
   * Route an incoming binary frame (snapshot 0x01 / delta 0x02).
   * Returns the highest write `seq` now reflected by the buffer; -1 if ignored.
   */
  applyBinary(buf: ArrayBuffer): number {
    switch (binaryOpcode(buf)) {
      case OP_SNAPSHOT:
        return this.loadSnapshot(buf);
      case OP_DELTA:
        return this.applyDelta(buf);
      default:
        return -1;
    }
  }

  /** Full snapshot replace. Returns the snapshot's write seq. */
  loadSnapshot(buf: ArrayBuffer): number {
    const snap = decodeSnapshot(buf);
    this._applySnapshot(snap);
    return snap.seq;
  }

  private _applySnapshot(snap: DecodedSnapshot): void {
    this.width = snap.width;
    this.height = snap.height;
    this.pixels = snap.pixels;
    this.appliedSeq = snap.seq;

    this.imageView = new Uint32Array(snap.pixels.length);
    for (let i = 0; i < snap.pixels.length; i++) {
      const ci = snap.pixels[i]!;
      this.imageView[i] = ci === 0 ? TRANSPARENT : (PALETTE_RGBA[ci] ?? PALETTE_RGBA[0]!);
    }

    this.loaded = true;
  }

  /**
   * Apply a coalesced delta batch (CA2). Each write is O(1). Ignores stale
   * batches (seq ≤ appliedSeq) so a snapshot↔stream overlap never regresses.
   *
   * `onWrite` is called for every cell actually written, with the cell's
   * (x, y, linear-index) — the renderer uses this to sync its DOM ImageData
   * in a single targeted `putImageData` per write without re-decoding the frame.
   */
  applyDelta(
    buf: ArrayBuffer,
    onWrite?: (x: number, y: number, idx: number) => void,
  ): number {
    const delta = decodeDelta(buf);
    if (!this.loaded || delta.seq <= this.appliedSeq) return this.appliedSeq;
    for (const w of delta.writes) {
      this.setPixel(w.x, w.y, w.color);
      onWrite?.(w.x, w.y, w.y * this.width + w.x);
    }
    this.appliedSeq = delta.seq;
    return delta.seq;
  }

  /**
   * Handle a `dimsChanged` WS frame (FEN-1790): expand the board to new
   * dimensions, preserving existing pixels, zero-filling new cells.
   */
  resizeTo(newWidth: number, newHeight: number): void {
    if (!this.loaded) return;
    if (newWidth === this.width && newHeight === this.height) return;

    const newPixels = new Uint8Array(newWidth * newHeight);
    const copyW = Math.min(this.width, newWidth);
    const copyH = Math.min(this.height, newHeight);
    for (let row = 0; row < copyH; row++) {
      newPixels.set(
        this.pixels.subarray(row * this.width, row * this.width + copyW),
        row * newWidth,
      );
    }

    this.width = newWidth;
    this.height = newHeight;
    this.pixels = newPixels;

    this.imageView = new Uint32Array(newWidth * newHeight);
    for (let i = 0; i < newPixels.length; i++) {
      const ci = newPixels[i]!;
      this.imageView[i] = ci === 0 ? TRANSPARENT : (PALETTE_RGBA[ci] ?? PALETTE_RGBA[0]!);
    }
  }

  /** Write one cell in O(1): updates `pixels` and the `imageView` RGBA mirror. */
  setPixel(x: number, y: number, color: number): void {
    if (!this.loaded) return;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const idx = y * this.width + x;
    this.pixels[idx] = color;
    this.imageView[idx] = color === 0 ? TRANSPARENT : (PALETTE_RGBA[color] ?? PALETTE_RGBA[0]!);
  }

  /** Palette index at a cell, or 0 (empty) if unloaded / out of bounds. */
  getPixel(x: number, y: number): number {
    if (!this.loaded || x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.pixels[y * this.width + x] ?? 0;
  }

  /** Palette index at a cell, or -1 if unloaded / out of bounds (UI readout). */
  colorAt(x: number, y: number): number {
    if (!this.loaded || x < 0 || y < 0 || x >= this.width || y >= this.height) return -1;
    return this.pixels[y * this.width + x] ?? -1;
  }
}
