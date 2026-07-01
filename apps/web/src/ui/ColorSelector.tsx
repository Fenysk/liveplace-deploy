import type { CSSProperties, ReactElement } from "react";

/**
 * ColorSelector (handoff §3.1 / AC5) — the pose palette. Each swatch fill is the
 * EXACT palette hex (no tint/opacity — colour fidelity). Selection is shown with
 * a marching-ants animated border (FEN-1488) + an accessible aria-checked label,
 * so it reads in B&W / for colour-blind users — never colour alone.
 * Swatches are ≥36px touch targets.
 *
 * FEN-418 A7: an optional `eraser` item renders at index 0 — icon + label with
 * auto width — visible only when the caller passes it (i.e. in draw mode).
 */
export interface PaletteColor {
  /** Stable id used by `value`/`onChange` (e.g. a palette index or name). */
  id: string;
  /** Exact hex, rendered verbatim as the swatch fill. */
  hex: string;
  /** Accessible name, e.g. "Rouge" / "Red" (i18n owned by the caller). */
  label: string;
}

export interface EraserItem {
  /** Stable id matched against `value` to determine the active state. */
  id: string;
  /** Visible + accessible label, e.g. "Gomme" / "Eraser". */
  label: string;
}

export interface ColorSelectorProps {
  colors: PaletteColor[];
  value: string | null;
  onChange: (id: string) => void;
  compact?: boolean;
  /** Accessible group label, e.g. "Couleur de pose". */
  ariaLabel?: string;
  /**
   * Optional eraser item rendered at index 0 (FEN-418 A7). When provided it
   * shows as a palette button with an eraser icon + label. Only pass it when
   * in draw mode (A5 gating is the caller's responsibility).
   */
  eraser?: EraserItem;
}

/**
 * Bi-tone marching-ants border overlay for the selected swatch (FEN-1488).
 * Two <rect> strokes share the same dash pattern, offset by half a period so
 * white + black together tile the full perimeter — identical visual to the
 * canvas renderer's drawInspectFrame(). Animated via CSS keyframes in
 * components.css (prefers-reduced-motion: no-preference gate).
 */
function MarchingAnts(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="ui-swatch__ants"
    >
      <rect className="ui-swatch__ants-white" x="0" y="0" width="100%" height="100%" />
      <rect className="ui-swatch__ants-black" x="0" y="0" width="100%" height="100%" />
    </svg>
  );
}

/** Inline eraser SVG glyph — no external dependency (plan constraint D-A7). */
function EraserIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      {/* eraser body */}
      <path d="M13.5 2.5a1.5 1.5 0 0 0-2.12 0L2.5 11.38A1.5 1.5 0 0 0 3.56 14H7a1 1 0 0 0 .71-.29l5.79-5.79a1.5 1.5 0 0 0 0-2.12L13.5 2.5z" />
      {/* base line */}
      <rect x="2" y="14" width="12" height="1.5" rx="0.75" />
    </svg>
  );
}

export function ColorSelector({
  colors,
  value,
  onChange,
  compact = false,
  ariaLabel = "Couleur",
  eraser,
}: ColorSelectorProps): ReactElement {
  return (
    <div
      className="ui-swatches"
      data-compact={compact || undefined}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {/* Eraser at index 0 (FEN-418 A7): width auto (icon + text). Selected state
          uses the same marching-ants SVG overlay as colour swatches (FEN-1488). */}
      {eraser && (() => {
        const selected = eraser.id === value;
        return (
          <button
            key={eraser.id}
            type="button"
            className="ui-swatch"
            data-eraser="true"
            data-selected={selected || undefined}
            role="radio"
            aria-checked={selected}
            aria-label={eraser.label}
            title={eraser.label}
            onClick={() => onChange(eraser.id)}
          >
            <EraserIcon />
            <span className="ui-swatch__eraser-label">{eraser.label}</span>
            {selected && <MarchingAnts />}
          </button>
        );
      })()}
      {colors.map((c) => {
        const selected = c.id === value;
        return (
          <button
            key={c.id}
            type="button"
            className="ui-swatch"
            data-selected={selected || undefined}
            style={{ background: c.hex } as CSSProperties}
            role="radio"
            aria-checked={selected}
            aria-label={c.label}
            title={c.label}
            onClick={() => onChange(c.id)}
          >
            {selected && <MarchingAnts />}
          </button>
        );
      })}
    </div>
  );
}
