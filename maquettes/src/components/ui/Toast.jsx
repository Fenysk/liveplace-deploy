// Toast — transient feedback (success / info / error). Glanceable, icon + text
// (never colour-alone, §6), polite live-region for AT. Auto-dismiss is a prop
// in real use; here the maquette renders the static visual.
const MAP = {
  success: { fg: "--status-open-fg",  bg: "--status-open-bg",  icon: "✓" },
  info:    { fg: "--status-frozen-fg",bg: "--status-frozen-bg",icon: "i" },
  error:   { fg: "--status-error-fg", bg: "--status-error-bg", icon: "!" },
};

export default function Toast({ kind = "success", title, children }) {
  const s = MAP[kind] || MAP.success;
  return (
    <div
      role="status"
      className="flex w-full max-w-[360px] items-start gap-3 rounded-[var(--da-radius-card)] border border-[var(--ui-border)] bg-[var(--ui-surface-raised)] p-3 shadow-[var(--elev-3)]"
    >
      <span
        aria-hidden
        className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-sm)] text-[var(--text-sm)] font-black"
        style={{ color: `var(${s.fg})`, background: `var(${s.bg})` }}
      >
        {s.icon}
      </span>
      <div className="min-w-0 flex-1">
        {title && <div className="text-[var(--text-sm)] font-semibold leading-tight">{title}</div>}
        {children && <div className="mt-0.5 text-[var(--text-xs)] text-[var(--ui-text-secondary)]">{children}</div>}
      </div>
      <button aria-label="Fermer" className="shrink-0 rounded-[var(--radius-sm)] px-1.5 text-[var(--ui-text-tertiary)] hover:bg-[color-mix(in_srgb,var(--ui-text)_8%,transparent)]">✕</button>
    </div>
  );
}
