/**
 * Pure logic for the ModPreviewMini component (FEN-2156 E3-B).
 *
 * All functions are framework-agnostic and DOM-free — they operate only on data
 * and return primitive values or MessageKeys, making them trivially testable.
 *
 * The data contract (bbox, cells, count, truncated, targetResolved) comes from
 * the `moderation.previewModerationTargets` Convex query (FEN-2158 §2); this
 * module only knows about the shape, not the source.
 */
import type { MessageKey } from "@canvas/i18n";

/** Max CSS dimension (px) for the displayed preview canvas on either axis. */
export const PREVIEW_MAX_PX = 96;

export interface BboxLike {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CanvasDims {
  /** Native bitmap width in pixels (= bbox width in cells). */
  bitmapW: number;
  /** Native bitmap height in pixels (= bbox height in cells). */
  bitmapH: number;
  /** CSS display width in pixels (scaled, capped at PREVIEW_MAX_PX). */
  displayW: number;
  /** CSS display height in pixels (scaled, capped at PREVIEW_MAX_PX). */
  displayH: number;
}

/**
 * Compute bitmap and CSS display dimensions for the preview canvas.
 *
 * The bitmap is drawn at 1 px per cell. The display is scaled up to
 * PREVIEW_MAX_PX using integer multiples (clean pixelated look), or scaled
 * down when the bbox exceeds PREVIEW_MAX_PX. This ensures `imageRendering:
 * "pixelated"` always produces crisp cells regardless of bbox size.
 */
export function computeCanvasDims(bbox: BboxLike): CanvasDims {
  const bitmapW = bbox.maxX - bbox.minX + 1;
  const bitmapH = bbox.maxY - bbox.minY + 1;
  const longest = Math.max(bitmapW, bitmapH);
  const scale =
    longest <= PREVIEW_MAX_PX
      ? Math.floor(PREVIEW_MAX_PX / longest) // integer upscale → crisp pixels
      : PREVIEW_MAX_PX / longest; // downscale when bbox exceeds cap
  return {
    bitmapW,
    bitmapH,
    displayW: Math.round(bitmapW * scale),
    displayH: Math.round(bitmapH * scale),
  };
}

/**
 * i18n key for the pixel count label.
 * Selects the singular form for count === 1 (AC-F3) and the plural otherwise.
 */
export function pickCountKey(count: number): MessageKey {
  return count === 1
    ? "canvas.mod.preview.count.one"
    : "canvas.mod.preview.count";
}

/**
 * i18n key for the empty-target message shown when count === 0.
 * deleteGroup → AC-F6 ("no pixels to delete").
 * ban         → AC-F7 ("user will still be banned").
 */
export function pickEmptyKey(action: "deleteGroup" | "ban"): MessageKey {
  return action === "deleteGroup"
    ? "canvas.mod.preview.emptyDelete"
    : "canvas.mod.preview.emptyBan";
}
