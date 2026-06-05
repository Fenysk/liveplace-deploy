import { useEffect, useState } from "react";
import CanvasViewer from "./components/CanvasViewer.jsx";
import Onboarding from "./screens/Onboarding.jsx";
import Dashboard from "./screens/Dashboard.jsx";
import Celebration from "./screens/Celebration.jsx";
import ObsView from "./screens/ObsView.jsx";
import StatesBoard from "./screens/StatesBoard.jsx";

/**
 * Maquettes preview — FEN-204. Alexis a tranché au gate FEN-196 : direction
 * retenue = ARCADE ("Arcade Fun"). On décline cette direction sur tout
 * l'écosystème. Le sélecteur de direction reste (référence/contrôle) mais part
 * sur Arcade par défaut, et la déclinaison signature vit dans le sélecteur
 * d'écrans (Surface).
 */
const DIRECTIONS = [
  { id: "fun",      name: "Arcade",  tag: "Retenue ✓", accent: "#ef4d3a" },
  { id: "sobre",    name: "Studio",  tag: "Réf.",      accent: "#4b4ea6" },
  { id: "intuitif", name: "Aurora",  tag: "Réf.",      accent: "#0e9e87" },
];

const SURFACES = [
  { id: "viewer",      label: "Canvas viewer",  vp: true,  render: (vp, st) => <CanvasViewer viewport={vp} placeState={st} /> },
  { id: "onboarding",  label: "Onboarding",     vp: true,  render: (vp) => <Onboarding viewport={vp} /> },
  { id: "dashboard",   label: "Dashboard",      vp: true,  render: (vp) => <Dashboard viewport={vp} /> },
  { id: "celebration", label: "Célébration",    vp: true,  render: (vp) => <Celebration viewport={vp} /> },
  { id: "obs",         label: "Vue OBS",        vp: true,  render: (vp) => <ObsView viewport={vp} /> },
  { id: "states",      label: "États",          vp: false, render: () => <StatesBoard /> },
];

function Segmented({ options, value, onChange, label }) {
  return (
    <div role="group" aria-label={label} className="inline-flex flex-wrap rounded-[10px] bg-[#e7e7ea] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className="rounded-[8px] px-3 py-1.5 text-[13px] font-semibold transition-colors"
          style={value === o.value
            ? { background: "#fff", color: "#18181c", boxShadow: "0 1px 2px rgba(0,0,0,.08)" }
            : { color: "#52525b" }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const [direction, setDirection] = useState("fun");   // Arcade = retenue
  const [surface, setSurface] = useState("viewer");
  const [viewport, setViewport] = useState("desktop");
  const [placeState, setPlaceState] = useState("ready");

  useEffect(() => {
    document.documentElement.setAttribute("data-direction", direction);
  }, [direction]);

  const active = DIRECTIONS.find((d) => d.id === direction);
  const surf = SURFACES.find((s) => s.id === surface);
  const showState = surface === "viewer";

  return (
    <div className="min-h-full" style={{ background: "#dddde1", fontFamily: "Inter, system-ui, sans-serif", color: "#18181c" }}>
      {/* ---- Preview chrome (neutral; NOT part of the product) ---------------- */}
      <div className="sticky top-0 z-20 border-b border-[#cfcfd4] bg-[#f0f0f2]/95 px-5 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded-[6px] text-[12px] font-black text-white" style={{ background: active.accent }}>L</span>
            <strong className="text-[15px]">LivePlace — déclinaison Arcade</strong>
            <span className="rounded-[var(--radius-pill)] bg-[#e7e7ea] px-2 py-0.5 text-[11px] font-semibold text-[#52525b]">FEN-204 · preview local</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <label className="flex items-center gap-2 text-[12px] font-semibold text-[#52525b]">Écran
              <Segmented label="Surface" value={surface} onChange={setSurface}
                options={SURFACES.map((s) => ({ value: s.id, label: s.label }))} />
            </label>
            {surf.vp && (
              <label className="flex items-center gap-2 text-[12px] font-semibold text-[#52525b]">Viewport
                <Segmented label="Viewport" value={viewport} onChange={setViewport}
                  options={[{ value: "desktop", label: "Desktop 1440" }, { value: "mobile", label: "Mobile 390" }]} />
              </label>
            )}
            {showState && (
              <label className="flex items-center gap-2 text-[12px] font-semibold text-[#52525b]">État
                <Segmented label="État de pose" value={placeState} onChange={setPlaceState}
                  options={[{ value: "ready", label: "Prêt" }, { value: "cooldown", label: "Cooldown" }, { value: "frozen", label: "Gelé" }]} />
              </label>
            )}
            <label className="flex items-center gap-2 text-[12px] font-semibold text-[#52525b]">Direction
              <Segmented label="Direction artistique" value={direction} onChange={setDirection}
                options={DIRECTIONS.map((d) => ({ value: d.id, label: `${d.name} · ${d.tag}` }))} />
            </label>
          </div>
        </div>
      </div>

      {/* ---- The rendered maquette (real React + Tailwind + tokens) ---------- */}
      <div className="mx-auto max-w-[1400px] px-5 py-5">
        <div
          data-testid="maquette"
          className="mx-auto overflow-hidden rounded-[16px] border border-[#cfcfd4] shadow-[0_8px_24px_rgba(24,24,28,.12)]"
          style={surf.vp && viewport === "mobile"
            ? { width: 390, height: 844 }
            : surf.vp
            ? { width: "100%", height: 820 }
            : { width: "100%" }}
        >
          {surf.render(viewport, placeState)}
        </div>
        <p className="mt-3 text-center text-[12px] text-[#6c6c76]">
          Surface : <strong>{surf.label}</strong>
          {surf.vp ? <> · {viewport === "mobile" ? "390×844" : "1440×900"}</> : null}
          {" "}· direction <strong>{active.name}</strong>{showState ? <> · état <strong>{placeState}</strong></> : null}
        </p>
      </div>
    </div>
  );
}
