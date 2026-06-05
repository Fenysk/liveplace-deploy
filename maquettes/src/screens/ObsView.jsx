import FrescoCanvas from "../components/FrescoCanvas.jsx";
import Gauge from "../components/Gauge.jsx";

/**
 * Vue OBS — signature screen (cadrage §8.1.5 / §5.3). The browser-source overlay
 * a streamer drops on their scene. Hard constraints:
 *   - TRANSPARENT background (the real source has no fill — here we composite it
 *     over a faux gameplay capture to PROVE it reads on any stream).
 *   - Functional outline = --elev-obs: a 2px dark ring + soft shadow that
 *     survives video compression (no detail thinner than 2px, §5.3).
 *   - Glanceable HUD only — no controls (viewers interact in the LivePlace app,
 *     not in OBS). Count + cooldown are the only live data.
 * `bg` prop simulates different stream backdrops to stress the contour.
 */
const BACKDROPS = {
  game:  "linear-gradient(135deg,#1b2735,#3a2a4d 60%,#52323e)",
  bright:"linear-gradient(135deg,#e9eef5,#cfd8e6 60%,#bcc6d6)",
  irl:   "linear-gradient(135deg,#2d2620,#4a3a2a 55%,#6b5333)",
};

function ObsOverlay({ scale = 1 }) {
  // Everything here is what ships in the transparent source.
  return (
    <div className="inline-flex flex-col gap-2" style={{ transform: `scale(${scale})`, transformOrigin: "bottom left" }}>
      {/* fresco panel — the only opaque object, wrapped in the OBS contour */}
      <div
        className="rounded-[var(--radius-md)] p-1.5"
        style={{ background: "var(--canvas-frame)", boxShadow: "var(--elev-obs)" }}
      >
        <FrescoCanvas cell={6} />
      </div>
      {/* HUD chips — each self-contained with the OBS contour so it reads on ANY bg */}
      <div className="flex items-center gap-2">
        <span
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] px-2.5 py-1 text-[var(--text-xs)] font-bold text-white"
          style={{ background: "rgba(20,22,28,.82)", boxShadow: "var(--elev-obs)" }}
        >
          <span aria-hidden style={{ color: "#36d07a" }}>●</span> EN DIRECT
        </span>
        <span
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] px-2.5 py-1 text-[var(--text-xs)] font-bold tnum text-white"
          style={{ background: "rgba(20,22,28,.82)", boxShadow: "var(--elev-obs)" }}
        >
          396 joueurs · 8 530 px
        </span>
        <span
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] px-2.5 py-1 text-[var(--text-xs)] font-black text-white"
          style={{ background: "var(--accent)", boxShadow: "var(--elev-obs)" }}
        >
          liveplace.tv
        </span>
      </div>
    </div>
  );
}

export default function ObsView({ viewport = "desktop", bg = "game" }) {
  return (
    <div className="flex h-full w-full flex-col">
      {/* checkerboard strip = "this background is actually transparent" legend */}
      <div className="flex items-center gap-3 border-b border-[var(--ui-border)] bg-[var(--ui-surface)] px-4 py-2 text-[var(--text-xs)] text-[var(--ui-text-secondary)]">
        <span
          className="inline-block h-4 w-6 rounded-[3px]"
          style={{ backgroundImage: "conic-gradient(#cfcfd4 90deg,#fff 0 180deg,#cfcfd4 0 270deg,#fff 0)", backgroundSize: "8px 8px" }}
        />
        Source OBS = <strong>fond transparent</strong> · contour <code>--elev-obs</code> (≥2px, survit la compression). Composé ici sur un faux stream pour preuve.
      </div>

      {/* faux stream capture with the transparent overlay composited bottom-left */}
      <div className="relative flex-1 overflow-hidden" style={{ background: BACKDROPS[bg] }}>
        <div className="absolute inset-0 grid grid-cols-6 opacity-[0.06]">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="border-r border-white/40" />)}
        </div>
        <div className="absolute bottom-5 left-5">
          <ObsOverlay scale={viewport === "mobile" ? 0.78 : 1.05} />
        </div>
        <span className="absolute right-4 top-3 rounded-[var(--radius-sm)] bg-black/40 px-2 py-1 text-[var(--text-xs)] font-semibold text-white/80">
          Capture de gameplay (exemple)
        </span>
      </div>
    </div>
  );
}
