// ZoomControls — the EXPLICIT path to zoom + fit-to-screen (AC-R2-3, F3/F4). Pinch
// alone is not discoverable (touch-action:none kills native pinch), so we give a
// visible cluster: zoom in / zoom out / "voir toute la fresque" (fit). The fit button
// is the discoverable route to the new extended dezoom floor. ≥44px targets, neutral
// chrome (chromatic neutrality §5.1), floats over the canvas like the OBS pattern.
//
//   onZoomIn / onZoomOut / onFit  callbacks
//   atFit   true ⇒ fit button reads as active (already showing the whole fresco)
//   canZoomOut / canZoomIn  disable at bounds (no hard rebound, ux-spec §3.2)
function ZBtn({ label, disabled, active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active || undefined}
      className="grid place-items-center text-[var(--text-lg)] font-bold text-[var(--ui-text)] transition-colors duration-[var(--dur-fast)] hover:bg-[color-mix(in_srgb,var(--ui-text)_8%,transparent)] disabled:opacity-40 focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
      style={{
        width: "var(--zoom-btn)",
        height: "var(--zoom-btn)",
        background: active ? "var(--accent-soft)" : "transparent",
        color: active ? "var(--accent-text)" : "var(--ui-text)",
      }}
    >
      {children}
    </button>
  );
}

export default function ZoomControls({
  onZoomIn, onZoomOut, onFit, atFit = false, canZoomIn = true, canZoomOut = true,
  orientation = "vertical",
}) {
  return (
    <div
      role="group"
      aria-label="Zoom"
      className={`inline-flex ${orientation === "vertical" ? "flex-col" : "flex-row"} overflow-hidden rounded-[var(--da-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface)] shadow-[var(--elev-2)]`}
    >
      <ZBtn label="Zoomer" onClick={onZoomIn} disabled={!canZoomIn}>+</ZBtn>
      <span
        aria-hidden
        className={orientation === "vertical" ? "h-px w-full" : "h-full w-px"}
        style={{ background: "var(--ui-border)" }}
      />
      <ZBtn label="Dézoomer" onClick={onZoomOut} disabled={!canZoomOut}>−</ZBtn>
      <span
        aria-hidden
        className={orientation === "vertical" ? "h-px w-full" : "h-full w-px"}
        style={{ background: "var(--ui-border)" }}
      />
      {/* Fit-to-screen — the discoverable route to the extended dezoom floor. */}
      <ZBtn label="Voir toute la fresque" onClick={onFit} active={atFit}>⊡</ZBtn>
    </div>
  );
}
