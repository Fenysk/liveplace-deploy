// ReopenFab — the persistent signifier that keeps "panel closed" from being a
// dead-end (AC-R2-1, Nielsen #3 user control). Anchored in the thumb zone, ≥44px
// (Fitts / WCAG 2.5.5). When a batch is staged or a tier is pending while the panel
// is closed, it carries a badge ("N en cours" / "palier !") so closing never silently
// swallows work (Zeigarnik — unfinished task stays signalled, ux-spec §1.3).
//
//   onClick()  reopen the panel
//   staged     N staged pixels (badge count); 0 = no badge
//   tier       true ⇒ a tier is pending to claim (overrides count with "!")
export default function ReopenFab({ onClick, staged = 0, tier = false }) {
  const showBadge = tier || staged > 0;
  const badge = tier ? "!" : staged > 99 ? "99+" : String(staged);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={
        tier
          ? "Ouvrir le panneau — un palier est à encaisser"
          : staged > 0
          ? `Ouvrir le panneau — ${staged} pixel${staged > 1 ? "s" : ""} en cours`
          : "Ouvrir le panneau"
      }
      className="relative grid place-items-center rounded-[var(--radius-pill)] text-[var(--accent-onAccent)] shadow-[var(--elev-3)] transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)] active:scale-[.96] focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
      style={{
        width: "calc(var(--fab-size) + var(--space-2))",
        height: "calc(var(--fab-size) + var(--space-2))",
        background: "var(--accent)",
      }}
    >
      {/* Palette glyph — a 2×2 pixel cluster (on-brand signifier: "the placing
          tools live here"). Inline SVG so it never depends on an emoji font. */}
      <svg aria-hidden width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
        <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
        <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" opacity=".85" />
        <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" opacity=".85" />
        <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
      </svg>
      {showBadge && (
        <span
          aria-hidden
          className="absolute -right-1 -top-1 grid min-w-[20px] place-items-center rounded-[var(--radius-pill)] px-1 text-[var(--text-xs)] font-bold leading-none tnum"
          style={{
            height: 20,
            background: tier ? "var(--accent-2, #f4a020)" : "var(--ui-surface-raised)",
            color: tier ? "var(--gray-900)" : "var(--accent-text)",
            boxShadow: "0 0 0 2px var(--accent)",
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
