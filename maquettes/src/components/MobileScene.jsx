import { useState } from "react";
import FrescoCanvas from "./FrescoCanvas.jsx";
import Gauge from "./Gauge.jsx";
import ColorSelector from "./ColorSelector.jsx";
import StatusPill from "./StatusPill.jsx";
import Button from "./ui/Button.jsx";
import Wordmark from "./Wordmark.jsx";
import { PALETTE } from "../data/fresco.js";

/**
 * MobileScene — the REFONTE MOBILE target (FEN-337), Arcade identity.
 *
 * This is the design "truth": one connected app surface (fixes D1 "trois cartes
 * déconnectées"), not three floating islands on dead grey. Built only from the
 * Foundation components + tokens already in the prod app (Wordmark / StatusPill /
 * Gauge / ColorSelector / Button / FrescoCanvas) so the handoff is a re-layout,
 * never new hardcoded values (AC-5).
 *
 *   orientation = "portrait" | "landscape"
 *   placeState  = "ready" | "cooldown" | "frozen"
 *   reserve     = N pixels available (proves the dock never overflows for any N)
 *
 * Defect → fix map (ideation FEN-336):
 *   A1-A7  topbar → one slim opaque bar, wordmark + discrete live count + ≡ menu;
 *          no destructive action exposed (AC-3).
 *   B1-B5  canvas → full-bleed framed stage, king of the screen (AC-4).
 *   C1-C7  dock   → ReserveBar is a BOUNDED meter (count + capacity bar), never a
 *          per-pixel row that spills the edges; POSER at thumb reach (AC-1/2).
 *   D1-D5  system → connected bars, Arcade accent frame + display wordmark (AC-7).
 */

const RESERVE_CAP = 40; // reserve fills to a cap → the bar width is constant for any N

/**
 * ReserveBar — THE overflow fix (défaut #1 d'Alexis, AC-2). The reserve of pixels
 * is shown as a compact COUNT + a bounded capacity meter, so N=20 and N=40 render
 * at the exact same width and can never touch the container edges. No row of N
 * squares scaling with N (the old overflow). Color-independent: number + label +
 * fill length carry the meaning, icon is decorative (§6).
 */
function ReserveBar({ count = 20, cap = RESERVE_CAP }) {
  const pct = Math.max(0, Math.min(1, count / cap));
  const full = count >= cap;
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden
        className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--da-radius-control)] text-[var(--text-sm)] font-bold tnum"
        style={{ background: "var(--accent-soft)", color: "var(--accent-text)" }}
      >
        {count}
      </span>
      <div className="min-w-0 flex-1">
        {/* The COUNT lives once (in the chip); the label never repeats it — fixes
            the C4 "double représentation" defect (20 said twice). */}
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[var(--text-sm)] font-semibold leading-tight">
            pixel{count > 1 ? "s" : ""} prêt{count > 1 ? "s" : ""}
          </span>
          <span className="shrink-0 whitespace-nowrap text-[var(--text-xs)] font-semibold text-[var(--ui-text-tertiary)] tnum">
            {full ? "réserve pleine" : `/ ${cap}`}
          </span>
        </div>
        {/* Bounded capacity meter — fixed track, proportional fill. Cannot overflow. */}
        <div
          className="mt-1.5 h-2.5 w-full overflow-hidden rounded-[var(--radius-pill)]"
          style={{ background: "color-mix(in srgb,var(--ui-text) 12%,transparent)" }}
        >
          <div
            className="h-full rounded-[var(--radius-pill)] transition-[width] duration-[var(--dur-base)] ease-[var(--ease-out)]"
            style={{ width: `${pct * 100}%`, background: "var(--accent)" }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The dock body (rang 1+2) — ONE pixel count only (the ReserveBar). The cooldown
 * Gauge carries TIME ("+1 dans 0:09"), never a second stock number, so the C4
 * double-count never returns. Reused in portrait dock + landscape rail.
 */
function DockBody({ placeState, reserve }) {
  if (placeState === "cooldown")
    return (
      <>
        <Gauge mode="cooldown" seconds={9} />
        <div className="mt-3"><ReserveBar count={reserve} /></div>
      </>
    );
  if (placeState === "frozen")
    return (
      <>
        <div className="flex items-center gap-2 text-[var(--text-sm)] font-semibold text-[var(--status-frozen-fg)]">
          <span aria-hidden>❄</span> La pose est en pause
        </div>
        <div className="mt-3 opacity-60"><ReserveBar count={reserve} /></div>
      </>
    );
  return <ReserveBar count={reserve} />;
}

function ViewerChip({ count = 1248 }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] px-2 py-1 text-[var(--text-xs)] font-semibold text-[var(--ui-text-secondary)]">
      <span aria-hidden style={{ color: "var(--status-open-fg)" }}>●</span>
      <span className="tnum">{count.toLocaleString("fr-FR")}</span>
    </span>
  );
}

function MenuButton() {
  return (
    <button
      aria-label="Menu — Galerie, Comment ça marche, Langue, Se déconnecter"
      className="grid h-11 w-11 place-items-center rounded-[var(--da-radius-control)] text-[var(--text-lg)] text-[var(--ui-text)] hover:bg-[color-mix(in_srgb,var(--ui-text)_8%,transparent)]"
    >
      ≡
    </button>
  );
}

const ctaLabel = { ready: "Poser ici", cooldown: "Attends la recharge", frozen: "Pose en pause" };

export default function MobileScene({ orientation = "portrait", placeState = "ready", reserve = 20 }) {
  const [color, setColor] = useState(PALETTE[4].hex); // red default
  const [placedFx, setPlacedFx] = useState(null);
  const reticle = { x: 33, y: 18, hex: color };

  const doPlace = () => {
    if (placeState !== "ready") return;
    setPlacedFx({ x: reticle.x, y: reticle.y, hex: color });
    setTimeout(() => setPlacedFx(null), 700);
  };

  // Canvas stage — full-bleed, zoomed into a busy region so the board reads as a
  // LIVE collaborative canvas (fixes B1 "écran cassé"), framed Arcade.
  const stage = (cell, offsetX, offsetY) => (
    <div className="relative h-full w-full overflow-hidden" style={{ background: "var(--canvas-field)" }}>
      <div className="absolute" style={{ left: offsetX, top: offsetY }}>
        <FrescoCanvas cell={cell} reticle={placeState === "ready" ? reticle : null} placedFx={placedFx} />
      </div>
      {/* Arcade frame — accent hairline inset so the canvas reads as a framed stage,
          never bleeds into chrome; neutral elsewhere (§5.1). */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ boxShadow: "inset 0 0 0 2px var(--accent), inset 0 0 0 4px var(--ui-bg)" }}
      />
    </div>
  );

  // ----------------------------------------------------------- LANDSCAPE ---
  if (orientation === "landscape") {
    return (
      <div className="flex h-full w-full bg-[var(--ui-bg)]">
        <div className="relative min-w-0 flex-1">
          {stage(15, -250, -150)}
          {/* Floating chrome overlays the canvas to spare vertical height (AC-8). */}
          <div className="absolute left-2 top-2 inline-flex items-center rounded-[var(--radius-pill)] bg-[var(--ui-surface)] px-2 py-1 shadow-[var(--elev-1)]">
            <Wordmark size="sm" />
          </div>
          <div className="absolute right-2 top-2 flex items-center gap-1 rounded-[var(--radius-pill)] bg-[var(--ui-surface)] px-1 shadow-[var(--elev-1)]">
            <ViewerChip />
            <MenuButton />
          </div>
          <div className="absolute left-1/2 top-2 -translate-x-1/2">
            <StatusPill state={placeState === "frozen" ? "frozen" : placeState === "cooldown" ? "cooldown" : "open"} />
          </div>
        </div>
        {/* Right rail — all controls, thumb reach on the right edge. */}
        <aside
          className="flex w-[256px] shrink-0 flex-col gap-3 border-l border-[var(--ui-border)] bg-[var(--ui-surface-raised)] p-3"
          style={{ paddingRight: "max(var(--space-3), env(safe-area-inset-right))" }}
        >
          <DockBody placeState={placeState} reserve={reserve} />
          <ColorSelector value={color} onChange={setColor} compact />
          <Button size="lg" className="mt-auto w-full" disabled={placeState !== "ready"} onClick={doPlace}>
            {ctaLabel[placeState]}
          </Button>
        </aside>
      </div>
    );
  }

  // ------------------------------------------------------------- PORTRAIT ---
  return (
    <div className="flex h-full w-full flex-col bg-[var(--ui-bg)]">
      {/* TopBar — one slim opaque bar (fixes A1 dead margins / D1 islands). */}
      <header
        className="flex shrink-0 items-center justify-between border-b border-[var(--ui-border)] bg-[var(--ui-surface)] px-3"
        style={{ height: "var(--space-12)", paddingTop: "env(safe-area-inset-top)" }}
      >
        <Wordmark size="sm" />
        <div className="flex items-center gap-1">
          <ViewerChip />
          <MenuButton />
        </div>
      </header>

      {/* Canvas — king, fills all remaining height (fixes B2/B5/D3). The crop
          zooms into the busy middle so painted cells cover the whole stage (no
          dead grey beyond the fresco edge). */}
      <div className="relative min-h-0 flex-1">
        {stage(20, -380, -150)}
        <div className="absolute left-1/2 top-3 -translate-x-1/2">
          <StatusPill state={placeState === "frozen" ? "frozen" : placeState === "cooldown" ? "cooldown" : "open"} />
        </div>
      </div>

      {/* Dock — thumb zone, safe-bottom, one connected sheet. */}
      <div
        className="shrink-0 rounded-t-[var(--radius-xl)] border-t border-[var(--ui-border)] bg-[var(--ui-surface-raised)] px-4 pt-3 shadow-[var(--elev-3)]"
        style={{ paddingBottom: "max(var(--space-5), env(safe-area-inset-bottom))" }}
      >
        <div className="mx-auto mb-3 h-1 w-9 rounded-full" style={{ background: "var(--ui-border-strong)" }} />
        <div className="mb-3"><DockBody placeState={placeState} reserve={reserve} /></div>
        <div className="mb-4"><ColorSelector value={color} onChange={setColor} compact /></div>
        <Button size="lg" className="w-full" disabled={placeState !== "ready"} onClick={doPlace}>
          {ctaLabel[placeState]}
        </Button>
      </div>
    </div>
  );
}
