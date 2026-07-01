import { type CSSProperties, type ReactElement, useEffect, useRef, useState } from "react";
import { useTranslate } from "@canvas/i18n/react";
import type { MessageKey } from "@canvas/i18n";

// ---------------------------------------------------------------------------
// useRollup — rAF tween for the charge counter (AC1 / G5 FEN-633).
//
// Starts a new tween from the last rendered value toward `target` whenever
// target changes. "Refill during roll-up" is handled correctly: `displayedRef`
// always tracks the running position, so a mid-flight re-trigger starts from
// the current position rather than the original `from`, preventing drift (§5).
// Under prefers-reduced-motion the hook jumps directly (AC1).
// ---------------------------------------------------------------------------
function useRollup(target: number, durationMs = 400): number {
  const [displayed, setDisplayed] = useState(target);
  const displayedRef = useRef(target);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      displayedRef.current = target;
      setDisplayed(target);
      return;
    }

    const from = displayedRef.current;
    if (from === target) return;

    const startTime = performance.now();
    const animate = (ts: number) => {
      const elapsed = ts - startTime;
      const progress = Math.min(elapsed / durationMs, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      const current = Math.round(from + (target - from) * eased);
      displayedRef.current = current;
      setDisplayed(current);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    };
    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, durationMs]);

  return displayed;
}

// ---------------------------------------------------------------------------
// Display state derived from A4 contract values (GaugeState).
// "full" = charges === max ⇔ cooldownUntil === 0 (regen paused).
// "empty" = charges === 0.
// "charging" = 0 < charges < max (or 0 with cooldownUntil > 0 edge).
// ---------------------------------------------------------------------------
type HeroState = "full" | "charging" | "empty";

function deriveState(charges: number, max: number, cooldownUntil: number): HeroState {
  if (charges >= max && cooldownUntil === 0) return "full";
  if (charges <= 0) return "empty";
  return "charging";
}

// ---------------------------------------------------------------------------
// Lightning SVG (charging / empty icon) — pure pixel, 14×20.
// ---------------------------------------------------------------------------
function LightningIcon(): ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 14 20"
      width="14"
      height="20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 0L0 11h6l-1 9 9-12H8L8 0z" />
    </svg>
  );
}


// ---------------------------------------------------------------------------
// HeroGauge (desktop heroic — G5, FEN-633).
//
// Props map directly to A4 contract fields (GaugeState):
//   charges       — A4 `charges` (post lazy-refill)
//   max           — A4 `max` (base 20, or Boost/Convex override)
//   cooldownUntil — A4 `cooldownUntil` (epoch ms; 0 when full)
//   step          — refill increment; A4 base = 1 but Boost/Convex may differ.
//                   Pass A4's effective value — never hardcode 1 (edge-case §5).
//
// AC2 countdown: X = ceil((cooldownUntil − now) / 1000), recomputed each second
// via an internal ticker. This is NOT "extrapolating" (§2 prohibition) — we
// derive X from the server-provided `cooldownUntil`, not from a parallel charge
// counter. Charges are NEVER incremented client-side.
//
// AC6 a11y: role="group" + aria-label with charge count. The aria-live region
// updates on state or charges changes only — never on the per-second countdown
// tick, preventing screen-reader spam (AC6 / FEN-165 lesson).
// ---------------------------------------------------------------------------
export interface HeroGaugeProps {
  charges: number;
  max: number;
  cooldownUntil: number;
  step?: number;
  className?: string;
}

export function HeroGauge({
  charges,
  max,
  cooldownUntil,
  step = 1,
  className,
}: HeroGaugeProps): ReactElement {
  const t = useTranslate();
  const state = deriveState(charges, max, cooldownUntil);
  const displayedCharges = useRollup(Math.max(0, Math.min(charges, max)));

  // Per-second ticker for the countdown display (AC2). Stops when full.
  // We tick Date.now() faster so the display stays live — this is correct:
  // `cooldownUntil` is server-authoritative, we only read the wall clock.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (state === "full") return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [state]);

  // Derive countdown seconds from server-authoritative cooldownUntil (AC2).
  const seconds =
    state !== "full" && cooldownUntil > 0
      ? Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000))
      : 0;

  // aria-live region: announce on state or charges change — not each tick.
  // We track the last-announced pair in a ref and only write the live node
  // when it changes (prevents screen-reader spam — AC6).
  const lastAnnouncedRef = useRef({ state: "", charges: -1 });
  const liveRegionRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const prev = lastAnnouncedRef.current;
    if (prev.state === state && prev.charges === charges) return;
    lastAnnouncedRef.current = { state, charges };
    if (liveRegionRef.current) {
      const safeMax = Math.max(1, max);
      const safeCharges = Math.max(0, Math.min(charges, safeMax));
      liveRegionRef.current.textContent = t(
        "canvas.herogauge.label" as MessageKey,
        { charges: String(safeCharges), max: String(safeMax) },
      );
    }
  }, [state, charges, max, t]);

  const safeMax = Math.max(1, Math.floor(max));
  const fillRatio = Math.max(0, Math.min(displayedCharges, safeMax)) / safeMax;

  const ariaLabel = t("canvas.herogauge.label" as MessageKey, {
    charges: String(Math.max(0, Math.min(charges, safeMax))),
    max: String(safeMax),
  });

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`ui-hero-gauge${className ? ` ${className}` : ""}`}
      data-state={state}
    >
      {/* Polite live region — updates on state/charges change only, not each tick. */}
      <span
        ref={liveRegionRef}
        aria-live="polite"
        aria-atomic="true"
        className="ui-sr-only"
      />

      {/* Header row: icon + counter */}
      <div className="ui-hero-gauge__header" aria-hidden="true">
        <span className="ui-hero-gauge__icon">
          <LightningIcon />
        </span>
        <span className="ui-hero-gauge__counter tnum">
          <span className="ui-hero-gauge__charges">{displayedCharges}</span>
          {state !== "full" && (
            <>
              <span className="ui-hero-gauge__sep">/</span>
              <span className="ui-hero-gauge__max">{safeMax}</span>
            </>
          )}
        </span>
      </div>

      {/* Segment bar */}
      <div className="ui-hero-gauge__bar" aria-hidden="true">
        <span
          className="ui-hero-gauge__fill"
          style={{ "--_fill": String(fillRatio) } as CSSProperties}
        />
        {state === "charging" && (
          <span className="ui-hero-gauge__charging-block" />
        )}
      </div>

      {/* Sub-line: empty state + charging countdown (aria-hidden — live region handles a11y) */}
      <div className="ui-hero-gauge__sub" aria-hidden="true">
        {state === "empty" && (
          <span className="ui-hero-gauge__sub-text">
            {t("canvas.herogauge.empty" as MessageKey)}
          </span>
        )}
        {state === "charging" && seconds > 0 && (
          <span className="ui-hero-gauge__sub-text ui-hero-gauge__countdown tnum">
            {t("canvas.herogauge.charging" as MessageKey, {
              step: String(step),
              seconds: String(seconds),
            })}
          </span>
        )}
      </div>
    </div>
  );
}
