/**
 * Optimistic placement controller — the client half of F4 ([FEN-60], from
 * [FEN-14]). It paints a pose/erase onto the local canvas immediately, then
 * reconciles against the gateway's verdict: keep the pixel on `ack`, roll it
 * back on a refusal (`cooldown` / `error`).
 *
 * Why a standalone controller (no React, no canvas backing store): the F4
 * optimism/rollback state machine is the genuine content of this issue and is
 * independent of how pixels are rendered. It consumes the FROZEN
 * `@canvas/protocol` wire types and drives a tiny {@link PlacementSurface} sink,
 * so the eventual canvas component (F3) plugs in by implementing two methods.
 *
 * Server contract it mirrors (gateway `apps/gateway/src/placement.ts`, 981ca29):
 *   - success  → `ack  { seq, charges, max, cooldownUntil }`  — seq echoes place.seq
 *   - cooldown → `cooldown { until }`                          — NO seq (gauge empty)
 *   - refusal  → `error { code, message, seq }`                — seq echoes place.seq
 *
 * Idempotency (CA5): every op is tagged with a positive, monotonic, STABLE seq.
 * On reconnect the still-un-acked ops are re-sent with the SAME seq via
 * {@link OptimisticPlacement.resendQueue}; the gateway dedups on seq, so a
 * resend places exactly once.
 *
 * Cooldown correlation: a `cooldown` frame has no seq, so it cannot be matched
 * by id. The gateway processes places sequentially and the socket delivers
 * replies in order over TCP, so a refusal always concerns the OLDEST un-acked
 * op — we roll back the head of the (insertion-ordered) pending map.
 */
import {
  isInBounds,
  type ClientMessage,
  type ServerMessage,
  type ErrorCode,
  type GaugeState,
} from "@canvas/protocol";

/** A client→server `place` message (also used for erase, color 0). */
export type PlaceMessage = Extract<ClientMessage, { t: "place" }>;

/**
 * The display sink the controller paints through. The future canvas component
 * implements this over its pixel buffer; tests implement it over a Map.
 *
 * `getPixel` returns the currently displayed palette index so the controller can
 * remember what to restore on rollback; `setPixel` writes a palette index.
 */
export interface PlacementSurface {
  getPixel(x: number, y: number): number;
  setPixel(x: number, y: number, color: number): void;
}

export type FeedbackKind = "cooldown" | "banned" | "rejected" | "error";

/**
 * A user-facing signal the UI renders (toast / gauge tint). It carries an i18n
 * KEY rather than a literal string — the controller stays locale-agnostic and
 * the React layer translates via `@canvas/i18n` (`canvas.feedback.*`).
 */
export interface PlacementFeedback {
  kind: FeedbackKind;
  /** i18n message key, e.g. `canvas.feedback.cooldown`. */
  messageKey: string;
  /** Interpolation params for the i18n string (e.g. `{ seconds }`). */
  params?: Record<string, string | number>;
  /** Cooldown only: epoch ms the next charge lands (drives the countdown). */
  until?: number;
  /** The server error code, when the feedback originated from an `error` frame. */
  code?: ErrorCode;
}

export interface PlacementOptions {
  /** Canvas width — read from the `welcome` frame, NEVER hard-coded (D2 note). */
  width: number;
  /** Canvas height — read from the `welcome` frame. */
  height: number;
  /** Number of palette colours for THIS canvas (system 32, or a custom 2–64). */
  paletteSize: number;
  surface: PlacementSurface;
  /** Gauge changed (from an `ack`, a `cooldown`, or an unsolicited `gauge`). */
  onGauge?: (gauge: GaugeState) => void;
  /** A user-facing feedback event (refusal or local rejection). */
  onFeedback?: (feedback: PlacementFeedback) => void;
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  now?: () => number;
  /**
   * When the last-known gauge is empty, refuse the optimistic placement locally
   * (immediate cooldown feedback, no wasted round-trip). Default true. The gauge
   * is still authoritative server-side; this only avoids obviously-doomed sends.
   */
  blockWhenEmpty?: boolean;
}

interface PendingPlacement {
  seq: number;
  x: number;
  y: number;
  color: number;
  /** Displayed palette index at paint time — restored verbatim on rollback. */
  prevColor: number;
}

/** i18n key + feedback kind for each server `ErrorCode`. */
const ERROR_FEEDBACK: Record<ErrorCode, { kind: FeedbackKind; messageKey: string }> = {
  unauthenticated: { kind: "rejected", messageKey: "canvas.feedback.signInRequired" },
  cooldown: { kind: "cooldown", messageKey: "canvas.feedback.cooldown" },
  out_of_bounds: { kind: "rejected", messageKey: "canvas.feedback.outOfBounds" },
  invalid_color: { kind: "rejected", messageKey: "canvas.feedback.invalidColor" },
  rate_limited: { kind: "rejected", messageKey: "canvas.feedback.rateLimited" },
  banned: { kind: "banned", messageKey: "canvas.feedback.banned" },
  internal: { kind: "error", messageKey: "canvas.feedback.error" },
};

/** Palette index of the empty/default cell — an erase paints this. */
export const EMPTY_COLOR = 0;

export class OptimisticPlacement {
  private readonly surface: PlacementSurface;
  private readonly width: number;
  private readonly height: number;
  private readonly paletteSize: number;
  private readonly now: () => number;
  private readonly blockWhenEmpty: boolean;
  private readonly onGaugeCb?: (gauge: GaugeState) => void;
  private readonly onFeedbackCb?: (feedback: PlacementFeedback) => void;

  /** Monotonic op counter — first op is seq 1 (positive & stable per op, CA5). */
  private seqCounter = 0;
  /** Un-acked optimistic placements, keyed by seq, in insertion (FIFO) order. */
  private readonly pending = new Map<number, PendingPlacement>();
  /** Last gauge the server reported, for local empty-checks and the UI. */
  private gauge: GaugeState | null = null;

  constructor(opts: PlacementOptions) {
    this.surface = opts.surface;
    this.width = opts.width;
    this.height = opts.height;
    this.paletteSize = opts.paletteSize;
    this.now = opts.now ?? Date.now;
    this.blockWhenEmpty = opts.blockWhenEmpty ?? true;
    this.onGaugeCb = opts.onGauge;
    this.onFeedbackCb = opts.onFeedback;
  }

  /** Optimistic placements still awaiting a server verdict. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Last gauge the server reported, or null before the first ack/gauge. */
  get lastGauge(): GaugeState | null {
    return this.gauge;
  }

  /**
   * Optimistically place a pixel (or erase it — pass `EMPTY_COLOR`). Validates
   * locally first so an out-of-bounds / bad-colour / known-empty-gauge op never
   * paints or burns a seq. On success it paints immediately and returns the
   * `place` message the caller must send; returns null when rejected locally
   * (feedback already emitted).
   */
  place(x: number, y: number, color: number): PlaceMessage | null {
    if (!isInBounds(x, y, this.width, this.height)) {
      this.emitFeedback({ kind: "rejected", code: "out_of_bounds", messageKey: "canvas.feedback.outOfBounds" });
      return null;
    }
    if (!Number.isInteger(color) || color < 0 || color >= this.paletteSize) {
      this.emitFeedback({ kind: "rejected", code: "invalid_color", messageKey: "canvas.feedback.invalidColor" });
      return null;
    }
    if (this.blockWhenEmpty && this.gauge !== null && this.gauge.charges <= 0) {
      const until = this.gauge.cooldownUntil;
      this.emitFeedback({
        kind: "cooldown",
        messageKey: "canvas.feedback.cooldown",
        params: { seconds: this.secondsUntil(until) },
        until,
      });
      return null;
    }

    const seq = ++this.seqCounter;
    const prevColor = this.surface.getPixel(x, y);
    this.surface.setPixel(x, y, color); // optimistic paint
    this.pending.set(seq, { seq, x, y, color, prevColor });
    return { t: "place", x, y, color, seq };
  }

  /** Route a server frame to the matching handler. Non-placement frames are ignored. */
  handle(msg: ServerMessage): void {
    switch (msg.t) {
      case "ack":
        this.onAck(msg);
        break;
      case "error":
        this.onError(msg);
        break;
      case "cooldown":
        this.onCooldown(msg.until);
        break;
      case "gauge":
        this.applyGauge(msg);
        break;
      default:
        // welcome / pong / viewerCount / resyncRequired are owned by the net client
        break;
    }
  }

  private onAck(msg: Extract<ServerMessage, { t: "ack" }>): void {
    // Confirmed: drop the pending entry but KEEP the painted pixel — it is now
    // authoritative until the broadcast delta echoing it lands (idempotent LWW).
    this.pending.delete(msg.seq);
    this.applyGauge(msg);
  }

  private onError(msg: Extract<ServerMessage, { t: "error" }>): void {
    // Every gateway error carries the echoed seq; fall back to FIFO if a future
    // error variant omits it.
    if (typeof msg.seq === "number") this.rollback(msg.seq);
    else this.rollbackOldest();
    const f = ERROR_FEEDBACK[msg.code] ?? ERROR_FEEDBACK.internal;
    this.emitFeedback({ kind: f.kind, messageKey: f.messageKey, code: msg.code });
  }

  private onCooldown(until: number): void {
    // No seq on a cooldown frame → roll back the oldest un-acked op (TCP order).
    this.rollbackOldest();
    // Reflect "empty, next charge at `until`" so the gauge/countdown updates even
    // though the cooldown frame omits charges/max.
    const next: GaugeState = {
      charges: 0,
      max: this.gauge?.max ?? 0,
      cooldownUntil: until,
    };
    this.applyGauge(next);
    this.emitFeedback({
      kind: "cooldown",
      messageKey: "canvas.feedback.cooldown",
      params: { seconds: this.secondsUntil(until) },
      until,
    });
  }

  private rollback(seq: number): void {
    const p = this.pending.get(seq);
    if (!p) return;
    this.pending.delete(seq);
    this.surface.setPixel(p.x, p.y, p.prevColor); // revert the optimistic paint
  }

  private rollbackOldest(): void {
    const first = this.pending.keys().next();
    if (first.done) return;
    this.rollback(first.value);
  }

  /**
   * The un-acked placements as `place` messages carrying their ORIGINAL seq, to
   * re-send after a reconnect (CA5 idempotency). Oldest-first.
   */
  resendQueue(): PlaceMessage[] {
    return [...this.pending.values()].map((p) => ({ t: "place", x: p.x, y: p.y, color: p.color, seq: p.seq }));
  }

  /**
   * Re-apply the still-pending optimistic pixels on top of a freshly replaced
   * display buffer (after a snapshot / `resyncRequired`), refreshing each op's
   * revert target from the new base so a later rollback stays correct.
   */
  repaintPending(): void {
    for (const p of this.pending.values()) {
      p.prevColor = this.surface.getPixel(p.x, p.y);
      this.surface.setPixel(p.x, p.y, p.color);
    }
  }

  /** Seconds (ceil, floored at 0) until `untilMs`, for the cooldown countdown. */
  private secondsUntil(untilMs: number): number {
    return Math.max(0, Math.ceil((untilMs - this.now()) / 1000));
  }

  private applyGauge(gauge: GaugeState): void {
    this.gauge = { charges: gauge.charges, max: gauge.max, cooldownUntil: gauge.cooldownUntil };
    this.onGaugeCb?.(this.gauge);
  }

  private emitFeedback(feedback: PlacementFeedback): void {
    this.onFeedbackCb?.(feedback);
  }
}
