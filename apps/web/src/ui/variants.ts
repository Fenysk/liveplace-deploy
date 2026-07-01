/**
 * Pure variant → className mapping for the Arcade component library (FEN-268).
 *
 * The web `test` script is logic-only (node --test, no DOM); the React wrappers
 * in `*.tsx` stay thin and delegate every class decision here so the design
 * system's variant/state matrix is unit-tested headlessly — same pattern as
 * view.ts / studioView.ts. No styling lives here, only class composition; the
 * actual look is token-driven CSS (`styles/components.css`).
 */

/** Join truthy class fragments (tiny `clsx`, kept dependency-free). */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- Button ----
export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

export function buttonClass(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  extra?: string,
): string {
  return cx("ui-btn", `ui-btn--${variant}`, `ui-btn--${size}`, extra);
}

// ----------------------------------------------------------------- Field ----
export type FieldState = "default" | "error" | "disabled";

/** Resolve the rendered field state from props (error wins, then disabled). */
export function fieldState(opts: {
  error?: string | null;
  disabled?: boolean;
}): FieldState {
  if (opts.error) return "error";
  if (opts.disabled) return "disabled";
  return "default";
}

// ------------------------------------------------------------- StatusPill ----
export type PillState = "open" | "cooldown" | "frozen" | "ended" | "error";

/**
 * Icon + label go together for every state (AA: never colour alone). The glyph
 * is a unicode mark so it survives B&W / colour-blind rendering.
 */
const PILL_ICON: Record<PillState, string> = {
  open: "●",
  cooldown: "◷",
  frozen: "❄",
  ended: "■",
  error: "⚠",
};

export function pillClass(state: PillState): string {
  return cx("ui-pill", `ui-pill--${state}`);
}
export function pillIcon(state: PillState): string {
  return PILL_ICON[state];
}

// ----------------------------------------------------------------- Toast ----
export type ToastKind = "success" | "info" | "error";

const TOAST_ICON: Record<ToastKind, string> = {
  success: "✓",
  info: "i",
  error: "!",
};

export function toastClass(kind: ToastKind): string {
  return cx("ui-toast", `ui-toast--${kind}`);
}
export function toastIcon(kind: ToastKind): string {
  return TOAST_ICON[kind];
}

// ----------------------------------------------------------------- Gauge ----
export type GaugeMode = "ready" | "cooldown";

/** Clamp the cooldown progress to a 0–100 integer percentage. */
export function cooldownPercent(elapsedMs: number, totalMs: number): number {
  if (totalMs <= 0) return 100;
  const pct = (elapsedMs / totalMs) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/** Whole seconds remaining (rounded up — "1" shows until truly 0). */
export function cooldownSeconds(remainingMs: number): number {
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

/**
 * Which reserve segments are filled. `ready`/`max` clamp to a sane range so a
 * bad server value can't render negative/overflowing segments.
 */
export function gaugeSegments(ready: number, max: number): boolean[] {
  const total = Math.max(0, Math.floor(max));
  const filled = Math.max(0, Math.min(total, Math.floor(ready)));
  return Array.from({ length: total }, (_, i) => i < filled);
}

/**
 * Cooldown anticipation ramp (folds FEN-169/171 into the design-system Gauge).
 *
 * The Lot F engagement model (`cooldown.ts#deriveCooldownView`) emits four
 * phases; the *visual* ramp the parked craft painted has three rungs of rising
 * anticipation — `waiting → armed → ready ("go")` — each carried by weight + a
 * left-accent + hue (legible in B&W, AC7). This pure map is the single home for
 * that engagement→visual translation so the Gauge stays token-only and tested:
 *   - `waiting`        → warm, faint (still cooling, nothing aimed)
 *   - `armed`          → warmer, heavier (a cell is locked in for the refill)
 *   - `refilledArmed`  → "go" green, strongest (one gesture commits it)
 *   - `ready`          → `null`: plain available, the ramp adds no emphasis
 *     (Lot E's rang-1 indicator already carries the ordinary "go").
 */
export type CooldownEngagementPhase =
  | "ready"
  | "waiting"
  | "armed"
  | "refilledArmed";
export type CooldownVisualPhase = "waiting" | "armed" | "ready";

export function cooldownVisualPhase(
  phase: CooldownEngagementPhase,
): CooldownVisualPhase | null {
  switch (phase) {
    case "waiting":
      return "waiting";
    case "armed":
      return "armed";
    case "refilledArmed":
      return "ready";
    case "ready":
      return null;
  }
}

// ----------------------------------------------------------- Celebration ----
/** One confetti piece's deterministic placement (no RNG → unit-testable). */
export interface ConfettiPiece {
  /** Horizontal position, 0–100 (% of the field width). */
  left: number;
  /** Stagger before this piece starts falling, ms. */
  delayMs: number;
}

/**
 * Spread `count` confetti pieces across the field deterministically: evenly in
 * x, with a woven delay so they don't all drop in lockstep. Deterministic on
 * purpose — the confetti is decorative (aria-hidden), and a pure generator keeps
 * the Celebration component testable and avoids non-deterministic RNG.
 */
export function celebrationPieces(count: number): ConfettiPiece[] {
  const n = Math.max(0, Math.floor(count));
  return Array.from({ length: n }, (_, i) => ({
    left: n <= 1 ? 50 : Math.round((i / (n - 1)) * 100),
    // 7-step woven cadence keeps neighbours out of lockstep without RNG.
    delayMs: (i % 7) * 90,
  }));
}

/**
 * Pick 3–5 evenly-spaced hex colors from a canvas palette for confetti.
 * Returns `undefined` when fewer than 3 colors are available so the caller
 * can fall back to the Arcade accent tokens (CSS nth-child rules).
 *
 * Deterministic: same palette → same selection, no RNG.
 */
export function celebrationColors(
  palette: readonly string[],
): readonly string[] | undefined {
  if (palette.length < 3) return undefined;
  const n = Math.min(5, palette.length);
  return Array.from(
    { length: n },
    (_, i) => palette[n === 1 ? 0 : Math.round((i / (n - 1)) * (palette.length - 1))]!,
  );
}

// ----------------------------------------------------------- ReserveMeter ----
/**
 * Bounded reserve fill, 0–100 integer percentage (FEN-338, the overflow fix).
 *
 * The historical mobile défaut #1 (Alexis) was the segmented reserve rendering
 * one cell PER charge: the row of N squares grew with N and spilled past the
 * container edges. ReserveMeter instead draws a single fixed-width bar whose
 * FILL is `min(count/cap, 1)` — the bar (and the whole meter) is the same width
 * at N=20 and N=40, only the fill differs, so it can never overflow. A
 * defensive clamp keeps a bad server value (negative / over cap) in range.
 */
export function reserveFillPercent(count: number, cap: number): number {
  if (cap <= 0) return 0;
  const f = Math.max(0, Math.min(1, count / cap));
  return Math.round(f * 100);
}

// --------------------------------------------------------------- Wordmark ----
export type SizeToken = "sm" | "md" | "lg";

export function wordmarkClass(size: SizeToken = "md"): string {
  return cx("ui-wordmark", `ui-wordmark--${size}`);
}
