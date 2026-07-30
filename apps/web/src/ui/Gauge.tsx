import type { CSSProperties, ReactElement } from "react";
import type { CooldownVisualPhase } from "./variants.js";

/**
 * Gauge (handoff §3.1 / AC4) — pose budget in two modes:
 *   - `ready`    : horizontal bar(s) showing available vs total reserve.
 *                  Two bars: total (gray track) + available (accent fill).
 *                  Optional third animated projection bar when `selection > 0`
 *                  (FEN-418 B1–B3): shows pixels remaining after the staged pose.
 *   - `cooldown` : a draining ring + a tabular-nums countdown.
 *
 * The countdown is plain text (`.tnum`), so the cooldown stays legible under
 * `prefers-reduced-motion` — the ring animation is decorative, never the only
 * carrier of the remaining time (AC8).
 *
 * Cooldown mode optionally carries the Lot F anticipation `phase` (FEN-169/171,
 * folded here): `waiting → armed → ready ("go")`. The ramp is rendered via a
 * `data-phase` hook the token CSS paints — weight + left-accent + hue, so the
 * three rungs stay distinguishable in greyscale (AC7) and the "go" pulse is
 * opt-in under `prefers-reduced-motion` (AC8). Map the engagement model's phase
 * through `cooldownVisualPhase()` before passing it in.
 */
export interface GaugeProps {
  mode: "ready" | "cooldown";
  /** ready mode — currently available reserve. */
  ready?: number;
  /** ready mode — total reserve capacity. */
  max?: number;
  /**
   * ready mode — number of cells currently staged (FEN-418 B2/B3).
   * When > 0 renders a third animated projection bar showing remaining pixels
   * after the staged pose. Only shown when in selection mode.
   */
  selection?: number;
  /** cooldown mode — whole seconds remaining (already rounded by the caller). */
  seconds?: number;
  /** cooldown mode — ring fill, 0–100 (drains as the cooldown elapses). */
  percent?: number;
  /**
   * cooldown mode — anticipation rung (FEN-169/171). `null`/omitted = plain
   * cooldown with no ramp emphasis.
   */
  phase?: CooldownVisualPhase | null;
  /** Caller-supplied (i18n) label, e.g. "Prêt" / "Prochain pixel". */
  nextLabel?: string;
  /**
   * cooldown mode — suppress the tabular-nums seconds count. Use when the
   * countdown is already shown by a sibling element (e.g. the Lot F
   * lp-cooldown line) to avoid duplicate text readouts (CA-E2 / FEN-438).
   */
  hideCount?: boolean;
  /**
   * ready mode — suppress the X/Y numeric label. Use when the count is
   * already shown by a sibling element (e.g. the StatusPill) to avoid
   * duplicate value readouts (CA-E1 / FEN-438).
   */
  noLabel?: boolean;
}

export function Gauge({
  mode,
  ready = 0,
  max = 0,
  selection = 0,
  seconds = 0,
  percent = 0,
  phase = null,
  nextLabel,
  hideCount = false,
  noLabel = false,
}: GaugeProps): ReactElement {
  if (mode === "cooldown") {
    return (
      <span className="ui-gauge" data-phase={phase ?? undefined}>
        <span
          className="ui-gauge__ring"
          style={{ "--_pct": String(percent) } as CSSProperties}
          aria-hidden="true"
        />
        {!hideCount && <span className="ui-gauge__count tnum">{seconds}s</span>}
        {nextLabel && <span className="ui-gauge__label">{nextLabel}</span>}
      </span>
    );
  }

  // Ready mode: horizontal bars (FEN-418 B1).
  const safeMax = Math.max(1, Math.floor(max));
  const safeReady = Math.max(0, Math.min(Math.floor(ready), safeMax));
  const fillRatio = safeReady / safeMax;

  // Projection bar: pixels remaining after placing the staged selection (B2/B3).
  const remaining = Math.max(0, safeReady - Math.floor(selection));
  const projRatio = remaining / safeMax;
  const showProj = selection > 0;

  return (
    <span className="ui-gauge" data-mode="bar">
      <span
        className="ui-gauge__track"
        aria-hidden="true"
        style={{ "--_fill": String(fillRatio), "--_proj": String(projRatio) } as CSSProperties}
      >
        <span className="ui-gauge__fill" />
        {showProj && <span className="ui-gauge__proj" />}
      </span>
      {!noLabel && (
        <span className="ui-gauge__label">
          {nextLabel ?? `${safeReady}/${safeMax}`}
        </span>
      )}
    </span>
  );
}
