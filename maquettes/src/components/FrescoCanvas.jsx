import { useEffect, useRef } from "react";
import { buildFresco, FRESCO_W, FRESCO_H } from "../data/fresco.js";

const GRID = buildFresco();

// Reads a CSS variable off :root (respects the active [data-direction]).
function cssVar(name, fallback) {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Renders the fresco onto a <canvas>. The §5.1 / §14 solution lives here:
 *  - a NEUTRAL checkerboard + flat field behind the pixels (no hue → no tint)
 *  - a hairline per-cell grid so EVERY pixel is bounded, incl. pure white
 *  - pixels are painted at full opacity, exact hex (color fidelity: the swatch
 *    in the selector == the placed pixel, guaranteed).
 */
export default function FrescoCanvas({ cell = 12, showGrid = true, reticle = null, placedFx = null }) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = FRESCO_W * cell;
    const h = FRESCO_H * cell;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    const field = cssVar("--canvas-field", "#cfcfd4");
    const checker = cssVar("--canvas-checker", "#c6c6cc");
    const grid = cssVar("--canvas-grid", "rgba(24,24,28,.10)");

    // Neutral backing: flat field + subtle 2-cell checker (shows where pixels
    // are empty/transparent without competing with placed colours).
    ctx.fillStyle = field;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = checker;
    for (let y = 0; y < FRESCO_H; y++)
      for (let x = 0; x < FRESCO_W; x++)
        if ((x + y) % 2 === 0) ctx.fillRect(x * cell, y * cell, cell, cell);

    // Pixels — exact hex, full opacity.
    for (let y = 0; y < FRESCO_H; y++) {
      for (let x = 0; x < FRESCO_W; x++) {
        const c = GRID[y * FRESCO_W + x];
        if (c) { ctx.fillStyle = c; ctx.fillRect(x * cell, y * cell, cell, cell); }
      }
    }

    // Hairline grid — guarantees white/very-light pixels stay bounded (§14).
    if (showGrid && cell >= 8) {
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= FRESCO_W; x++) { ctx.moveTo(x * cell + .5, 0); ctx.lineTo(x * cell + .5, h); }
      for (let y = 0; y <= FRESCO_H; y++) { ctx.moveTo(0, y * cell + .5); ctx.lineTo(w, y * cell + .5); }
      ctx.stroke();
    }
  }, [cell, showGrid]);

  const w = FRESCO_W * cell;
  const h = FRESCO_H * cell;

  return (
    <div className="relative" style={{ width: w, height: h }}>
      <canvas ref={ref} className="block rounded-[var(--radius-sm)]" style={{ imageRendering: "pixelated" }} />
      {/* Targeting reticle (mobile viser→confirmer). Double-encoded: ring +
          corner ticks + colour preview, never colour alone (§6). */}
      {reticle && (
        <div
          className="pointer-events-none absolute"
          style={{ left: reticle.x * cell - 2, top: reticle.y * cell - 2, width: cell + 4, height: cell + 4 }}
        >
          <div className="absolute inset-0 rounded-[3px]" style={{ boxShadow: "0 0 0 2px var(--ui-text), 0 0 0 4px rgba(255,255,255,.85)" }} />
          <div className="absolute inset-[3px] rounded-[2px]" style={{ background: reticle.hex }} />
        </div>
      )}
      {/* Optimistic place feedback — the signature delighter (Kano). */}
      {placedFx && (
        <div className="pointer-events-none absolute" style={{ left: placedFx.x * cell, top: placedFx.y * cell, width: cell, height: cell }}>
          <div className="absolute inset-0 lp-pop rounded-[2px]" style={{ background: placedFx.hex, boxShadow: "0 0 0 1.5px rgba(255,255,255,.9)" }} />
          <div className="absolute inset-0 lp-ping rounded-full" style={{ boxShadow: `0 0 0 2px ${placedFx.hex}` }} />
        </div>
      )}
    </div>
  );
}
