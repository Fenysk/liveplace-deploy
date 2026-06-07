import { PALETTE } from "../data/fresco.js";

// Color selector — the §5.1 color-fidelity proof: each swatch paints the EXACT
// palette hex at full opacity (no tint/opacity), so the swatch == the pixel.
// Selection is double-encoded (ring + check + bold label, legible in greyscale,
// §6) — never color-alone.
//
// FEN-288 ruling — swatch touch target is a DELIBERATE WCAG 2.5.8 (AA) case,
// NOT the 44px AAA floor. A 44px solid swatch is infeasible here: (1) it floods
// the neutral UI with 16 blocks of arbitrary hue, breaking §5.1 chromatic
// neutrality / canvas-is-king; (2) the 8-col grid (a frozen UX structure) can't
// fit 44px cells on mobile without horizontal scroll or hiding colors. The
// painted fill stays at design size (36px default / 32px compact) and fills its
// grid cell (~40px on desktop). With the 1.5 (6px) gap, targets are ≥32px with
// ≥6px separation → satisfies WCAG 2.5.8 AA (≥24px target, ≥24px center spacing)
// while preserving exact fidelity. We knowingly forgo AAA 2.5.5 for this control
// only; var(--target-min-aa) documents the floor that applies.
export default function ColorSelector({ value, onChange, compact = false }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[var(--text-xs)] font-semibold uppercase tracking-wide text-[var(--ui-text-tertiary)]">
          Couleur
        </span>
        <span className="text-[var(--text-xs)] font-semibold text-[var(--ui-text-secondary)]">
          {PALETTE.find((c) => c.hex === value)?.name}
        </span>
      </div>
      <div
        role="radiogroup"
        aria-label="Choisir une couleur"
        className="grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${compact ? 8 : 8}, minmax(0,1fr))` }}
      >
        {PALETTE.map((c) => {
          const selected = c.hex === value;
          return (
            <button
              key={c.id}
              role="radio"
              aria-checked={selected}
              aria-label={c.name}
              title={c.name}
              onClick={() => onChange?.(c.hex)}
              className="relative aspect-square rounded-[var(--radius-sm)] transition-transform duration-[var(--dur-fast)] focus-visible:outline-none active:scale-95"
              style={{
                minWidth: 0, minHeight: compact ? 32 : 36,
                background: c.hex,
                // The selection ring sits OUTSIDE the swatch so it never tints
                // the colour itself; a hairline keeps white swatches bounded.
                boxShadow: selected
                  ? "0 0 0 2px var(--ui-surface), 0 0 0 4px var(--select-ring)"
                  : "inset 0 0 0 1px rgba(24,24,28,.18)",
              }}
            >
              {selected && (
                <span
                  aria-hidden
                  className="absolute inset-0 grid place-items-center text-[13px] font-black"
                  // Check colour flips with swatch luminance so it reads on white AND black.
                  style={{ color: luminance(c.hex) > 0.6 ? "#15171c" : "#ffffff" }}
                >
                  ✓
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function luminance(hex) {
  const n = hex.replace("#", "");
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
