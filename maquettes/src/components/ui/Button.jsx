// Button — single component, all states (default/hover/focus/active/disabled/
// loading). Reused everywhere; "almost the same" variants are forbidden.
// Variants: primary (accent), secondary (neutral surface), ghost.
const base =
  "inline-flex items-center justify-center gap-2 font-[var(--font-sans)] font-semibold " +
  "rounded-[var(--da-radius-control)] transition-[transform,background-color,box-shadow] " +
  "duration-[var(--dur-fast)] ease-[var(--ease-out)] select-none active:scale-[.98] " +
  "focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45";

const sizes = {
  // min-height respects ≥44px touch targets (§5.4).
  lg: "min-h-[48px] px-5 text-[var(--text-base)]",
  md: "min-h-[44px] px-4 text-[var(--text-sm)]",
  sm: "min-h-[36px] px-3 text-[var(--text-sm)]",
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
