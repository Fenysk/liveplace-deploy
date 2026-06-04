/**
 * Crisis ban/wipe ON-CANVAS selection surface ([FEN-160], spec FEN-157 §2/§3).
 * The "point at the offending pixels" surface the committed copy promises
 * ("choisis … sur la fresque"): a read-only live canvas (same binary
 * snapshot/delta stream as the OBS view, NO placement) with a reticle (ban) or a
 * two-corner marquee (wipe) drawn over it.
 *
 * Modality parity (acceptance §6.5 — ≥1 non-pointer path to BOTH ban and wipe):
 * the surface drives the SAME picks from pointer and keyboard by reusing the
 * renderer's input layer — `onTap`/`onHover` (pointer) and the FEN-123
 * `onCursorMove`/`onActivate`/`onCancel` roving cursor (keyboard). Ban = aim then
 * pick; wipe = pick corner A, the marquee previews to the cursor, pick corner B.
 * No drag gesture (it would fight the renderer's pan), so touch + keyboard share
 * one model.
 *
 * Frame-budget discipline: the live marquee overlay is the rectangle PERIMETER
 * only (`rectOutlineCells`, O(w+h)); the full `cells` payload for `deletePixels`
 * is materialised once at finalize (`rectCells`). The selection STATE/logic lives
 * in the pure, unit-tested `crisisSelection.ts`; this file is the thin DOM/host
 * glue (Convex-free — the host wires `authorAt`/`banAndWipe`/`deletePixels`).
 *
 * Always-escapable (acceptance §6.4): a persistent "Annuler" + Escape both exit
 * select-mode in one gesture, so a mis-tap never traps the streamer mid-raid.
 */
import { useEffect, useRef } from "react";
import { useTranslate } from "@canvas/i18n/react";
import { CanvasRenderer } from "../canvas/renderer.js";
import { CanvasNetClient } from "../canvas/net.js";
import { gatewayWsUrl } from "../canvas/gateway.js";
import "../canvas/canvas.css";
import {
  rectCells,
  rectCellCount,
  rectOutlineCells,
  banModeBanner,
  wipeModeBanner,
  wipeCountAnnounce,
  cancelledAnnounce,
  type CellCoord,
  type CrisisAnnounce,
} from "./crisisSelection.js";

/** Palette indices used to tint the selection overlay (visual pass delegated). */
const RETICLE_COLOR = 5; // red — the ban reticle marker
const MARQUEE_COLOR = 8; // a distinct hue for the wipe outline

export interface CrisisSelectorProps {
  /** Canvas slug to subscribe to (read-only live pixels). */
  slug: string;
  /** Which selection flow is active. */
  mode: "ban" | "wipe";
  /** Ban: a cell was picked → host resolves `authorAt` + shows the blast-radius confirm. */
  onBanPick: (cell: CellCoord) => void;
  /** Wipe: the region was outlined → host shows the cell-count confirm with these cells. */
  onWipeRegion: (cells: CellCoord[], count: number) => void;
  /** Esc / Annuler → exit select-mode (host clears the mode). */
  onCancel: () => void;
  /** Polite live-region announce (host owns the single aria-live node). */
  onAnnounce: (a: CrisisAnnounce) => void;
}

export function CrisisSelector(props: CrisisSelectorProps): React.ReactElement {
  const t = useTranslate();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<CanvasRenderer | null>(null);
  // Wipe: the first picked corner (null until corner A is set). A ref, not state,
  // so the renderer hook closures always see the live value without re-mounting.
  const anchorRef = useRef<CellCoord | null>(null);
  // Latest props captured in refs so the renderer (mounted once) always calls
  // through to current handlers without tearing down the WS/GL on every render.
  const modeRef = useRef(props.mode);
  modeRef.current = props.mode;
  const cbRef = useRef(props);
  cbRef.current = props;

  function bounds(): { width: number; height: number } {
    const r = rendererRef.current;
    return { width: r?.boardWidth ?? 0, height: r?.boardHeight ?? 0 };
  }

  /** Repaint the overlay for the current aim cell (reticle, or marquee preview). */
  function paintAim(cell: CellCoord | null): void {
    const r = rendererRef.current;
    if (!r) return;
    if (modeRef.current === "ban") {
      r.setOverlay(cell ? [{ x: cell.x, y: cell.y, color: RETICLE_COLOR }] : []);
      return;
    }
    // wipe: outline from the anchor (if set) to the current cell.
    const anchor = anchorRef.current;
    if (anchor && cell) {
      const outline = rectOutlineCells(anchor, cell, bounds()).map((c) => ({ ...c, color: MARQUEE_COLOR }));
      r.setOverlay(outline);
      cbRef.current.onAnnounce(wipeCountAnnounce(rectCellCount(anchor, cell, bounds())));
    } else {
      r.setOverlay(cell ? [{ x: cell.x, y: cell.y, color: MARQUEE_COLOR }] : []);
    }
  }

  /** A pick (pointer tap or keyboard Enter) on a cell. */
  function pick(cell: CellCoord): void {
    if (modeRef.current === "ban") {
      cbRef.current.onBanPick(cell);
      return;
    }
    const anchor = anchorRef.current;
    if (!anchor) {
      anchorRef.current = cell; // corner A
      cbRef.current.onAnnounce(wipeCountAnnounce(1));
      paintAim(cell);
      return;
    }
    // corner B → finalize the region, then reset for a possible next outline.
    const b = bounds();
    cbRef.current.onWipeRegion(rectCells(anchor, cell, b), rectCellCount(anchor, cell, b));
    anchorRef.current = null;
  }

  // Mount the read-only live canvas ONCE (per slug) and wire the input hooks.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const renderer = new CanvasRenderer(
      el,
      {
        onTap: (x, y) => pick({ x, y }),
        onActivate: (x, y) => pick({ x, y }),
        onHover: (cell) => paintAim(cell),
        onCursorMove: (cell) => paintAim(cell),
        onCancel: () => {
          anchorRef.current = null;
          cbRef.current.onAnnounce(cancelledAnnounce());
          cbRef.current.onCancel();
        },
      },
      { interactive: true, background: "#0a0a0a" },
    );
    rendererRef.current = renderer;

    const net = new CanvasNetClient({
      url: gatewayWsUrl(props.slug),
      handlers: { onBinary: (buf) => renderer.applyBinary(buf) },
    });
    void net.connect();

    return () => {
      net.disconnect();
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [props.slug]);

  // Announce the mode banner once on entry / mode change, and reset the anchor.
  useEffect(() => {
    anchorRef.current = null;
    rendererRef.current?.setOverlay([]);
    props.onAnnounce(props.mode === "ban" ? banModeBanner() : wipeModeBanner());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mode]);

  return (
    <div className="lp-crisis-selector" style={wrapStyle}>
      <div style={bannerRowStyle}>
        <p role="status" style={bannerStyle}>
          {t(props.mode === "ban" ? "studio.crisis.ban.mode" : "studio.crisis.wipe.mode")}
        </p>
        {/* Persistent one-gesture escape — always visible so a mis-tap never traps (§6.4). */}
        <button type="button" className="lp-btn" style={cancelBtnStyle} onClick={props.onCancel}>
          {t("studio.crisis.cancel")}
        </button>
      </div>
      <div style={canvasFrameStyle}>
        <canvas ref={canvasRef} className="lp-canvas" tabIndex={0} aria-label={t("studio.crisis.banPrompt")} />
      </div>
    </div>
  );
}

// --- Inline styles (delegated visual pass; usable defaults only) -------------
const wrapStyle: React.CSSProperties = { display: "grid", gap: "0.5rem", marginTop: "0.5rem" };
const bannerRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  flexWrap: "wrap",
};
const bannerStyle: React.CSSProperties = { margin: 0, fontWeight: 600, fontSize: 14 };
const canvasFrameStyle: React.CSSProperties = {
  position: "relative",
  width: "100%",
  aspectRatio: "4 / 3",
  borderRadius: 10,
  overflow: "hidden",
  border: "1px solid #d6d6de",
  background: "#0a0a0a",
};
const cancelBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 44,
  minWidth: 44,
  padding: "0.4rem 1rem",
  borderRadius: 8,
  border: "1px solid #c7c7d1",
  background: "#fff",
  color: "#333",
  fontWeight: 600,
  cursor: "pointer",
};
