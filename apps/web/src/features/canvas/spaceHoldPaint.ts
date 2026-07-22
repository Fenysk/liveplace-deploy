/**
 * G8 (FEN-616 / FEN-1888): Space-hold continuous paint logic.
 *
 * Pure functions extracted from CanvasView.tsx so both the live component and
 * the c5SpaceHoldPaint harness test consume the same implementation (no
 * verbatim copy).
 *
 * Three call sites in CanvasView:
 *  1. Renderer `onSpaceHold` — fires only when the canvas element has focus.
 *  2. `onHover` — fires on every mouse-move while Space may or may not be held.
 *  3. Document `keydown` / `keyup` and `window blur` — ensures continuous paint
 *     works regardless of which element has focus (FEN-1888).
 */

export interface SpaceHoldCtx {
  spacePaintingRef: { current: boolean };
  drawingRef: { current: boolean };
  hoverRef: { current: { x: number; y: number } | null };
  stageCell: (x: number, y: number, opts?: { onlyAdd?: boolean }) => void;
}

/**
 * Renderer `onSpaceHold` body (CanvasView l.1282-1292).
 * AC2 (FEN-1780): held → SET, not toggle.
 */
export function applySpaceHold(held: boolean, ctx: SpaceHoldCtx): void {
  if (held && !ctx.spacePaintingRef.current) {
    ctx.spacePaintingRef.current = true;
    if (ctx.drawingRef.current && ctx.hoverRef.current) {
      ctx.stageCell(ctx.hoverRef.current.x, ctx.hoverRef.current.y, { onlyAdd: true });
    }
  } else if (!held) {
    ctx.spacePaintingRef.current = false;
  }
}

/**
 * Space-paint branch of `onHover` (CanvasView l.1304-1307).
 * Caller is responsible for updating `hoverRef.current` and calling
 * `rendererRef.current?.setOverlay(...)` before invoking this.
 * AC2 (FEN-1780): onlyAdd = SET semantics — revisiting a cell never removes it.
 */
export function applyHoverSpacePaint(
  cell: { x: number; y: number } | null,
  ctx: Pick<SpaceHoldCtx, "spacePaintingRef" | "drawingRef" | "stageCell">,
): void {
  if (cell && ctx.spacePaintingRef.current && ctx.drawingRef.current) {
    ctx.stageCell(cell.x, cell.y, { onlyAdd: true });
  }
}

/**
 * Document `keydown` Space branch (CanvasView l.1185-1191).
 * Caller is responsible for calling `e.preventDefault()` and checking
 * `e.code === "Space"` before invoking.
 */
export function applySpaceKeyDown(repeated: boolean, ctx: SpaceHoldCtx): void {
  if (!repeated && ctx.drawingRef.current && !ctx.spacePaintingRef.current) {
    ctx.spacePaintingRef.current = true;
    if (ctx.hoverRef.current) {
      ctx.stageCell(ctx.hoverRef.current.x, ctx.hoverRef.current.y, { onlyAdd: true });
    }
  }
}

/**
 * Disarm continuous paint on `keyup "Space"` or `window blur`
 * (CanvasView l.1223-1228).
 */
export function releaseSpacePaint(ctx: Pick<SpaceHoldCtx, "spacePaintingRef">): void {
  ctx.spacePaintingRef.current = false;
}
