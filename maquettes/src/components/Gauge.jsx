// Gauge + cooldown countdown — the unified "place state" (WF-1/WF-2 rang1).
// Reprises the parked visual-cooldown work (FEN-169 / FEN-171).
// Glanceable <1s (§5.2). Two modes:
//   ready    → "N pixels prêts", segmented reserve filled
//   cooldown → "Recharge 0:09", a draining ring + live countdown (prévenir, C2)
// Color-independent: count + label + segment shapes carry the meaning, not hue.

function Segments({ filled, total }) {
  return (
    <div className="flex items-center gap-1" aria-hidden>
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className="h-2 w-4 rounded-[2px] transition-colors duration-[var(--dur-base)]"
          style={{
            background: i < filled ? "var(--accent)" : "color-mix(in srgb,var(--ui-text) 12%,transparent)",
          }}
        />
      ))}
    </div>
  );
}

export default function Gauge({ mode = "ready", ready = 3, max = 4, seconds = 9, nextLabel }) {
  if (mode === "cooldown") {
    const pct = Math.max(0, Math.min(1, seconds / 30));
    const mm = Math.floor(seconds / 60);
    const ss = String(seconds % 60).padStart(2, "0");
    return (
      <div className="flex items-center gap-3">
        <div className="relative h-11 w-11 shrink-0">
          <svg viewBox="0 0 44 44" className="h-11 w-11 -rotate-90">
            <circle cx="22" cy="22" r="18" fill="none" stroke="color-mix(in srgb,var(--ui-text) 12%,transparent)" strokeWidth="4" />
            <circle
              cx="22" cy="22" r="18" fill="none" stroke="var(--status-cooldown-fg)" strokeWidth="4"
              strokeLinecap="round" strokeDasharray={Math.PI * 2 * 18}
              strokeDashoffset={(1 - pct) * Math.PI * 2 * 18}
              style={{ transition: "stroke-dashoffset 1s linear" }}
            />
          </svg>
          <span aria-hidden className="absolute inset-0 grid place-items-center text-[12px]">⏳</span>
        </div>
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[var(--text-lg)] font-bold tnum leading-none">{mm}:{ss}</span>
            <span className="text-[var(--text-xs)] font-semibold text-[var(--status-cooldown-fg)]">Recharge</span>
          </div>
          <div className="text-[var(--text-xs)] text-[var(--ui-text-secondary)] mt-0.5">
            {nextLabel || "prochaine +1 pixel"}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <div
        className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-md)] text-[var(--text-lg)] font-bold tnum"
        style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
      >
        {ready}
      </div>
      <div>
        <div className="text-[var(--text-sm)] font-semibold leading-tight">
          {ready} pixel{ready > 1 ? "s" : ""} prêt{ready > 1 ? "s" : ""}
        </div>
        <div className="mt-1.5"><Segments filled={ready} total={max} /></div>
      </div>
    </div>
  );
}
