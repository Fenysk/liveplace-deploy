/**
 * Pure presentational component for the moderation preview (FEN-2156 E3-B).
 *
 * Renders a bitmap canvas showing the cells targeted by a mod action (delete
 * group or ban) at 1 px per cell, scaled up with imageRendering:"pixelated"
 * (AC-F1 / AC-F4). Accepts only plain data — no Convex imports, no renderer
 * imports. The live wrapper (LiveModPreview, E3-C) owns the query and feeds
 * this component via props.
 *
 * Acceptance criteria handled here:
 *   AC-F1 — pixelated rendering (no smoothing)
 *   AC-F2 — pixel count label
 *   AC-F3 — 1×1 bitmap (swatch) when count === 1
 *   AC-F4 — single canvas bitmap, not N DOM nodes
 *   AC-F6 — empty message for deleteGroup (count === 0)
 *   AC-F7 — empty message for ban (count === 0, user still banned)
 *   AC-F9 — anonymous label via i18n (key consumed by E3-C wrapping context)
 *   AC-F10 — loading state, non-blocking
 *   AC-F11 — error state ("Aperçu indisponible"), actions remain active
 *   AC-B6 — index→hex mapping via injected PALETTE_HEX (no renderer import)
 */
import { type ReactNode, useEffect, useRef } from "react";
import type { TranslateFn } from "@canvas/i18n";
import { computeCanvasDims, pickCountKey, pickEmptyKey } from "./modPreview.js";

export interface PreviewCell {
  x: number;
  y: number;
  /** Palette index of the currently visible top (> 0). */
  color: number;
}

export interface PreviewBbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface PreviewData {
  count: number;
  bbox: PreviewBbox | null;
  cells: PreviewCell[];
  truncated: boolean;
  targetResolved: boolean;
}

export interface ModPreviewMiniProps {
  state: "loading" | "error" | "ready";
  action: "deleteGroup" | "ban";
  /** Required when state === "ready" (contract §2). */
  data?: PreviewData;
  /** PALETTE_HEX array — injected so this component stays Convex/renderer-free. */
  paletteHex: readonly string[];
  t: TranslateFn;
}

/**
 * Miniature bitmap preview of the cells targeted by a moderation action.
 * Styling (FEN-2163, Étape 5) lives in canvas.css under `.lp-modpreview*`;
 * the inline width/height/imageRendering on the <canvas> are functional
 * (data-driven dims + pixelated scaling), not decoration.
 */
export function ModPreviewMini({
  state,
  action,
  data,
  paletteHex,
  t,
}: ModPreviewMiniProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (state !== "ready" || !data?.bbox || data.count === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const ox = data.bbox.minX;
    const oy = data.bbox.minY;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const cell of data.cells) {
      const hex = paletteHex[cell.color];
      if (!hex) continue;
      ctx.fillStyle = hex;
      ctx.fillRect(cell.x - ox, cell.y - oy, 1, 1);
    }
  }, [state, data, paletteHex]);

  // AC-F10: loading indicator — non-blocking (actions in parent remain clickable)
  if (state === "loading") {
    return (
      <div className="lp-modpreview" data-state="loading" aria-busy="true">
        <span className="lp-modpreview-skeleton" aria-hidden="true" />
        <span className="lp-modpreview-status">{t("canvas.mod.preview.loading")}</span>
      </div>
    );
  }

  // AC-F11: error — compact, actions in parent must stay active
  if (state === "error") {
    return (
      <div className="lp-modpreview" data-state="error">
        <span className="lp-modpreview-status">{t("canvas.mod.preview.unavailable")}</span>
      </div>
    );
  }

  // state === "ready"
  if (!data || data.count === 0) {
    // AC-F6 (deleteGroup) / AC-F7 (ban)
    return (
      <div className="lp-modpreview" data-state="empty">
        <span className="lp-modpreview-status">{t(pickEmptyKey(action))}</span>
      </div>
    );
  }

  const dims = data.bbox ? computeCanvasDims(data.bbox) : null;

  return (
    <div className="lp-modpreview" data-state="ready">
      {dims && (
        // AC-F1: imageRendering pixelated (no smoothing). AC-F3: 1×1 bitmap when
        // count===1 scales to a solid swatch. AC-F4: one canvas, not N divs.
        <span className="lp-modpreview-frame">
          <canvas
            ref={canvasRef}
            className="lp-modpreview-canvas"
            width={dims.bitmapW}
            height={dims.bitmapH}
            style={{
              width: dims.displayW,
              height: dims.displayH,
              imageRendering: "pixelated",
            }}
          />
        </span>
      )}
      {/* AC-F2: pixel count label */}
      <span className="lp-modpreview-count">{t(pickCountKey(data.count), { count: data.count })}</span>
    </div>
  );
}
