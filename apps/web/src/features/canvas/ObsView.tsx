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
import "./canvas.css";

export function ObsView(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    const view = parseObsView(window.location.pathname, window.location.search);

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
      url: gatewayWsUrl(view.slug),
      handlers: {
        onBinary: (buf) => renderer.applyBinary(buf),
      },
    });
    void net.connect();

    return () => {
      net.disconnect();
      renderer.destroy();
      root.classList.remove("lp-obs-root");
    };
  }, []);

  return (
    <div className="lp-obs">
      <canvas ref={canvasRef} className="lp-canvas" />
    </div>
  );
}
