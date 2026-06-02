/**
 * Pure 2D view transform for the canvas: maps board cells <-> device pixels via a
 * uniform scale + translation. Kept DOM-free so the zoom/pan math (the fiddly,
 * correctness-critical part of FEN-16 CA3) is unit-testable without a browser.
 *
 *   devicePx = cell * scale + t      cell = (devicePx - t) / scale
 */
export interface Cell {
  x: number;
  y: number;
}

const FIT_MARGIN = 0.98; // leave a sliver of border when fitting
const MAX_SCALE = 48; // device px per cell when fully zoomed in

export class ViewTransform {
  scale = 1;
  tx = 0;
  ty = 0;
  minScale = 1;

  constructor(
    public width = 0,
    public height = 0,
    public viewW = 0,
    public viewH = 0,
  ) {}

  /** Board dimensions changed (new snapshot). */
  setBoard(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  /** Viewport size changed (resize). Refits if the current zoom is now too small. */
  setViewport(viewW: number, viewH: number): void {
    this.viewW = viewW;
    this.viewH = viewH;
    this.minScale = this.fitScale();
    if (this.scale < this.minScale) this.fit();
    else this.clamp();
  }

  private fitScale(): number {
    if (!this.width || !this.height || !this.viewW || !this.viewH) return 1;
    return Math.min(this.viewW / this.width, this.viewH / this.height) * FIT_MARGIN;
  }

  /** Fit the whole board in the viewport, centred. */
  fit(): void {
    this.minScale = this.fitScale();
    this.scale = this.minScale;
    this.tx = (this.viewW - this.width * this.scale) / 2;
    this.ty = (this.viewH - this.height * this.scale) / 2;
  }

  /**
   * Frame a sub-region of the board (OBS `cadrage`): scale so the region fills the
   * viewport and centre it. The region is clamped to the board; an empty/degenerate
   * region falls back to fitting the whole board.
   */
  fitRegion(x: number, y: number, w: number, h: number): void {
    if (!this.viewW || !this.viewH || w <= 0 || h <= 0) return this.fit();
    const rx = clamp(x, 0, this.width);
    const ry = clamp(y, 0, this.height);
    const rw = clamp(w, 1, this.width - rx);
    const rh = clamp(h, 1, this.height - ry);
    this.minScale = this.fitScale();
    this.scale = Math.min(this.viewW / rw, this.viewH / rh) * FIT_MARGIN;
    // centre the region's midpoint in the viewport
    this.tx = this.viewW / 2 - (rx + rw / 2) * this.scale;
    this.ty = this.viewH / 2 - (ry + rh / 2) * this.scale;
  }

  /**
   * Fix a zoom level (OBS `zoom`, device px per cell) and centre the board.
   * The fit scale stays the floor so a too-small zoom never leaves gaps.
   */
  setFixedScale(scale: number): void {
    this.minScale = this.fitScale();
    this.scale = Math.max(scale, this.minScale);
    this.tx = (this.viewW - this.width * this.scale) / 2;
    this.ty = (this.viewH - this.height * this.scale) / 2;
    this.clamp();
  }

  /** Zoom by `factor` while keeping the board point under (deviceX,deviceY) fixed. */
  zoomAt(deviceX: number, deviceY: number, factor: number): void {
    const next = clamp(this.scale * factor, this.minScale, MAX_SCALE);
    if (next === this.scale) return;
    const cellX = (deviceX - this.tx) / this.scale;
    const cellY = (deviceY - this.ty) / this.scale;
    this.scale = next;
    this.tx = deviceX - cellX * this.scale;
    this.ty = deviceY - cellY * this.scale;
    this.clamp();
  }

  /** Pan by a device-pixel delta. */
  panBy(dx: number, dy: number): void {
    this.tx += dx;
    this.ty += dy;
    this.clamp();
  }

  /** Keep the board from being dragged entirely out of view (centre if it fits). */
  clamp(): void {
    const cw = this.width * this.scale;
    const ch = this.height * this.scale;
    this.tx = cw <= this.viewW ? (this.viewW - cw) / 2 : clamp(this.tx, this.viewW - cw, 0);
    this.ty = ch <= this.viewH ? (this.viewH - ch) / 2 : clamp(this.ty, this.viewH - ch, 0);
  }

  /** Device pixel -> integer cell, or null if outside the board. */
  cellAt(deviceX: number, deviceY: number): Cell | null {
    const x = Math.floor((deviceX - this.tx) / this.scale);
    const y = Math.floor((deviceY - this.ty) / this.scale);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    return { x, y };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
