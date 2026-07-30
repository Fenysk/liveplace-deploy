/**
 * OBS browser-source view (F9, FEN-65) — a read-only canvas a streamer drops in
 * as a browser source and overlays on their scene. Driven entirely by the URL:
 * `/obs` or `/{slug}/obs` selects the canvas, query params frame it
 * (`bg`/`fond`, `grid`/`grille`, `zoom`, `crop`/`cadrage` — FR/EN, see obs.ts).
 *
 * No placement, no pointer affordances (CA3), transparent background by default
 * (CA1) so the source composites over the scene. It consumes the same binary
 * snapshot/delta stream via {@link CanvasNetClient}; the optimism controller is
 * deliberately absent (nothing to place).
 */
import { useEffect, useRef } from "react";
import { CanvasRenderer } from "./renderer.js";
import { CanvasNetClient } from "./net.js";
import { parseObsView } from "./obs.js";
import { gatewayWsUrl } from "./gateway.js";
// Design tokens only (NOT the full Arcade bundle): the OBS overlay must stay a
// minimal browser source, but it needs `--elev-obs` for the contour in
// canvas.css (FEN-271, Lot C). tokens.css is just CSS custom-property defs.
import "../../ui/styles/tokens.css";
import "./canvas.css";

export interface ObsViewProps {
  /** Explicit canvas slug from the router (S2). When omitted, falls back to
   * the slug extracted from the URL path via `parseObsView`. */
  slug?: string | null;
  /**
   * Convex canvas `_id` to pass as `?canvas=<id>` on the WS URL so the
   * gateway routes to the right canvas. When absent the gateway falls back to
   * the default canvas (bare /ws). Supplied by ObsViewLive after Convex
   * validates the slug — without it an unknown slug silently shows the default
   * canvas instead of nothing / an error (FEN-1876).
   */
  canvasId?: string | null;
}

export function ObsView({ slug: slugProp, canvasId }: ObsViewProps = {}): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    const view = parseObsView(window.location.pathname, window.location.search);
    // Explicit slug prop wins; fall back to URL-derived slug for the /[slug]/obs route.
    const slug = slugProp !== undefined ? slugProp : view.slug;

    // A transparent source needs the page itself transparent, not just the canvas.
    const root = document.documentElement;
    if (view.background === null) root.classList.add("lp-obs-root");

    const renderer = new CanvasRenderer(
      el,
      {},
      {
        interactive: false,
        background: view.background,
        grid: view.grid,
        zoom: view.zoom,
        crop: view.crop,
      },
    );

    const net = new CanvasNetClient({
      url: gatewayWsUrl(slug, canvasId ?? undefined),
      handlers: {
        onBinary: (buf) => renderer.applyBinary(buf),
        onDimsChanged: (w, h) => renderer.resizeTo(w, h),
      },
    });
    void net.connect();

    return () => {
      net.disconnect();
      renderer.destroy();
      root.classList.remove("lp-obs-root");
    };
  }, [slugProp, canvasId]);

  return (
    <div className="lp-obs">
      <canvas ref={canvasRef} className="lp-canvas" />
    </div>
  );
}
