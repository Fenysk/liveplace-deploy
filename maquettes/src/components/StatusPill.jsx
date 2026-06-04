// Canvas-state pill (open / cooldown / frozen / ended / error). Glanceable <1s
// (§5.2) and NEVER color-only — every state carries an icon + a text label
// (§6 color-independence, legible in greyscale).
const MAP = {
  open:     { fg: "--status-open-fg",     bg: "--status-open-bg",     icon: "●", fr: "Ouvert" },
  cooldown: { fg: "--status-cooldown-fg", bg: "--status-cooldown-bg", icon: "⏳", fr: "Recharge" },
  frozen:   { fg: "--status-frozen-fg",   bg: "--status-frozen-bg",   icon: "❄", fr: "En pause" },
  ended:    { fg: "--status-ended-fg",    bg: "--status-ended-bg",    icon: "■", fr: "Terminé" },
  error:    { fg: "--status-error-fg",    bg: "--status-error-bg",    icon: "!", fr: "Erreur" },
};

export default function StatusPill({ state = "open", label, className = "" }) {
  const s = MAP[state] || MAP.open;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] px-2.5 py-1 text-[var(--text-xs)] font-semibold leading-none ${className}`}
      style={{ color: `var(${s.fg})`, background: `var(${s.bg})` }}
    >
      <span aria-hidden className="text-[10px]">{s.icon}</span>
      <span>{label || s.fr}</span>
    </span>
  );
}
