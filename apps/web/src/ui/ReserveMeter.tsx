import type { CSSProperties, ReactElement } from "react";
import { cx, reserveFillPercent } from "./variants.js";

/**
 * ReserveMeter (FEN-338, handoff §"À CRÉER" #1) — the bounded pose reserve.
 *
 * This is THE fix for Alexis' mobile défaut #1: the reserve no longer renders a
 * row of N squares that scales with N and touches the container edges. It is a
 * compact compteur — a fixed-width count pastille + a single bounded bar whose
 * FILL is `min(count/cap, 1)`. The meter's footprint is identical at N=20 and
 * N=40 (only the fill differs), so it can never overflow the dock (AC-1/AC-2).
 *
 * The count appears exactly ONCE (corrects défaut "double représentation"): the
 * pastille is the only number, the bar carries the proportion. Token-only (AC-5):
 * every colour / space / radius reads `var(--…)`. Caller owns the i18n strings.
 */
export interface ReserveMeterProps {
  /** Currently available pose charges. */
  count: number;
  /** Total reserve capacity (the bar's denominator). */
  cap: number;
  /** Localized label, e.g. "pixels prêts" / "pixels ready". */
  label: string;
  /** Localized right-side text, e.g. "/ 40" or "réserve pleine". */
  capText: string;
  className?: string;
}

export function ReserveMeter({
  count,
  cap,
  label,
  capText,
  className,
}: ReserveMeterProps): ReactElement {
  const pct = reserveFillPercent(count, cap);
  const safeCount = Math.max(0, Math.floor(count));
  return (
    <div className={cx("ui-reserve", className)}>
      <span className="ui-reserve__count tnum">{safeCount}</span>
      <div className="ui-reserve__body">
        <div className="ui-reserve__head">
          <span className="ui-reserve__label">{label}</span>
          <span className="ui-reserve__cap tnum">{capText}</span>
        </div>
        {/* The bar is fixed-width; only `--_fill` varies with count/cap, so the
            meter footprint is constant for every N (the anti-overflow promise). */}
        <div className="ui-reserve__bar">
          <span
            className="ui-reserve__fill"
            style={{ "--_fill": `${pct}%` } as CSSProperties}
          />
        </div>
      </div>
    </div>
  );
}
