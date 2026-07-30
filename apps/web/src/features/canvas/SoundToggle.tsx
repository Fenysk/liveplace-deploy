import { useTranslate } from "@canvas/i18n/react";

interface SoundToggleProps {
  on: boolean;
  onChange: () => void;
  /** AC5: AudioContext blocked by browser policy — show disabled/barred state. */
  blocked?: boolean;
  /** "icon" = standalone chrome button; "row" = settings row with text label. */
  variant?: "icon" | "row";
  /** Decorative pulse for one frame when a sound plays. Disabled under reduced-motion. */
  pinging?: boolean;
}

/** G4 sound toggle — AC6: aria-pressed (icon) / role=switch (row), 44px target. */
export function SoundToggle({
  on,
  onChange,
  blocked = false,
  variant = "icon",
  pinging = false,
}: SoundToggleProps) {
  const t = useTranslate();
  const label = on ? t("canvas.sound.on") : t("canvas.sound.off");
  const tooltip = blocked ? t("canvas.sound.blocked") : t("canvas.sound.toggle");

  if (variant === "row") {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={blocked}
        title={tooltip}
        className={`lp-sound-row${on ? " is-on" : ""}${blocked ? " is-blocked" : ""}`}
        onClick={onChange}
        data-chrome=""
      >
        <SoundIcon on={on} />
        <span className="lp-sound-row-label">{label}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={tooltip}
      disabled={blocked}
      title={tooltip}
      className={`lp-sound-btn${on ? " is-on" : ""}${blocked ? " is-blocked" : ""}${pinging ? " is-pinging" : ""}`}
      onClick={onChange}
      data-chrome=""
    >
      <SoundIcon on={on} />
    </button>
  );
}

function SoundIcon({ on }: { on: boolean }) {
  // ON: speaker + 2 wave arcs (volume-2). OFF: speaker + X cross (volume-x).
  // Shape carries the state, not colour alone — WCAG 1.4.1.
  // Strokes ≥2px: legible at OBS capture resolutions.
  if (on) {
    return (
      <svg
        aria-hidden="true"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  );
}
