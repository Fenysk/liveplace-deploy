import { useEffect, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { celebrationColors, celebrationPieces } from "./variants.js";

/**
 * Celebration (handoff §2/§3.2 — "Moment de célébration") — the Kano delight:
 * confetti + a pixel-pop + a Press Start title spring in over the live canvas
 * when the viewer hits a milestone (first pixel, a claimed tier, …).
 *
 * Contract (handoff motion §6 / AC8):
 *   - **Non-blocking.** The overlay is `pointer-events: none` and never traps
 *     focus or gates the canvas — the player keeps placing underneath it. It is
 *     a transient delight, not a modal.
 *   - **Self-dismissing.** When `autoDismissMs` is set the moment fades itself
 *     and calls `onDismiss`; the caller can also force it via `show`.
 *   - **Reduced-motion safe.** The confetti + springs are CSS, all gated behind
 *     `prefers-reduced-motion: no-preference`; under reduce the title + message
 *     simply appear (no info lives in the animation).
 *   - **Announced.** `role="status"` + `aria-live="polite"` so the milestone is
 *     read once by assistive tech; the confetti is `aria-hidden`.
 *
 * Token-only (AC6): the display face is `--font-display` (Press Start 2P — the
 * one place besides the wordmark it's allowed, AC11), colours come from the
 * canvas palette when provided (≥ 3 colors), otherwise fall back to the Arcade
 * accent / show / amber tokens (CSS nth-child rules).
 */
export interface CelebrationProps {
  /** Render the moment when true; unmounts (and stops announcing) when false. */
  show: boolean;
  /** Big Press Start title, e.g. "Premier pixel !" (already localized). */
  title: string;
  /** Supporting line under the title (already localized). */
  message?: string;
  /** Optional pixel-pop glyph/number, e.g. "+1" or "★". */
  pop?: ReactNode;
  /** Auto-dismiss after this many ms; omit to leave it to the caller. */
  autoDismissMs?: number;
  /** Called when the moment dismisses itself (autoDismissMs elapsed). */
  onDismiss?: () => void;
  /** Confetti density (decorative). Default 24. */
  confettiCount?: number;
  /**
   * Hex colors from the active canvas palette. When ≥ 3 are provided, confetti
   * pieces cycle through 3–5 evenly-picked shades instead of the fixed Arcade
   * accent tokens. Pass fewer than 3 (or omit) to keep the CSS fallback.
   */
  paletteColors?: readonly string[];
}

export function Celebration({
  show,
  title,
  message,
  pop,
  autoDismissMs,
  onDismiss,
  confettiCount = 24,
  paletteColors,
}: CelebrationProps): ReactElement | null {
  useEffect(() => {
    if (!show || autoDismissMs == null) return;
    const id = setTimeout(() => onDismiss?.(), autoDismissMs);
    return () => clearTimeout(id);
  }, [show, autoDismissMs, onDismiss]);

  if (!show) return null;

  const pieces = celebrationPieces(confettiCount);
  // Use canvas palette colors when ≥ 3 are provided; else CSS nth-child fallback.
  const colors = paletteColors ? celebrationColors(paletteColors) : undefined;

  return (
    <div className="ui-celebration" role="status" aria-live="polite">
      <div className="ui-celebration__confetti" aria-hidden="true">
        {pieces.map((p, i) => (
          <span
            key={i}
            className="ui-celebration__piece"
            style={
              {
                left: `${p.left}%`,
                animationDelay: `${p.delayMs}ms`,
                ...(colors ? { background: colors[i % colors.length] } : {}),
              } as CSSProperties
            }
          />
        ))}
      </div>
      <div className="ui-celebration__panel">
        {pop != null && <span className="ui-celebration__pop" aria-hidden="true">{pop}</span>}
        <p className="ui-celebration__title">{title}</p>
        {message && <p className="ui-celebration__message">{message}</p>}
      </div>
    </div>
  );
}
