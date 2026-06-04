import { useState } from "react";
import FrescoCanvas from "./FrescoCanvas.jsx";
import Gauge from "./Gauge.jsx";
import ColorSelector from "./ColorSelector.jsx";
import StatusPill from "./StatusPill.jsx";
import Button from "./ui/Button.jsx";
import Wordmark from "./Wordmark.jsx";
import { PALETTE } from "../data/fresco.js";

/**
 * Canvas viewer — THE signature screen (cadrage §8.1.1), styled for real.
 * Structure is frozen by UX (WF-1 mobile / WF-2 desktop): canvas is king, the
 * unified place-state + tool dock sits at thumb reach on mobile / in a right
 * rail on desktop. We only dress it.
 *
 * `viewport` = "mobile" | "desktop" drives the two layouts.
 * `placeState` = "ready" | "cooldown" | "frozen" exercises the state matrix.
 */
export default function CanvasViewer({ viewport = "desktop", placeState = "ready" }) {
  const [color, setColor] = useState(PALETTE[4].hex); // red
  const [placedFx, setPlacedFx] = useState(null);
  const reticle = { x: 31, y: 19, hex: color };

  const doPlace = () => {
    setPlacedFx({ x: reticle.x, y: reticle.y, hex: color });
    setTimeout(() => setPlacedFx(null), 700);
  };

  const status =
    placeState === "frozen"
      ? <StatusPill state="frozen" />
      : placeState === "cooldown"
      ? <StatusPill state="cooldown" label="Recharge" />
      : <StatusPill state="open" />;

  // ---------------------------------------------------------------- MOBILE ---
  if (viewport === "mobile") {
    return (
      <div className="flex h-full w-full flex-col bg-[var(--ui-bg)]">
        {/* rang1 + nav — light, floats over the fresco */}
        <header className="flex items-center justify-between px-4 py-3">
          <Wordmark size="sm" />
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--ui-surface)] px-2.5 py-1 text-[var(--text-xs)] font-semibold shadow-[var(--elev-1)]">
              <span aria-hidden style={{ color: "var(--status-open-fg)" }}>●</span>
              <span className="tnum">1 248</span>
            </span>
            <button aria-label="Menu" className="grid h-9 w-9 place-items-center rounded-[var(--radius-md)] bg-[var(--ui-surface)] shadow-[var(--elev-1)]">≡</button>
          </div>
        </header>

        {/* fresco — primary object, fills */}
        <div className="relative flex-1 grid place-items-center overflow-hidden px-3">
          <div className="rounded-[var(--radius-md)] p-1.5 shadow-[var(--elev-2)]" style={{ background: "var(--canvas-frame)" }}>
            <FrescoCanvas cell={9} reticle={placeState === "ready" ? reticle : null} placedFx={placedFx} />
          </div>
          <div className="absolute left-1/2 top-4 -translate-x-1/2">{status}</div>
        </div>

        {/* dock — unified place-state + tools + POSER at thumb reach (WF-1) */}
        <div className="rounded-t-[var(--radius-xl)] bg-[var(--ui-surface)] px-4 pb-5 pt-3 shadow-[var(--elev-3)]">
          <div className="mx-auto mb-3 h-1 w-9 rounded-full" style={{ background: "var(--ui-border-strong)" }} />
          <div className="mb-3">
            {placeState === "cooldown"
              ? <Gauge mode="cooldown" seconds={9} />
              : placeState === "frozen"
              ? <div className="flex items-center gap-2 text-[var(--text-sm)] font-semibold text-[var(--status-frozen-fg)]"><span aria-hidden>❄</span> La pose est en pause</div>
              : <Gauge mode="ready" ready={3} max={4} />}
          </div>
          <div className="mb-4"><ColorSelector value={color} onChange={setColor} compact /></div>
          <Button size="lg" className="w-full" disabled={placeState !== "ready"} onClick={doPlace}>
            {placeState === "cooldown" ? "Attends la recharge" : placeState === "frozen" ? "Pose en pause" : "Poser ici"}
          </Button>
        </div>
      </div>
    );
  }

  // --------------------------------------------------------------- DESKTOP ---
  return (
    <div className="flex h-full w-full flex-col bg-[var(--ui-bg)]">
      {/* rang1 + rang3 top bar */}
      <header className="flex items-center justify-between border-b border-[var(--ui-border)] bg-[var(--ui-surface)] px-5 py-3">
        <div className="flex items-center gap-4">
          <Wordmark />
          <span className="text-[var(--text-sm)] text-[var(--ui-text-secondary)]">·</span>
          <span className="text-[var(--text-sm)] font-medium text-[var(--ui-text-secondary)]">Fresque de la commu</span>
          {status}
        </div>
        <div className="flex items-center gap-4 text-[var(--text-sm)]">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <span aria-hidden style={{ color: "var(--status-open-fg)" }}>●</span>
            <span className="tnum">1 248</span><span className="text-[var(--ui-text-secondary)] font-normal">regardent</span>
          </span>
          <nav className="flex items-center gap-1">
            <button className="rounded-[var(--da-radius-control)] px-3 py-1.5 font-medium hover:bg-[color-mix(in_srgb,var(--ui-text)_8%,transparent)]">Galerie</button>
            <button className="rounded-[var(--da-radius-control)] px-3 py-1.5 font-medium hover:bg-[color-mix(in_srgb,var(--ui-text)_8%,transparent)]">Profil</button>
          </nav>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* fresco stage */}
        <div className="relative grid flex-1 place-items-center overflow-hidden p-6">
          <div className="rounded-[var(--radius-lg)] p-2 shadow-[var(--elev-2)]" style={{ background: "var(--canvas-frame)" }}>
            <FrescoCanvas cell={14} reticle={placeState === "ready" ? reticle : null} placedFx={placedFx} />
          </div>
        </div>

        {/* right rail — palette, place-state, points, leaderboard (WF-2) */}
        <aside className="flex w-[312px] shrink-0 flex-col gap-4 border-l border-[var(--ui-border)] bg-[var(--ui-surface)] p-4">
          <ColorSelector value={color} onChange={setColor} />
          <div className="rounded-[var(--da-radius-card)] border border-[var(--ui-border)] bg-[var(--ui-surface-raised)] p-3 shadow-[var(--elev-1)]">
            {placeState === "cooldown"
              ? <Gauge mode="cooldown" seconds={9} />
              : placeState === "frozen"
              ? <div className="flex items-center gap-2 text-[var(--text-sm)] font-semibold text-[var(--status-frozen-fg)]"><span aria-hidden>❄</span> La pose est en pause</div>
              : <Gauge mode="ready" ready={3} max={4} />}
            <Button className="mt-3 w-full" disabled={placeState !== "ready"} onClick={doPlace}>
              {placeState === "cooldown" ? "Attends la recharge" : placeState === "frozen" ? "Pose en pause" : "Poser (clic sur la case)"}
            </Button>
          </div>
          {/* rang2 — points → réserve (clarifies défi 2) */}
          <div className="rounded-[var(--da-radius-card)] border border-[var(--ui-border)] p-3">
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-xs)] font-semibold uppercase tracking-wide text-[var(--ui-text-tertiary)]">Tes points</span>
              <span className="text-[var(--text-sm)] font-bold tnum">320</span>
            </div>
            <p className="mt-1 text-[var(--text-xs)] text-[var(--ui-text-secondary)]">Tes points agrandissent ta réserve : +1 pixel max.</p>
          </div>
          {/* rang3 — leaderboard, light */}
          <div className="rounded-[var(--da-radius-card)] border border-[var(--ui-border)] p-3">
            <span className="text-[var(--text-xs)] font-semibold uppercase tracking-wide text-[var(--ui-text-tertiary)]">Classement</span>
            <ol className="mt-2 space-y-1.5 text-[var(--text-sm)]">
              {[["pixelmancer", 412], ["lea_", 320], ["maxxx", 287]].map(([n, p], i) => (
                <li key={n} className="flex items-center justify-between">
                  <span className="flex items-center gap-2"><span className="tnum w-4 text-[var(--ui-text-tertiary)]">{i + 1}</span>{n}</span>
                  <span className="tnum font-semibold">{p}</span>
                </li>
              ))}
            </ol>
          </div>
        </aside>
      </div>
    </div>
  );
}
