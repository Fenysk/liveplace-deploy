// Brand wordmark — a "live pixel" mark + word. The square pixel reads as the
// brand accent inside any fresco; the dot doubles as a live-state signifier.
// Display face follows the active direction (--font-display).
export default function Wordmark({ size = "md" }) {
  const px = size === "sm" ? 10 : size === "lg" ? 18 : 13;
  const text = size === "sm" ? "var(--text-sm)" : size === "lg" ? "var(--text-xl)" : "var(--text-base)";
  return (
    <span className="inline-flex items-center gap-2 leading-none select-none">
      <span className="relative inline-block" style={{ width: px, height: px }} aria-hidden>
        <span className="absolute inset-0 rounded-[2px]" style={{ background: "var(--accent)" }} />
        <span className="absolute rounded-[1px]" style={{ inset: px * 0.28, background: "var(--accent-onAccent)", opacity: .9 }} />
      </span>
      <span style={{ fontFamily: "var(--font-display)", fontSize: text }} className="font-bold tracking-tight">
        Live<span style={{ color: "var(--accent)" }}>Place</span>
      </span>
    </span>
  );
}
