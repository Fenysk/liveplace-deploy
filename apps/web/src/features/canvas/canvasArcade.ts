/**
 * Arcade presentation mapping for the Canvas viewer screen (Lot A — [FEN-269]).
 *
 * The behavioural cores stay framework-agnostic and unit-tested (placeState.ts,
 * cooldown.ts). This module is the thin, equally-testable bridge that maps those
 * derived states onto the Arcade design-system vocabulary (FEN-268): the 5
 * {@link PillState} variants of `StatusPill` and the two `Gauge` modes. Keeping
 * it pure means the 11-state → 5-pill projection is proven headlessly instead of
 * hidden inside JSX — same discipline as variants.ts on the Foundation side.
 *
 * No styling and no literals here: `StatusPill`/`Gauge` own the look (token-only
 * CSS), the screen owns the i18n labels, this owns only the state projection.
 */
import type { PlaceStateKind } from "./placeState.js";

/** The Foundation `StatusPill` state set (mirrors ui/variants.ts `PillState`). */
export type CanvasPillState = "open" | "cooldown" | "frozen" | "ended" | "error";

/**
 * Project the 11 unified place-states onto the 5 canvas pill variants. The pill
 * is the canvas-liveness glyph beside the (i18n) label, so the projection keeps
 * the label as the precise carrier and the icon as the at-a-glance category:
 *
 *   - `open`     — the fresco is live and placeable now, or live-but-sign-in
 *                  (`signedOut`): the canvas itself is open, the label invites.
 *   - `cooldown` — a timed wait: the gauge refill (`cooldown`) or a scheduled
 *                  open that hasn't arrived yet (`notStarted`), and the
 *                  transient `loading` (works ≈ waiting, never an alarm glyph).
 *   - `frozen`   — a streamer/mod paused placement (temporary).
 *   - `ended`    — placement is over for good: event ended or archived.
 *   - `error`    — something is wrong / blocking and needs attention:
 *                  connection lost (the "non-connecté" the issue calls out),
 *                  ban, or canvas not found.
 *
 * Total over the kinds so a new place-state can never silently fall through.
 */
export function pillStateForPlace(kind: PlaceStateKind): CanvasPillState {
  switch (kind) {
    case "ready":
    case "signedOut":
      return "open";
    case "cooldown":
    case "notStarted":
    case "loading":
      return "cooldown";
    case "frozen":
      return "frozen";
    case "ended":
    case "archived":
      return "ended";
    case "offline":
    case "banned":
    case "notFound":
      return "error";
  }
}

/** Which `Gauge` mode the current gauge wants: empty reserve ⇒ a cooldown ring. */
export function gaugeModeForCharges(charges: number): "ready" | "cooldown" {
  return charges <= 0 ? "cooldown" : "ready";
}

/**
 * Decorative drain of the cooldown ring (0→100 as the wait elapses), AC8: the
 * ring is never the only carrier of the time — the tnum seconds count is. We
 * don't get the regen interval over the wire (GaugeState carries only
 * `cooldownUntil`), so the caller latches the whole-second total observed at the
 * start of the current cooling cycle and feeds it here as `totalSeconds`.
 *
 * Returns a clamped integer percent. `remaining >= total` (just entered cooling)
 * ⇒ 0 (empty ring); `remaining <= 0` (about to refill) ⇒ 100 (full ring).
 */
export function cooldownRingPercent(remainingSeconds: number, totalSeconds: number): number {
  if (totalSeconds <= 0) return 100;
  const elapsed = totalSeconds - Math.max(0, remainingSeconds);
  const pct = (elapsed / totalSeconds) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}
