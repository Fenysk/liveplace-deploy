import { forwardRef, type ReactElement, type ReactNode } from "react";

/**
 * FrescoCanvas (handoff §3.1) — the neutral field that frames the live pixel
 * board (Lot A — [FEN-269]). In the maquette this owned the static cell/reticle/
 * place-pop demo; in the real app the Canvas 2D {@link CanvasRenderer} paints the
 * board, the reticle and the place-pop itself onto the forwarded `<canvas>`. So
 * here FrescoCanvas owns exactly the part the renderer cannot: the **chromatic
 * neutrality around the canvas** the lot calls for.
 *
 * Why neutral chrome matters: a coloured/dark surround shifts how a posed pixel
 * reads (simultaneous contrast), so the fidelity promise "selector swatch ==
 * placed pixel" only holds if the field around the board is neutral. The frame
 * is painted from the Arcade canvas tokens (`--canvas-field` / `--canvas-frame`,
 * FEN-268) — one source, no hard-coded colour — and the renderer runs with a
 * transparent background so empty letterbox area shows this neutral field.
 *
 * It is purely presentational: it forwards the ref so the renderer attaches to
 * the inner element and passes the a11y wiring straight through (the keyboard
 * roving cursor + text alternative live on the canvas, FEN-123/U3). The OBS
 * overlay keeps its own bare, transparent surface and does not use this frame.
 */
export interface FrescoCanvasProps {
  /** Accessible name for the interactive grid (i18n owned by the screen). */
  ariaLabel: string;
  /** id of the visually-hidden keyboard-help paragraph (text alternative). */
  ariaDescribedBy?: string;
  /** Overlaid HUD / panels rendered above the field (the screen composes them). */
  children?: ReactNode;
}

export const FrescoCanvas = forwardRef<HTMLCanvasElement, FrescoCanvasProps>(
  function FrescoCanvas({ ariaLabel, ariaDescribedBy, children }, ref): ReactElement {
    return (
      <div className="lp-fresco">
        {/* Fixed viewport checkerboard (FEN-418 D1): a CSS pattern behind the
            transparent canvas so empty cells "show through" to a static grid.
            The checker is position:fixed so pan/zoom of the canvas (which only
            moves the painted pixels, not this element) leaves it immobile — the
            transparency illusion holds regardless of zoom level. aria-hidden:
            purely decorative, carries no information. */}
        <div className="lp-checker" aria-hidden="true" />
        {/* Focusable interactive grid: role="application" so a screen reader
            passes arrow keys straight to the roving cursor instead of its browse
            mode. Named + described for the text alternative (U3). */}
        <canvas
          ref={ref}
          className="lp-canvas"
          tabIndex={0}
          role="application"
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
        />
        {children}
      </div>
    );
  },
);
