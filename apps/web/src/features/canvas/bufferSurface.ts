/**
 * A plain {@link PlacementSurface} over a row-major `Uint8Array` of palette
 * indices — the same pixel-buffer contract the {@link CanvasRenderer} exposes
 * (`getPixel`/`setPixel`), minus the DOM/canvas rasterisation.
 *
 * It exists so the F4 optimism/rollback flow can be exercised — and rendered to
 * an image — in a headless Node context (unit tests + the visual-capture
 * harness, FEN-65), proving the pose→ack→rollback semantics on the exact buffer
 * the live renderer mutates.
 */
import type { PlacementSurface } from "./placement.js";

export class BufferSurface implements PlacementSurface {
  readonly pixels: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    fill = 0,
  ) {
    this.pixels = new Uint8Array(width * height).fill(fill);
  }

  getPixel(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.pixels[y * this.width + x] ?? 0;
  }

  setPixel(x: number, y: number, color: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.pixels[y * this.width + x] = color;
  }
}
