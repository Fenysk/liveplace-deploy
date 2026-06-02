/**
 * Canvas 2D renderer with zoom / pan — the F3 display half of the canvas client
 * (FEN-65), ported from the FE-worktree FEN-16 renderer and re-pointed at the
 * FROZEN `@canvas/protocol` (binary snapshot/delta, fixed palette-indexed pixels).
 *
 * Architecture: the palette-indexed board is rasterised once into an offscreen
 * canvas at native (1 cell = 1 px) resolution. Every frame the visible canvas is
 * cleared and the offscreen image is blitted through a single affine transform
 * (scale + translate, nearest-neighbour). This makes:
 *   - snapshot load     O(width*height) once (CA1: one snapshot, no per-pixel fetch),
 *   - a live delta       O(1) — one cell written to the offscreen image (CA2),
 *   - zoom/pan           one GPU-friendly drawImage per frame (CA3: ≥50 FPS @ 512²),
 * independent of board size. Redraws are coalesced into a single rAF tick via a
 * dirty flag, so a burst of deltas in one frame paints once. All view math lives
 * in the DOM-free, unit-tested {@link ViewTransform}.
 *
 * The renderer is also the F4 {@link PlacementSurface}: `colorAt` is `getPixel`
 * and `setPixel` is `setPixel`, so {@link OptimisticPlacement} paints optimistic
 * poses straight onto the offscreen buffer and rolls them back in O(1).
 *
 * Difference from the old `@liveplace/protocol` renderer: the palette is no
 * longer carried per-snapshot — it is the fixed 32-colour `PALETTE` contract
 * (ADR-0002 / D2). Geometry (width/height) is still read from the snapshot frame.
 */
import {
  PALETTE,
  PALETTE_SIZE,
  binaryOpcode,
  decodeDelta,
  decodeSnapshot,
  OP_DELTA,
  OP_SNAPSHOT,
  type DecodedSnapshot,
} from "@canvas/protocol";
import { ViewTransform } from "./view.js";

export interface RendererHooks {
  /** A genuine click (no drag) on cell (x,y). Not fired in non-interactive mode. */
  onPlace?: (x: number, y: number) => void;
  /**
   * Pointer is hovering cell (x,y) at viewport-relative client coords, or null
   * when the pointer leaves the canvas / is panning. Drives the pixel readout.
   */
  onHover?: (cell: { x: number; y: number } | null, clientX: number, clientY: number) => void;
}

export interface RendererOptions {
  /** Wire pointer input (pan/zoom/click). Off for the read-only OBS view (CA3). */
  interactive?: boolean;
  /**
   * Solid background colour, or null for a transparent canvas (OBS default, CA1).
   * The interactive app passes the dark app background.
   */
  background?: string | null;
  /** Draw a 1px grid between cells once zoomed in enough (OBS `grid`). */
  grid?: boolean;
  /** Fixed device-independent px per cell (OBS `zoom`); null fits the board. */
  zoom?: number | null;
  /** Frame a sub-region of the board instead of fitting it all (OBS `cadrage`). */
  crop?: { x: number; y: number; w: number; h: number } | null;
}

const APP_BACKGROUND = "#0a0a0a"; // interactive-view backdrop
const GRID_MIN_SCALE = 4; // device px/cell below which a grid is just moiré
const GRID_STYLE = "rgba(0,0,0,0.28)";

const DRAG_THRESHOLD_PX = 4; // movement beyond this turns a click into a pan

/** The fixed palette as CSS hex strings, for the swatch UI (computed once). */
export const PALETTE_HEX: readonly string[] = PALETTE.map(
  ([r, g, b]) => `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`,
);

/** Pack a palette RGBA tuple little-endian for a Uint32 ImageData view. */
function packRgba([r, g, b, a]: readonly [number, number, number, number]): number {
  return ((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff);
}

/** Palette index -> packed little-endian RGBA (fixed contract, computed once). */
const PALETTE_RGBA = new Uint32Array(PALETTE.map((c) => packRgba(c)));

export class CanvasRenderer {
  private width = 0;
  private height = 0;
  private pixels: Uint8Array = new Uint8Array(0); // palette index per cell (row-major)
  private image?: ImageData;
  private imageView?: Uint32Array;
  private snapshotSeq = -1; // highest write seq reflected by the current buffer

  private readonly offscreen: HTMLCanvasElement;
  private readonly octx: CanvasRenderingContext2D;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly view = new ViewTransform();

  private dpr = 1;
  private dirty = false;
  private raf = 0;
  private loaded = false;

  // pointer interaction state
  private pointerId: number | null = null;
  private dragging = false;
  private moved = false;
  private lastX = 0;
  private lastY = 0;
  private readonly resizeObserver: ResizeObserver;

  private readonly interactive: boolean;
  private readonly background: string | null;
  private readonly grid: boolean;
  private readonly zoom: number | null;
  private readonly crop: { x: number; y: number; w: number; h: number } | null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly hooks: RendererHooks = {},
    opts: RendererOptions = {},
  ) {
    this.interactive = opts.interactive ?? true;
    // Default backdrop differs by view: dark for the app, transparent for OBS.
    this.background = opts.background === undefined ? APP_BACKGROUND : opts.background;
    this.grid = opts.grid ?? false;
    this.zoom = opts.zoom ?? null;
    this.crop = opts.crop ?? null;

    // A transparent backdrop needs an alpha context so OBS can composite the
    // canvas over the streamer's scene (CA1).
    const ctx = canvas.getContext("2d", { alpha: this.background === null });
    if (!ctx) throw new Error("no 2d context");
    this.ctx = ctx;

    this.offscreen = document.createElement("canvas");
    const octx = this.offscreen.getContext("2d", { willReadFrequently: true });
    if (!octx) throw new Error("no offscreen 2d context");
    this.octx = octx;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();

    if (this.interactive) this.bindInput();

    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      if (this.dirty) this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    if (this.interactive) this.unbindInput();
  }

  // --- binary frame routing -------------------------------------------------

  /**
   * Route an incoming binary frame (snapshot 0x01 / delta 0x02) to the renderer.
   * Returns the highest write `seq` now reflected by the buffer, for the net
   * client's resync cursor; -1 if the frame was ignored.
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
    this.applySnapshot(snap);
    return snap.seq;
  }

  private applySnapshot(snap: DecodedSnapshot): void {
    this.width = snap.width;
    this.height = snap.height;
    this.pixels = snap.pixels;
    this.snapshotSeq = snap.seq;

    this.offscreen.width = this.width;
    this.offscreen.height = this.height;

    this.image = this.octx.createImageData(this.width, this.height);
    this.imageView = new Uint32Array(this.image.data.buffer);
    for (let i = 0; i < this.pixels.length; i++) {
      this.imageView[i] = PALETTE_RGBA[this.pixels[i]!] ?? PALETTE_RGBA[0]!;
    }
    this.octx.putImageData(this.image, 0, 0);

    this.loaded = true;
    this.view.setBoard(this.width, this.height);
    this.recenter();
  }

  /**
   * Apply a coalesced delta batch (CA2). Each write is O(1) on the offscreen
   * buffer. Returns the batch's highest write seq; ignores a stale batch whose
   * seq the buffer already reflects so a snapshot↔stream overlap never regresses.
   */
  applyDelta(buf: ArrayBuffer): number {
    const delta = decodeDelta(buf);
    if (!this.loaded || delta.seq <= this.snapshotSeq) return this.snapshotSeq;
    for (const w of delta.writes) this.setPixel(w.x, w.y, w.color);
    this.snapshotSeq = delta.seq;
    return delta.seq;
  }

  /** Highest write seq reflected by the buffer (resync cursor). */
  get appliedSeq(): number {
    return this.snapshotSeq;
  }

  // --- PlacementSurface (F4) ------------------------------------------------

  /** Write one cell in O(1) and coalesce the repaint (also the F4 setPixel sink). */
  setPixel(x: number, y: number, color: number): void {
    if (!this.image || !this.imageView) return;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const idx = y * this.width + x;
    this.pixels[idx] = color;
    this.imageView[idx] = PALETTE_RGBA[color] ?? PALETTE_RGBA[0]!;
    // copy just the touched cell from the backing ImageData into the offscreen
    this.octx.putImageData(this.image, 0, 0, x, y, 1, 1);
    this.dirty = true;
  }

  /** Palette index currently at a cell, or 0 (empty) if unloaded / out of bounds. */
  getPixel(x: number, y: number): number {
    if (!this.loaded || x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.pixels[y * this.width + x] ?? 0;
  }

  /** Palette index at a cell, or -1 if unloaded / out of bounds (UI readout). */
  colorAt(x: number, y: number): number {
    if (!this.loaded || x < 0 || y < 0 || x >= this.width || y >= this.height) return -1;
    return this.pixels[y * this.width + x] ?? -1;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  get boardWidth(): number {
    return this.width;
  }

  get boardHeight(): number {
    return this.height;
  }

  get paletteSize(): number {
    return PALETTE_SIZE;
  }

  // --- view control ---------------------------------------------------------

  recenter(): void {
    if (!this.loaded) return;
    if (this.crop) this.view.fitRegion(this.crop.x, this.crop.y, this.crop.w, this.crop.h);
    else if (this.zoom) this.view.setFixedScale(this.zoom * this.dpr);
    else this.view.fit();
    this.dirty = true;
  }

  /** Map viewport-relative client coords to an integer cell, or null if outside. */
  toCell(clientX: number, clientY: number): { x: number; y: number } | null {
    if (!this.loaded) return null;
    const rect = this.canvas.getBoundingClientRect();
    return this.view.cellAt((clientX - rect.left) * this.dpr, (clientY - rect.top) * this.dpr);
  }

  private resize(): void {
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * this.dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * this.dpr));
    if (w === this.canvas.width && h === this.canvas.height) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.view.setViewport(w, h);
    this.dirty = true;
  }

  private draw(): void {
    this.dirty = false;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.background === null) {
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    } else {
      ctx.fillStyle = this.background;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    if (!this.loaded) return;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(this.view.scale, 0, 0, this.view.scale, this.view.tx, this.view.ty);
    ctx.drawImage(this.offscreen, 0, 0);
    if (this.grid) this.drawGrid();
  }

  private drawGrid(): void {
    const s = this.view.scale;
    if (s < GRID_MIN_SCALE) return;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = 1;
    ctx.strokeStyle = GRID_STYLE;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const x0 = Math.max(0, Math.floor((0 - this.view.tx) / s));
    const x1 = Math.min(this.width, Math.ceil((cw - this.view.tx) / s));
    const y0 = Math.max(0, Math.floor((0 - this.view.ty) / s));
    const y1 = Math.min(this.height, Math.ceil((ch - this.view.ty) / s));
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) {
      const px = Math.round(this.view.tx + x * s) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, ch);
    }
    for (let y = y0; y <= y1; y++) {
      const py = Math.round(this.view.ty + y * s) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(cw, py);
    }
    ctx.stroke();
  }

  // --- input ----------------------------------------------------------------

  private bindInput(): void {
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  private unbindInput(): void {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("wheel", this.onWheel);
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.pointerId = e.pointerId;
    this.dragging = true;
    this.moved = false;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.canvas.setPointerCapture(e.pointerId);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.dragging && e.pointerId === this.pointerId) {
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      if (!this.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) this.moved = true;
      if (this.moved) {
        this.view.panBy(dx * this.dpr, dy * this.dpr);
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.dirty = true;
        this.hooks.onHover?.(null, e.clientX, e.clientY);
      }
      return;
    }
    this.hooks.onHover?.(this.toCell(e.clientX, e.clientY), e.clientX, e.clientY);
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    const wasClick = this.dragging && !this.moved;
    this.dragging = false;
    this.pointerId = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (wasClick) {
      const cell = this.toCell(e.clientX, e.clientY);
      if (cell) this.hooks.onPlace?.(cell.x, cell.y);
    }
  };

  private onPointerLeave = (e: PointerEvent): void => {
    this.hooks.onHover?.(null, e.clientX, e.clientY);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const deviceX = (e.clientX - rect.left) * this.dpr;
    const deviceY = (e.clientY - rect.top) * this.dpr;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.canvas.height : 1;
    const factor = Math.exp((-e.deltaY * unit) / 400);
    this.view.zoomAt(deviceX, deviceY, factor);
    this.dirty = true;
  };
}
