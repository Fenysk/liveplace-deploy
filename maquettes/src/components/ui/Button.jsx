// Button — single component, all states (default/hover/focus/active/disabled/
// loading). Reused everywhere; "almost the same" variants are forbidden.
// Variants: primary (accent), secondary (neutral surface), ghost.
const base =
  "inline-flex items-center justify-center gap-2 font-[var(--font-sans)] font-semibold " +
  "rounded-[var(--da-radius-control)] transition-[transform,background-color,box-shadow] " +
  "duration-[var(--dur-fast)] ease-[var(--ease-out)] select-none active:scale-[.98] " +
  "focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45";

// FEN-288 ruling — touch-target floor:
//  • md (44px) is the canonical touch floor (var(--target-min), §5.4 + WCAG 2.5.5).
//    Use md or lg for any primary/standalone action on a mobile/touch surface.
//  • sm (36px visual) is a POINTER/DESKTOP-DENSITY variant (toolbars, dense
//    tables, secondary actions beside a larger target). It is NOT a standalone
//    touch primary. To stay honest when it can still be tapped, sm expands its
//    interactive hit area to ≥44px in the block axis via an invisible ::before
//    overlay — the visual box stays 36px, the tappable region meets the floor.
//    Block-axis only: inline expansion would overlap horizontally-adjacent
//    buttons. Adjacent dense sm buttons additionally satisfy WCAG 2.5.8 spacing.
const sizes = {
  lg: "min-h-[48px] px-5 text-[var(--text-base)]",
  md: "min-h-[var(--target-min)] px-4 text-[var(--text-sm)]",
  sm:
    "relative min-h-[36px] px-3 text-[var(--text-sm)] " +
    "before:absolute before:content-[''] before:inset-x-0 before:-inset-y-1",
};

const variants = {
  primary:
    "bg-[var(--accent)] text-[var(--accent-onAccent)] shadow-[var(--da-elev-control)] " +
    "hover:bg-[var(--accent-hover)] active:bg-[var(--accent-active)]",
  secondary:
    "bg-[var(--ui-surface)] text-[var(--ui-text)] border border-[var(--ui-border-strong)] " +
    "hover:bg-[var(--ui-bg)] active:bg-[var(--ui-bg)]",
  ghost:
    "bg-transparent text-[var(--ui-text)] hover:bg-[color-mix(in_srgb,var(--ui-text)_8%,transparent)]",
};

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-4 w-4 rounded-full border-2 border-current border-r-transparent"
      style={{ animation: "spin .7s linear infinite" }}
    />
  );
}

export default function Button({
  children, variant = "primary", size = "md", loading = false,
  disabled = false, icon = null, className = "", ...rest
}) {
  return (
    <button
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      <span>{children}</span>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </button>
  );
}
