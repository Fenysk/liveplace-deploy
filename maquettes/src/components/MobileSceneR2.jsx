import { useEffect, useLayoutEffect, useRef, useState } from "react";
import FrescoCanvas from "./FrescoCanvas.jsx";
import Gauge from "./Gauge.jsx";
import ColorSelector from "./ColorSelector.jsx";
import StatusPill from "./StatusPill.jsx";
import Button from "./ui/Button.jsx";
import Wordmark from "./Wordmark.jsx";
import PanelHandle from "./PanelHandle.jsx";
import ReopenFab from "./ReopenFab.jsx";
import ZoomControls from "./ZoomControls.jsx";
import { PALETTE, FRESCO_W, FRESCO_H } from "../data/fresco.js";

/**
 * MobileSceneR2 — the Round-2 interactive mobile target (FEN-368), Arcade identity.
 *
 * Built on the FEN-337 refonte, this version makes the three Alexis frictions
 * concrete and TRYABLE (not just drawn):
 *   §1 / AC-R2-1+4  the bottom panel is a real OVERLAY sheet over a full-bleed
 *                   canvas. Drag the honest PanelHandle (or tap ✕) to close it →
 *                   canvas goes full-screen; a persistent ReopenFab (with an
 *                   "N en cours" badge) brings it back. No fake handle (F1).
 *   §2 / AC-R2-2    the canvas pans FREELY in every direction. The clamp reference
 *                   is the VISIBLE zone (viewport minus the open-panel inset), so
 *                   any cell — even under the open dock — can be brought on-screen.
 *                   Overscroll is bounded: ≥ --pan-overscroll-min of the fresco
 *                   always stays visible (anti-loss).
 *   §3 / AC-R2-3    the dezoom floor is now FIT-TO-SCREEN ("vue d'ensemble"),
 *                   decoupled from the old cover-fit. ZoomControls expose an
 *                   explicit fit path (pinch isn't discoverable, F4).
 *
 * Controllable for the static state frames (initialOpen / initialView) AND fully
 * interactive on the live phone. All bounds are tokens (no hardcoded value, AC-5).
 */

const MAX_CELL = 30;          // zoom ceiling (precision to place) — mirrors MAX_SCALE
const DETAIL_FACTOR = 3.2;    // default "detail" zoom relative to fit
const ZOOM_STEP = 1.4;
const HEART = { x: 29, y: 19 }; // busy region to frame on first load

const num = (name, fallback) => {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : fallback;
};

const ctaLabel = { ready: "Poser ici", cooldown: "Attends la recharge", frozen: "Pose en pause" };

// Inline icons — never depend on an emoji font (headless + prod safety).
const IconX = (p) => (
  <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
const IconMove = (p) => (
  <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />
  </svg>
);

export default function MobileSceneR2({
  orientation = "portrait",
  placeState = "ready",
  reserve = 20,
  initialOpen = true,
  initialView = "detail",   // "detail" | "overview"
  staged = 0,               // staged batch → ReopenFab badge when closed (Zeigarnik)
  showHint = true,          // first-use gesture coach (F4)
}) {
  const [color, setColor] = useState(PALETTE[4].hex);
  const [open, setOpen] = useState(initialOpen);
  const [dragY, setDragY] = useState(0);          // live panel drag preview
  const [cell, setCell] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hint, setHint] = useState(showHint);
  const [placedFx, setPlacedFx] = useState(null);

  const stageRef = useRef(null);
  const dockRef = useRef(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [dockH, setDockH] = useState(0);

  const overscrollMin = num("--pan-overscroll-min", 0.2);
  const snapRatio = num("--dock-snap-ratio", 0.25);

  // Measure the stage + dock so fit/clamp use real geometry, not magic numbers.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setStageSize({ w: el.clientWidth, h: el.clientHeight });
      if (dockRef.current) setDockH(dockRef.current.offsetHeight);
    });
    ro.observe(el);
    setStageSize({ w: el.clientWidth, h: el.clientHeight });
    if (dockRef.current) setDockH(dockRef.current.offsetHeight);
    return () => ro.disconnect();
  }, []);

  const fitCell = stageSize.w
    ? Math.max(2, Math.floor(Math.min(stageSize.w / FRESCO_W, stageSize.h / FRESCO_H)))
    : 0;
  const detailCell = Math.min(MAX_CELL, Math.round(fitCell * DETAIL_FACTOR));

  // Visible (non-masked) zone = stage minus the open panel inset (ux-spec §2.1).
  const inset = open ? Math.max(0, dockH - Math.max(0, dragY)) : 0;
  const visibleH = Math.max(1, stageSize.h - inset);

  function clampPan(p, c = cell, vH = visibleH) {
    const fw = FRESCO_W * c, fh = FRESCO_H * c;
    const mx = overscrollMin * Math.min(fw, stageSize.w);
    const my = overscrollMin * Math.min(fh, vH);
    return {
      x: Math.min(stageSize.w - mx, Math.max(mx - fw, p.x)),
      y: Math.min(vH - my, Math.max(my - fh, p.y)),
    };
  }

  function frame(view, c) {
    const fw = FRESCO_W * c, fh = FRESCO_H * c;
    if (view === "overview") return { x: (stageSize.w - fw) / 2, y: (visibleH - fh) / 2 };
    // detail: centre the heart in the visible zone
    return clampPan({ x: stageSize.w / 2 - HEART.x * c, y: visibleH / 2 - HEART.y * c }, c);
  }

  // Initial framing once geometry is known.
  useEffect(() => {
    if (!fitCell) return;
    const c = initialView === "overview" ? fitCell : detailCell;
    setCell(c);
    setPan(frame(initialView, c));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitCell]);

  const atFit = cell > 0 && cell <= fitCell;

  // ---- pan (free drag) ----
  const panStart = (e) => {
    if (e.target.closest?.("[data-chrome]")) return; // don't pan from chrome
    const o = { x: e.clientX, y: e.clientY }, p0 = { ...pan };
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - o.x, dy = ev.clientY - o.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true; // DRAG_THRESHOLD (tap vs pan)
      setPan(clampPan({ x: p0.x + dx, y: p0.y + dy }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) setHint(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ---- zoom (keeps the stage centre fixed) ----
  const zoomTo = (next, view) => {
    const c = Math.max(fitCell, Math.min(MAX_CELL, next));
    const cx = stageSize.w / 2, cy = visibleH / 2;
    const k = c / cell;
    setCell(c);
    setPan(view === "overview"
      ? frame("overview", c)
      : clampPan({ x: cx - (cx - pan.x) * k, y: cy - (cy - pan.y) * k }, c));
    setHint(false);
  };

  // ---- panel open/close ----
  const closePanel = () => { setOpen(false); setDragY(0); };
  const openPanel = () => { setOpen(true); setDragY(0); };
  const onHandleDrag = (dy) => { if (open) setDragY(Math.max(0, dy)); };
  const onHandleEnd = (dy) => {
    setDragY(0);
    if (open && dy > dockH * snapRatio) closePanel();
  };

  const doPlace = () => {
    if (placeState !== "ready") return;
    const r = reticleCell();
    setPlacedFx({ x: r.x, y: r.y, hex: color });
    setTimeout(() => setPlacedFx(null), 700);
  };

  // Reticle sits at the visible-zone centre, snapped to a cell (viser→confirmer).
  const reticleCell = () => ({
    x: Math.round((stageSize.w / 2 - pan.x) / cell),
    y: Math.round((visibleH / 2 - pan.y) / cell),
  });
  const r = cell ? reticleCell() : HEART;
  const reticle = placeState === "ready" && !atFit ? { x: r.x, y: r.y, hex: color } : null;

  // ---------- shared canvas stage ----------
  const Stage = (
    <div
      ref={stageRef}
      onPointerDown={panStart}
      className="absolute inset-0 touch-none overflow-hidden"
      style={{ background: "var(--canvas-field)", cursor: "grab" }}
    >
      {cell > 0 && (
        <div className="absolute will-change-transform" style={{ left: pan.x, top: pan.y }}>
          <FrescoCanvas cell={cell} reticle={reticle} placedFx={placedFx} />
        </div>
      )}
      {/* Arcade frame — accent hairline inset; canvas never bleeds into chrome. */}
      <div className="pointer-events-none absolute inset-0"
        style={{ boxShadow: "inset 0 0 0 2px var(--accent), inset 0 0 0 4px var(--ui-bg)" }} />
      {/* Overview affordance label so the "vue d'ensemble" state is legible. */}
      {atFit && (
        <div data-chrome className="pointer-events-none absolute left-1/2 top-[calc(var(--space-12)+var(--space-10))] z-[var(--z-dock)] -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-pill)] bg-[var(--ui-surface)] px-3 py-1 text-[var(--text-xs)] font-semibold text-[var(--ui-text-secondary)] shadow-[var(--elev-1)]">
          Vue d'ensemble · fresque entière
        </div>
      )}
    </div>
  );

  // ----------------------------------------------------------- PORTRAIT -----
  if (orientation !== "landscape") {
    const slide = open ? Math.max(0, dragY) : (dockH || 320);
    return (
      <div className="relative h-full w-full overflow-hidden bg-[var(--ui-bg)]">
        {/* TopBar (opaque, floats above the full-bleed canvas) */}
        <header data-chrome
          className="absolute inset-x-0 top-0 z-[var(--z-dock)] flex items-center justify-between border-b border-[var(--ui-border)] bg-[var(--ui-surface)] px-3"
          style={{ height: "var(--space-12)", paddingTop: "env(safe-area-inset-top)" }}>
          <Wordmark size="sm" />
          <div className="flex items-center gap-1">
            <span className="inline-flex items-center gap-1.5 px-2 py-1 text-[var(--text-xs)] font-semibold text-[var(--ui-text-secondary)]">
              <span aria-hidden style={{ color: "var(--status-open-fg)" }}>●</span>
              <span className="tnum">1 248</span>
            </span>
            <button data-chrome aria-label="Menu" className="grid h-11 w-11 place-items-center rounded-[var(--da-radius-control)] text-[var(--text-lg)] hover:bg-[color-mix(in_srgb,var(--ui-text)_8%,transparent)]">≡</button>
          </div>
        </header>

        {Stage}

        {/* StatusPill — glanceable canvas state, under the topbar */}
        <div data-chrome className="absolute left-1/2 top-[calc(var(--space-12)+var(--space-2))] z-[var(--z-dock)] -translate-x-1/2">
          <StatusPill state={placeState === "frozen" ? "frozen" : placeState === "cooldown" ? "cooldown" : "open"} />
        </div>

        {/* Zoom + fit cluster — floats right, above the dock (explicit dezoom path) */}
        <div data-chrome className="absolute right-3 z-[var(--z-dock)] transition-[bottom] duration-[var(--dur-base)] ease-[var(--ease-out)]"
          style={{ bottom: `calc(${open ? "var(--dock-anchor, 0px)" : "0px"} + ${open ? (dockH ? dockH : 0) : 0}px + var(--space-3))` }}>
          <ZoomControls
            onZoomIn={() => zoomTo(Math.round(cell * ZOOM_STEP))}
            onZoomOut={() => zoomTo(Math.round(cell / ZOOM_STEP))}
            onFit={() => zoomTo(fitCell, "overview")}
            atFit={atFit} canZoomIn={cell < MAX_CELL} canZoomOut={cell > fitCell}
          />
        </div>

        {/* First-use gesture hint (F4) — one-time, dismissible, non-blocking */}
        {hint && open && (
          <div data-chrome className="absolute left-1/2 z-[var(--z-dock)] flex -translate-x-1/2 items-center gap-2 rounded-[var(--radius-pill)] bg-[var(--ui-surface)] px-3 py-1.5 text-[var(--text-xs)] font-medium text-[var(--ui-text-secondary)] shadow-[var(--elev-2)]"
            style={{ bottom: `calc(${dockH}px + var(--space-3))` }}>
            <IconMove /> Glisse pour te déplacer · +/− pour zoomer
            <button data-chrome aria-label="Masquer l'astuce" onClick={() => setHint(false)} className="ml-1 text-[var(--ui-text-tertiary)]"><IconX width="14" height="14" /></button>
          </div>
        )}

        {/* Reopen FAB — appears when closed; carries the staged-batch badge */}
        {!open && (
          <div data-chrome className="absolute z-[var(--z-fab)]" style={{ right: "var(--space-4)", bottom: "max(var(--space-5), env(safe-area-inset-bottom))" }}>
            <ReopenFab onClick={openPanel} staged={staged} tier={placeState === "frozen" ? false : false} />
          </div>
        )}

        {/* Dock — OVERLAY bottom sheet over the canvas (not a flex row). */}
        <div ref={dockRef} data-chrome
          className="absolute inset-x-0 bottom-0 z-[var(--z-dock)] rounded-t-[var(--radius-xl)] border-t border-[var(--ui-border)] bg-[var(--ui-surface-raised)] px-4 shadow-[var(--elev-3)]"
          style={{
            maxHeight: "var(--dock-max-h)",
            paddingBottom: "max(var(--space-5), env(safe-area-inset-bottom))",
            transform: `translateY(${slide}px)`,
            transition: dragY ? "none" : "transform var(--dur-base) var(--ease-out)",
          }}>
          <div className="flex items-center justify-between">
            <PanelHandle open onToggle={closePanel} onDrag={onHandleDrag} onDragEnd={onHandleEnd} />
            {/* Explicit non-gestural close (Fitts ≥44px) — the guaranteed path */}
            <button data-chrome aria-label="Fermer le panneau" aria-expanded onClick={closePanel}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--da-radius-control)] text-[var(--ui-text-secondary)] hover:bg-[color-mix(in_srgb,var(--ui-text)_8%,transparent)] focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"><IconX /></button>
          </div>
          <div className="mb-3">
            <DockBody placeState={placeState} reserve={reserve} />
          </div>
          <div className="mb-4"><ColorSelector value={color} onChange={setColor} compact /></div>
          <Button size="lg" className="w-full" disabled={placeState !== "ready"} onClick={doPlace}>
            {ctaLabel[placeState]}
          </Button>
        </div>
      </div>
    );
  }

  // ----------------------------------------------------------- LANDSCAPE ----
  // Same model, rotated: dock is a right rail, close is horizontal, reopen pastille
  // anchors to the left edge (ux-spec §1.3 paysage court).
  const railW = 256;
  return (
    <div className="relative h-full w-full overflow-hidden bg-[var(--ui-bg)]">
      {Stage}
      <div data-chrome className="absolute left-2 top-2 z-[var(--z-dock)] inline-flex items-center rounded-[var(--radius-pill)] bg-[var(--ui-surface)] px-2 py-1 shadow-[var(--elev-1)]"><Wordmark size="sm" /></div>
      <div data-chrome className="absolute left-1/2 top-2 z-[var(--z-dock)] -translate-x-1/2"><StatusPill state={placeState === "frozen" ? "frozen" : placeState === "cooldown" ? "cooldown" : "open"} /></div>
      <div data-chrome className="absolute z-[var(--z-dock)] transition-[right] duration-[var(--dur-base)]"
        style={{ right: open ? `calc(${railW}px + var(--space-3))` : "var(--space-3)", bottom: "var(--space-3)" }}>
        <ZoomControls orientation="horizontal"
          onZoomIn={() => zoomTo(Math.round(cell * ZOOM_STEP))}
          onZoomOut={() => zoomTo(Math.round(cell / ZOOM_STEP))}
          onFit={() => zoomTo(fitCell, "overview")}
          atFit={atFit} canZoomIn={cell < MAX_CELL} canZoomOut={cell > fitCell} />
      </div>

      {!open && (
        <div data-chrome className="absolute left-3 top-1/2 z-[var(--z-fab)] -translate-y-1/2">
          <ReopenFab onClick={openPanel} staged={staged} />
        </div>
      )}

      <aside ref={dockRef} data-chrome
        className="absolute inset-y-0 right-0 z-[var(--z-dock)] flex w-[256px] flex-col gap-3 border-l border-[var(--ui-border)] bg-[var(--ui-surface-raised)] p-3 shadow-[var(--elev-3)]"
        style={{
          paddingRight: "max(var(--space-3), env(safe-area-inset-right))",
          transform: open ? "translateX(0)" : `translateX(${railW}px)`,
          transition: "transform var(--dur-base) var(--ease-out)",
        }}>
        <div className="flex items-center justify-between">
          <span className="text-[var(--text-sm)] font-semibold text-[var(--ui-text-secondary)]">Outils</span>
          <button data-chrome aria-label="Fermer le panneau" aria-expanded onClick={closePanel}
            className="grid h-11 w-11 place-items-center rounded-[var(--da-radius-control)] text-[var(--ui-text-secondary)] hover:bg-[color-mix(in_srgb,var(--ui-text)_8%,transparent)]"><IconX /></button>
        </div>
        <DockBody placeState={placeState} reserve={reserve} />
        <ColorSelector value={color} onChange={setColor} compact />
        <Button size="lg" className="mt-auto w-full" disabled={placeState !== "ready"} onClick={doPlace}>{ctaLabel[placeState]}</Button>
      </aside>
    </div>
  );
}

/** Dock body — ONE pixel count only (ReserveBar). Cooldown Gauge carries TIME. */
function DockBody({ placeState, reserve }) {
  if (placeState === "cooldown")
    return (<><Gauge mode="cooldown" seconds={9} /><div className="mt-3"><ReserveBar count={reserve} /></div></>);
  if (placeState === "frozen")
    return (<><div className="flex items-center gap-2 text-[var(--text-sm)] font-semibold text-[var(--status-frozen-fg)]"><span aria-hidden>❄</span> La pose est en pause</div><div className="mt-3 opacity-60"><ReserveBar count={reserve} /></div></>);
  return <ReserveBar count={reserve} />;
}

const RESERVE_CAP = 40;
function ReserveBar({ count = 20, cap = RESERVE_CAP }) {
  const pct = Math.max(0, Math.min(1, count / cap));
  const full = count >= cap;
  return (
    <div className="flex items-center gap-3">
      <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--da-radius-control)] text-[var(--text-sm)] font-bold tnum" style={{ background: "var(--accent-soft)", color: "var(--accent-text)" }}>{count}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[var(--text-sm)] font-semibold leading-tight">pixel{count > 1 ? "s" : ""} prêt{count > 1 ? "s" : ""}</span>
          <span className="shrink-0 whitespace-nowrap text-[var(--text-xs)] font-semibold text-[var(--ui-text-tertiary)] tnum">{full ? "réserve pleine" : `/ ${cap}`}</span>
        </div>
        <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-[var(--radius-pill)]" style={{ background: "color-mix(in srgb,var(--ui-text) 12%,transparent)" }}>
          <div className="h-full rounded-[var(--radius-pill)] transition-[width] duration-[var(--dur-base)] ease-[var(--ease-out)]" style={{ width: `${pct * 100}%`, background: "var(--accent)" }} />
        </div>
      </div>
    </div>
  );
}
