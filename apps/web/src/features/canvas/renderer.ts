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
   * A genuine tap/click (no drag, single pointer) on cell (x,y) — the FEN-113
   * batch-selection entry point. `pointerType` is "mouse" | "touch" | "pen" so
   * the UI can gate touch behind an explicit "Dessiner" step while letting a
   * desktop click select directly. A multi-touch pinch never fires this.
   */
  onTap?: (x: number, y: number, pointerType: string) => void;
  /**
   * Pointer is hovering cell (x,y) at viewport-relative client coords, or null
   * when the pointer leaves the canvas / is panning. Drives the pixel readout.
   */
  onHover?: (cell: { x: number; y: number } | null, clientX: number, clientY: number) => void;
  /**
   * Fired (only on change) when the on-screen cell size crosses the comfortable
   * touch-target threshold — `true` means a cell is now smaller than ~24 CSS px,
   * so tapping is imprecise (Fitts) and the UI should nudge the user to zoom in
   * before posing (FEN-124 U5). Not fired in non-interactive (OBS) mode.
   */
  onScaleClass?: (belowTouchTarget: boolean) => void;
  /**
   * Keyboard roving-cursor moved onto cell (x,y) (FEN-123). Distinct from
   * {@link onHover} so the UI can announce the keyboard target (aria-live)
   * without the mouse-hover firehose. The cell is always in-bounds.
   */
  onCursorMove?: (cell: { x: number; y: number }) => void;
  /**
   * Keyboard activate (Enter / Space) on the roving-cursor cell — the keyboard
   * equivalent of a pointer tap. Wired to the SAME stage gesture as the pointer
   * so the three modalities share one BatchSelection (true parity).
   */
  onActivate?: (x: number, y: number) => void;
  /** Keyboard Escape — cancel the staged batch (forgiveness; WCAG no-trap). */
  onCancel?: () => void;
  /** Keyboard validate shortcut (Ctrl/Cmd+Enter) — commit the staged batch. */
  onValidate?: () => void;
}

/** A staged cell drawn as a preview rectangle (FEN-113 selection overlay). */
export interface OverlayCell {
  x: number;
  y: number;
  /** Palette index to preview; EMPTY (0) is drawn as an "erase" marker. */
  color: number;
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
const TOUCH_TARGET_CSS_PX = 24; // below this on-screen cell size, posing is imprecise (FEN-124 U5)
const KEY_ZOOM_STEP = 1.4; // scale multiplier per +/- keypress (FEN-123)
const KEY_PAN_MARGIN_CELLS = 1; // keep the cursor this many cells off the edge

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

  // pointer interaction state — a Map of active pointers supports 1-finger pan +
  // 2-finger pinch/pan (mobile) alongside desktop hover/click (FEN-113).
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private moved = false; // the current gesture dragged/pinched past the tap threshold
  private downX = 0; // first pointer's down position (tap-vs-drag origin)
  private downY = 0;
  private downType = "mouse";
  private pinchDist = 0; // baseline finger distance for the active pinch (device px)
  private pinchMidX = 0; // baseline pinch midpoint (device px)
  private pinchMidY = 0;
  private readonly resizeObserver: ResizeObserver;

  // selection-preview overlay (FEN-113) — the renderer draws staged cells + the
  // hovered cell on top of the live board; the batch state itself lives in React.
  private overlay: readonly OverlayCell[] = [];
  private hoverCell: { x: number; y: number } | null = null;

  // last reported "cell smaller than the touch target" class, so onScaleClass
  // fires only on a real crossing rather than every frame (FEN-124 U5).
  private lastBelowTarget: boolean | null = null;

  // keyboard roving cursor (FEN-123) — the focused cell the arrow keys move. It
  // reuses the `hoverCell` overlay frame (recognition over recall) so a
  // keyboard-only / switch-access viewer can aim, stage and validate with no
  // pointer. Null until the canvas is first driven by the keyboard.
  private cursor: { x: number; y: number } | null = null;

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

  // --- selection overlay (F3 / FEN-113) -------------------------------------

  /**
   * Set the staged-selection preview (and optional hovered cell) the renderer
   * paints over the live board. Cheap O(1) swap + coalesced repaint; the actual
   * batch lives in the React layer. Pass `[]` / `null` to clear.
   */
  setOverlay(cells: readonly OverlayCell[], hover: { x: number; y: number } | null = null): void {
    this.overlay = cells;
    this.hoverCell = hover;
    this.dirty = true;
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
    if (this.interactive) {
      this.drawOverlay();
      this.emitScaleClass();
    }
  }

  /**
   * Report (only on change) whether a cell is now smaller than the comfortable
   * touch target, so the UI can suggest zooming in before posing (FEN-124 U5).
   * `view.scale` is device px per cell; divide by `dpr` for CSS px.
   */
  private emitScaleClass(): void {
    const below = this.view.scale / this.dpr < TOUCH_TARGET_CSS_PX;
    if (below === this.lastBelowTarget) return;
    this.lastBelowTarget = below;
    this.hooks.onScaleClass?.(below);
  }

  /**
   * Draw the selection preview: each staged cell as a translucent fill of its
   * chosen colour (erase as a hollow dashed cell) plus a crisp outline, and the
   * hovered cell as a thin frame. Purely a *preview* — these pixels are not in
   * the board buffer until the batch is committed. Visual styling is delegated
   * (UI lot); this is the strict-minimum-usable affordance.
   */
  private drawOverlay(): void {
    if (this.overlay.length === 0 && !this.hoverCell) return;
    const ctx = this.ctx;
    const s = this.view.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const px = (x: number) => this.view.tx + x * s;
    const py = (y: number) => this.view.ty + y * s;

    for (const cell of this.overlay) {
      const x = px(cell.x);
      const y = py(cell.y);
      if (cell.color === 0) {
        // erase: hollow dashed cell so it reads differently from a colour pose
        ctx.setLineDash([Math.max(2, s / 4), Math.max(2, s / 4)]);
        ctx.lineWidth = Math.max(1, s / 8);
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
        ctx.setLineDash([]);
      } else {
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = PALETTE_HEX[cell.color] ?? "#ffffff";
        ctx.fillRect(x, y, s, s);
        ctx.globalAlpha = 1;
      }
      ctx.lineWidth = Math.max(1, s / 10);
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
    }

    if (this.hoverCell) {
      const x = px(this.hoverCell.x);
      const y = py(this.hoverCell.y);
      ctx.lineWidth = Math.max(1, s / 12);
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
    }
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
    this.canvas.addEventListener("pointercancel", this.onPointerCancel);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("keydown", this.onKeyDown);
    // Suppress the browser's own pinch-zoom / scroll so two-finger gestures drive
    // the canvas view instead of the page (mobile parity).
    this.canvas.style.touchAction = "none";
  }

  private unbindInput(): void {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerCancel);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("keydown", this.onKeyDown);
  }

  /** Device-pixel position of a pointer event, viewport-relative. */
  private devicePos(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * this.dpr, y: (e.clientY - rect.top) * this.dpr };
  }

  private onPointerDown = (e: PointerEvent): void => {
    const wasIdle = this.pointers.size === 0;
    this.pointers.set(e.pointerId, this.devicePos(e));
    this.canvas.setPointerCapture(e.pointerId);
    if (wasIdle) {
      // first finger/button down — candidate tap origin
      this.moved = false;
      this.downX = e.clientX;
      this.downY = e.clientY;
      this.downType = e.pointerType || "mouse";
      this.hooks.onHover?.(null, e.clientX, e.clientY);
    }
    if (this.pointers.size === 2) {
      // second finger down — a pinch can never resolve to a tap
      this.moved = true;
      this.beginPinch();
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    // Hover readout only when no button/finger is down (desktop survol).
    if (this.pointers.size === 0) {
      this.hooks.onHover?.(this.toCell(e.clientX, e.clientY), e.clientX, e.clientY);
      return;
    }
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const cur = this.devicePos(e);

    if (this.pointers.size >= 2) {
      this.pointers.set(e.pointerId, cur);
      this.updatePinch();
      this.hooks.onHover?.(null, e.clientX, e.clientY);
      return;
    }

    // single pointer → pan once past the tap threshold; delta vs the last sample
    // for THIS pointer (so a 2→1 finger lift never jumps the view).
    const dx = e.clientX - this.downX;
    const dy = e.clientY - this.downY;
    if (!this.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) this.moved = true;
    if (this.moved) {
      this.view.panBy(cur.x - prev.x, cur.y - prev.y);
      this.dirty = true;
      this.hooks.onHover?.(null, e.clientX, e.clientY);
    }
    this.pointers.set(e.pointerId, cur);
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    const wasSingle = this.pointers.size === 1;
    this.pointers.delete(e.pointerId);
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);

    // A genuine tap: it was the only pointer and the gesture never moved/pinched.
    if (wasSingle && !this.moved) {
      const cell = this.toCell(e.clientX, e.clientY);
      if (cell) {
        this.hooks.onTap?.(cell.x, cell.y, this.downType);
        this.hooks.onPlace?.(cell.x, cell.y); // back-compat (legacy direct-place)
      }
    }
    // Going 2→1 fingers keeps `moved` true (this gesture was a pinch); the
    // survivor's stored device pos is its delta baseline, so no view jump.
  };

  private onPointerCancel = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  };

  private onPointerLeave = (e: PointerEvent): void => {
    if (this.pointers.size === 0) this.hooks.onHover?.(null, e.clientX, e.clientY);
  };

  // --- pinch (two-finger zoom + pan) ----------------------------------------

  /** Capture the baseline finger spread + midpoint when the 2nd finger lands. */
  private beginPinch(): void {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    this.pinchDist = Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1;
    this.pinchMidX = (a!.x + b!.x) / 2;
    this.pinchMidY = (a!.y + b!.y) / 2;
  }

  /** Zoom by the change in finger spread and follow the midpoint (two-finger pan). */
  private updatePinch(): void {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1;
    const midX = (a!.x + b!.x) / 2;
    const midY = (a!.y + b!.y) / 2;
    this.view.zoomAt(midX, midY, dist / this.pinchDist);
    this.view.panBy(midX - this.pinchMidX, midY - this.pinchMidY);
    this.pinchDist = dist;
    this.pinchMidX = midX;
    this.pinchMidY = midY;
    this.dirty = true;
  }

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

  // --- keyboard roving cursor (FEN-123, WCAG 2.1.1 / 4.1.3) -----------------

  /**
   * Drive the canvas entirely from the keyboard so a pointer-free / switch-access
   * viewer reaches the same {@link import("./selection.js").BatchSelection} as a
   * mouse or touch user. Arrows move the roving cursor (Shift = ×10 leap),
   * Enter/Space stages it (a tap), Ctrl/Cmd+Enter validates, Escape cancels,
   * +/- zoom on the cursor. Unhandled keys (Tab, etc.) pass through untouched so
   * focus is never trapped.
   */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.loaded || e.altKey) return;
    const step = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case "ArrowLeft":
        this.moveCursor(-step, 0);
        break;
      case "ArrowRight":
        this.moveCursor(step, 0);
        break;
      case "ArrowUp":
        this.moveCursor(0, -step);
        break;
      case "ArrowDown":
        this.moveCursor(0, step);
        break;
      case "Enter":
        if (e.ctrlKey || e.metaKey) {
          this.hooks.onValidate?.();
        } else {
          const c = this.ensureCursor();
          this.hooks.onActivate?.(c.x, c.y);
        }
        break;
      case " ":
      case "Spacebar": {
        const c = this.ensureCursor();
        this.hooks.onActivate?.(c.x, c.y);
        break;
      }
      case "Escape":
        this.hooks.onCancel?.();
        break;
      case "+":
      case "=":
        this.zoomCursor(KEY_ZOOM_STEP);
        break;
      case "-":
      case "_":
        this.zoomCursor(1 / KEY_ZOOM_STEP);
        break;
      default:
        return; // not ours — let the browser handle it (no focus trap)
    }
    e.preventDefault();
  };

  /** Lazily place the cursor at the centre of what's on screen, then report it. */
  private ensureCursor(): { x: number; y: number } {
    if (!this.cursor || !this.inBoard(this.cursor.x, this.cursor.y)) {
      const mid = this.view.cellAt(this.canvas.width / 2, this.canvas.height / 2);
      this.cursor = mid ?? { x: Math.floor(this.width / 2), y: Math.floor(this.height / 2) };
      this.syncCursor();
    }
    return this.cursor;
  }

  /** Move the roving cursor by a cell delta, clamped to the board, and follow it. */
  private moveCursor(dx: number, dy: number): void {
    // The very first arrow only *reveals* the cursor (at screen centre) so it
    // doesn't jump and double-announce; subsequent presses move it.
    const fresh = !this.cursor || !this.inBoard(this.cursor.x, this.cursor.y);
    const cur = this.ensureCursor();
    if (fresh) return;
    const nx = Math.min(this.width - 1, Math.max(0, cur.x + dx));
    const ny = Math.min(this.height - 1, Math.max(0, cur.y + dy));
    if (nx === cur.x && ny === cur.y) return;
    this.cursor = { x: nx, y: ny };
    this.scrollCursorIntoView();
    this.syncCursor();
  }

  /** Zoom on the cursor cell so the keyboard target stays put while zooming. */
  private zoomCursor(factor: number): void {
    const c = this.ensureCursor();
    const s = this.view.scale;
    this.view.zoomAt(this.view.tx + (c.x + 0.5) * s, this.view.ty + (c.y + 0.5) * s, factor);
    this.scrollCursorIntoView();
    this.dirty = true;
  }

  /** Pan the view so the cursor cell sits a margin inside the viewport. */
  private scrollCursorIntoView(): void {
    if (!this.cursor) return;
    const s = this.view.scale;
    const m = KEY_PAN_MARGIN_CELLS * s;
    const left = this.view.tx + this.cursor.x * s;
    const top = this.view.ty + this.cursor.y * s;
    let dx = 0;
    let dy = 0;
    if (left < m) dx = m - left;
    else if (left + s > this.canvas.width - m) dx = this.canvas.width - m - (left + s);
    if (top < m) dy = m - top;
    else if (top + s > this.canvas.height - m) dy = this.canvas.height - m - (top + s);
    if (dx || dy) this.view.panBy(dx, dy);
  }

  /** Paint the cursor as the hover frame and report it to the UI (aria-live). */
  private syncCursor(): void {
    if (!this.cursor) return;
    this.hoverCell = this.cursor;
    this.dirty = true;
    this.hooks.onCursorMove?.({ ...this.cursor });
  }

  private inBoard(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }
}
