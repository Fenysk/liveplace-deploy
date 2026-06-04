import { useEffect, useState } from "react";
import CanvasViewer from "./components/CanvasViewer.jsx";

const DIRECTIONS = [
  { id: "sobre",    name: "Studio",  tag: "Sobre",          accent: "#4b4ea6",
    blurb: "Canvas roi poussé au max. Chrome neutre quasi-monochrome, un seul accent encre-indigo, calme structurel. Inter. Reco par défaut : ne se démode pas, sert la fresque." },
  { id: "fun",      name: "Arcade",  tag: "Fun",            accent: "#ef4d3a",
    blurb: "Le clin d'œil pixel-art, dosé. Accents nets, corail énergique + ambre, coins carrés sur les éléments signature. Press Start 2P pour le wordmark seul. Le « fun » dans le feedback." },
  { id: "intuitif", name: "Aurora",  tag: "Ultra-intuitif", accent: "#0e9e87",
    blurb: "Lisibilité + affordance maximales. Grandes cibles arrondies, accent menthe amical, élévation douce. Optimisé Hick/Fitts pour la néophyte. Nunito arrondi." },
];

function Segmented({ options, value, onChange, label }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-[10px] bg-[#e7e7ea] p-0.5">
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
  const [direction, setDirection] = useState("sobre");
  const [viewport, setViewport] = useState("desktop");
  const [placeState, setPlaceState] = useState("ready");

  useEffect(() => {
    document.documentElement.setAttribute("data-direction", direction);
  }, [direction]);

  const active = DIRECTIONS.find((d) => d.id === direction);

  return (
    <div className="min-h-full" style={{ background: "#dddde1", fontFamily: "Inter, system-ui, sans-serif", color: "#18181c" }}>
      {/* ---- Preview chrome (neutral; NOT part of the product) ---------------- */}
      <div className="sticky top-0 z-20 border-b border-[#cfcfd4] bg-[#f0f0f2]/95 px-5 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded-[6px] text-[12px] font-black text-white" style={{ background: active.accent }}>L</span>
            <strong className="text-[15px]">LivePlace — maquettes</strong>
            <span className="rounded-[var(--radius-pill)] bg-[#e7e7ea] px-2 py-0.5 text-[11px] font-semibold text-[#52525b]">preview local · test-liveplace.nas</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <label className="flex items-center gap-2 text-[12px] font-semibold text-[#52525b]">Direction
              <Segmented label="Direction artistique" value={direction} onChange={setDirection}
                options={DIRECTIONS.map((d) => ({ value: d.id, label: `${d.name} · ${d.tag}` }))} />
            </label>
            <label className="flex items-center gap-2 text-[12px] font-semibold text-[#52525b]">Écran
              <Segmented label="Viewport" value={viewport} onChange={setViewport}
                options={[{ value: "desktop", label: "Desktop 1440" }, { value: "mobile", label: "Mobile 390" }]} />
            </label>
            <label className="flex items-center gap-2 text-[12px] font-semibold text-[#52525b]">État
              <Segmented label="État de pose" value={placeState} onChange={setPlaceState}
                options={[{ value: "ready", label: "Prêt" }, { value: "cooldown", label: "Cooldown" }, { value: "frozen", label: "Gelé" }]} />
            </label>
          </div>
        </div>
      </div>

      {/* ---- Direction intention card --------------------------------------- */}
      <div className="mx-auto max-w-[1400px] px-5 pt-5">
        <div className="flex items-start gap-3 rounded-[12px] border border-[#cfcfd4] bg-white p-4">
          <span className="mt-0.5 h-9 w-9 shrink-0 rounded-[8px]" style={{ background: active.accent }} />
          <div>
            <div className="flex items-center gap-2">
              <strong className="text-[15px]">Direction « {active.name} »</strong>
              <span className="rounded-[var(--radius-pill)] px-2 py-0.5 text-[11px] font-bold text-white" style={{ background: active.accent }}>{active.tag}</span>
            </div>
            <p className="mt-1 max-w-[900px] text-[13px] leading-relaxed text-[#52525b]">{active.blurb}</p>
          </div>
        </div>
      </div>

      {/* ---- The rendered maquette (real React + Tailwind + tokens) ---------- */}
      <div className="mx-auto max-w-[1400px] px-5 py-5">
        <div
          data-testid="maquette"
          className="mx-auto overflow-hidden rounded-[16px] border border-[#cfcfd4] shadow-[0_8px_24px_rgba(24,24,28,.12)]"
          style={viewport === "mobile"
            ? { width: 390, height: 844 }
            : { width: "100%", height: 820 }}
        >
          <CanvasViewer viewport={viewport} placeState={placeState} />
        </div>
        <p className="mt-3 text-center text-[12px] text-[#6c6c76]">
          Surface : <strong>Canvas viewer</strong> · {viewport === "mobile" ? "390×844" : "1440×900"} · direction <strong>{active.name}</strong> · état <strong>{placeState}</strong>
        </p>
      </div>
    </div>
  );
}
