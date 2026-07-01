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
export const MAX_SCALE = 96; // device px per cell when fully zoomed in (FEN-383 zoom-in extension)
// Minimum zoom expressed as a fraction of the "fit whole board" scale.
// At 0.15× the board occupies ~15% of the shorter viewport dimension —
// visibly smaller than the current fit level (AC1: deeper dezoom, FEN-383).
const DEEP_ZOOM_FACTOR = 0.15;

export class ViewTransform {
  scale = 1;
  tx = 0;
  ty = 0;
  minScale = 1;
  /**
   * When true, the renderer's initial centering uses cover mode (fill the
   * viewport so no dead field shows). This flag only drives `coverCenter()`,
   * NOT `fitScale()` — minScale is the DEEP DEZOOM floor (DEEP_ZOOM_FACTOR ×
   * fitScale) so the user can zoom out past fit to a much smaller view (AC1,
   * FEN-383; previously was the contain floor, AC-R2-3/FEN-370).
   */
  cover = false;

  /**
   * Device pixels eaten by a fixed overlay at the bottom (mobile dock panel).
   * Affects `fitScale()` (fit uses visible height) and `clamp()` so the
   * pan range is anchored to the visible area above the dock — the board can
   * be panned off screen but never beyond visH vertically (AC-R2-2, FEN-370).
   */
  private bottomInset = 0;

  /**
   * Device pixels eaten by a fixed overlay at the top (topbar). Affects
   * `fitScale()` and `fit()` so the board is centred in the zone between
   * topbar and dock instead of in the full viewport (FEN-702 F1).
   */
  private topInset = 0;

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

  /** Viewport size changed (resize). Clamps zoom to the deep-dezoom floor (AC1, FEN-383). */
  setViewport(viewW: number, viewH: number): void {
    this.viewW = viewW;
    this.viewH = viewH;
    this.minScale = this.fitScale() * DEEP_ZOOM_FACTOR;
    if (this.scale < this.minScale) this.scale = this.minScale;
    this.clamp();
  }

  /**
   * Update the bottom overlay inset (device px). Affects the fit floor and the
   * pan clamp so every cell is reachable in the visible viewport above the dock.
   * Call after the dock resizes or its open/closed state changes (FEN-370).
   */
  setBottomInset(px: number): void {
    this.bottomInset = Math.max(0, px);
    this.minScale = this.fitScale() * DEEP_ZOOM_FACTOR;
    if (this.scale < this.minScale) this.scale = this.minScale;
    this.clamp();
  }

  /**
   * Update the top overlay inset (device px). Affects the fit zone so the board
   * is centred between topbar and dock (FEN-702 F1). Does not reset the current
   * view (mirrors setBottomInset behaviour).
   */
  setTopInset(px: number): void {
    this.topInset = Math.max(0, px);
    this.minScale = this.fitScale() * DEEP_ZOOM_FACTOR;
    if (this.scale < this.minScale) this.scale = this.minScale;
    this.clamp();
  }

  /** The "visible" height: total viewport minus the bottom panel inset. */
  private get visH(): number {
    return this.viewH - this.bottomInset;
  }

  /**
   * Available height between topbar and dock — the zone fit() targets so the
   * whole fresco is visible without being covered by either overlay (FEN-702 F1).
   */
  private get availH(): number {
    return Math.max(0, this.visH - this.topInset);
  }

  /**
   * Contain (fit-to-screen) scale: the whole board fits in the AVAILABLE zone
   * (viewport − topInset − bottomInset). Always uses Math.min regardless of cover
   * mode so the user can zoom out to see the full fresco (AC-R2-3, FEN-370).
   * Updated to account for topbar height (FEN-702 F1).
   */
  private fitScale(): number {
    if (!this.width || !this.height || !this.viewW || !this.viewH) return 1;
    return Math.min(this.viewW / this.width, Math.max(1, this.availH) / this.height) * FIT_MARGIN;
  }

  /**
   * Fit the whole board in the available zone (viewport − topInset − bottomInset),
   * centred within that zone. This is the "see the whole fresco" action driven by
   * the ⊡ zoom control (AC-R2-3). Scale is set to fitScale (contain); minScale
   * floor drops to DEEP_ZOOM_FACTOR × fit so the user can keep zooming out past
   * fit (AC1, FEN-383). Centres in the visible zone between topbar and dock so no
   * large chrome-overlap gap appears at the top (FEN-702 F1 D3).
   */
  fit(): void {
    const fs = this.fitScale();
    this.minScale = fs * DEEP_ZOOM_FACTOR;
    this.scale = fs;
    const ch = this.height * this.scale;
    this.tx = (this.viewW - this.width * this.scale) / 2;
    // Centre the board in the available zone (between topbar and dock).
    this.ty = this.topInset + Math.max(0, (this.availH - ch) / 2);
  }

  /**
   * Initial cover centering: scale the board so it fills the full viewport
   * (Math.max, no dead-field margin), then centre it. Used for the mobile
   * "canvas-roi" first-load impression (B1). The minScale floor is the DEEP
   * DEZOOM floor (DEEP_ZOOM_FACTOR × fitScale), so the user can zoom out past
   * the cover starting scale all the way to the tiny-board minimum (AC-R2-3 +
   * AC1/FEN-383). Call `recenter()` first, which calls this for cover mode.
   */
  coverCenter(): void {
    const fs = this.fitScale();
    this.minScale = fs * DEEP_ZOOM_FACTOR; // deep floor — user can zoom out past fit (AC1)
    const coverScale = Math.max(this.viewW / this.width, this.viewH / this.height);
    this.scale = Math.max(coverScale, this.minScale);
    this.tx = (this.viewW - this.width * this.scale) / 2;
    this.ty = (this.viewH - this.height * this.scale) / 2;
    this.clamp();
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

  /**
   * Bound pan so the board can be dragged at most one full board-width past each
   * viewport edge — i.e. the board can go completely off screen in any direction
   * (AC2, FEN-383). The hard limit prevents infinite scroll while still letting
   * the user "push" the canvas out of view and recover with ⊡ fit-to-screen.
   */
  clamp(): void {
    const cw = this.width * this.scale;
    const ch = this.height * this.scale;
    // Board left edge allowed to reach the viewport right edge (off to the right)
    // and board right edge allowed to reach the viewport left edge (off to the left).
    this.tx = clamp(this.tx, -cw, this.viewW);
    // Same logic vertically, respecting the visible height above the bottom panel.
    this.ty = clamp(this.ty, -ch, this.visH);
  }

  /** Device pixel -> integer cell, or null if outside the board. */
  cellAt(deviceX: number, deviceY: number): Cell | null {
    const x = Math.floor((deviceX - this.tx) / this.scale);
    const y = Math.floor((deviceY - this.ty) / this.scale);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    return { x, y };
  }

  /**
   * True when scale is at the "fit whole board" level (fitScale). Drives the ⊡
   * active indicator: pressing ⊡ has no effect only when the board already fills
   * the visible viewport. At the deep dezoom floor the ⊡ is inactive so clicking
   * it zooms back to the contain level (FEN-383 AC1: fit ≠ zoom floor any more).
   */
  get atFit(): boolean {
    return Math.abs(this.scale - this.fitScale()) < 1e-6;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
