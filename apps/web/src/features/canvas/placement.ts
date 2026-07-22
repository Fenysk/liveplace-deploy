/**
 * Optimistic placement controller — the client half of F4 ([FEN-60], migrated to
 * the ratified `cid` op id in [FEN-70]). It paints a pose/erase onto the local
 * canvas immediately, then reconciles against the gateway's verdict: keep the
 * pixel on `ack`, roll it back on a refusal (`cooldown` / `error`).
 *
 * Why a standalone controller (no React, no canvas backing store): the F4
 * optimism/rollback state machine is the genuine content of this issue and is
 * independent of how pixels are rendered. It consumes the FROZEN
 * `@canvas/protocol` wire types and drives a tiny {@link PlacementSurface} sink,
 * so the eventual canvas component (F3) plugs in by implementing two methods.
 *
 * Server contract it mirrors (gateway `apps/gateway/src/placement.ts`, ccb6776):
 *   - success  → `ack  { cid, charges, max, cooldownUntil }`   — cid echoes place.cid
 *   - cooldown → `cooldown { until }`                          — NO cid (gauge empty)
 *   - refusal  → `error { code, message, cid }`                — cid echoes place.cid
 *
 * Op id (`cid`, ratified FEN-63, contract `1aa494a` §cid): every placement is
 * tagged with an OPAQUE, client-generated, per-op string (a UUID by default —
 * see {@link defaultCidGen}). It does two jobs:
 *   1. Optimistic reconciliation: the client keys its pending pixel by `cid` and
 *      matches the echoed `cid` on `ack` (commit) / `error` (rollback). The
 *      global `seq` cannot do this — the client never learns an op's `seq` until
 *      its `ack`, so it has nothing to key the pending placement on in advance.
 *   2. CA5 idempotency: the gateway claims a per-`(canvas,user,cid)` key with
 *      `SET NX`, so an un-acked op re-sent after a reconnect (via
 *      {@link OptimisticPlacement.resendQueue}, with the SAME `cid`) places
 *      exactly once. The id MUST be opaque and stable per op — a per-session
 *      integer counter that resets to `1` on restart can collide with a prior
 *      op from the same user and get a legit placement dropped as a false replay,
 *      which is why the default is a UUID rather than a counter.
 *
 * Cooldown correlation: a `cooldown` frame has no cid, so it cannot be matched
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
 * Default `cid` generator: an opaque, collision-free UUID per op. Uses the WHATWG
 * `crypto.randomUUID()` available in modern browsers and Node ≥ 19 (the web/OBS
 * runtimes). Falls back to a timestamp+random token only if `randomUUID` is
 * unavailable — still opaque and non-resetting, the property the contract requires.
 */
export function defaultCidGen(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Fallback: two random 32-bit hex words. Not a UUID, but opaque, per-op unique,
  // and never reset to a fixed seed across restarts (no false-replay risk).
  const rand = () => Math.floor(Math.random() * 0x1_0000_0000).toString(16).padStart(8, "0");
  return `cid-${rand()}${rand()}`;
}

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
  /** Server confirmed placement (ack received for at least one cell). */
  onPlaced?: () => void;
  /**
   * Called after every server-confirmed op (ack), after the pending entry has
   * been removed. `erased` is true when the committed op painted `EMPTY_COLOR`
   * (an erase), false for a paint. Callers that need first-pose one-shot gating
   * should implement the idempotency guard themselves (e.g. localStorage key).
   *
   * NOT called on rollbacks (error / cooldown) or local rejections.
   */
  onCommitted?: (info: { cid: string; erased: boolean }) => void;
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  now?: () => number;
  /**
   * Injectable opaque `cid` generator for deterministic tests; defaults to
   * {@link defaultCidGen} (a UUID per op). MUST return a fresh, stable-per-op,
   * non-resetting token (see the CA5 note in the file header).
   */
  genCid?: () => string;
  /**
   * When the last-known gauge is empty, refuse the optimistic placement locally
   * (immediate cooldown feedback, no wasted round-trip). Default true. The gauge
   * is still authoritative server-side; this only avoids obviously-doomed sends.
   */
  blockWhenEmpty?: boolean;
}

interface PendingPlacement {
  cid: string;
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
  frozen: { kind: "rejected", messageKey: "canvas.feedback.frozen" },
  bad_request: { kind: "error", messageKey: "canvas.feedback.badRequest" },
};

/** Palette index of the empty/default cell — an erase paints this. */
export const EMPTY_COLOR = 0;

export class OptimisticPlacement {
  private readonly surface: PlacementSurface;
  private width: number;
  private height: number;
  private readonly paletteSize: number;
  private readonly now: () => number;
  private readonly genCid: () => string;
  private readonly blockWhenEmpty: boolean;
  private readonly onGaugeCb?: (gauge: GaugeState) => void;
  private readonly onFeedbackCb?: (feedback: PlacementFeedback) => void;
  private readonly onPlacedCb?: () => void;
  private readonly onCommittedCb?: (info: { cid: string; erased: boolean }) => void;
  private hasEverPlaced = false;

  /** Un-acked optimistic placements, keyed by opaque `cid`, in insertion (FIFO) order. */
  private readonly pending = new Map<string, PendingPlacement>();
  /** Last gauge the server reported, for local empty-checks and the UI. */
  private gauge: GaugeState | null = null;

  constructor(opts: PlacementOptions) {
    this.surface = opts.surface;
    this.width = opts.width;
    this.height = opts.height;
    this.paletteSize = opts.paletteSize;
    this.now = opts.now ?? Date.now;
    this.genCid = opts.genCid ?? defaultCidGen;
    this.blockWhenEmpty = opts.blockWhenEmpty ?? true;
    this.onGaugeCb = opts.onGauge;
    this.onFeedbackCb = opts.onFeedback;
    this.onPlacedCb = opts.onPlaced;
    this.onCommittedCb = opts.onCommitted;
  }

  /**
   * Update the placement bounds after a canvas resize (FEN-1821). Call this
   * both on `dimsChanged` WS frame AND when Convex reactive dims change so
   * the client-side out-of-bounds guard never lags behind what the user sees.
   */
  setDims(width: number, height: number): void {
    this.width = width;
    this.height = height;
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
   * paints or mints a cid. On success it paints immediately and returns the
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

    const cid = this.genCid();
    const prevColor = this.surface.getPixel(x, y);
    this.surface.setPixel(x, y, color); // optimistic paint
    this.pending.set(cid, { cid, x, y, color, prevColor });
    return { t: "place", x, y, color, cid };
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
    // The gateway echoes the op's `cid`; fall back to FIFO (oldest un-acked) only
    // if a frame ever arrives without one (TCP order makes that the right op).
    // Capture the entry BEFORE deletion so onCommittedCb can read the color.
    let committed: PendingPlacement | undefined;
    if (typeof msg.cid === "string") {
      committed = this.pending.get(msg.cid);
      this.pending.delete(msg.cid);
    } else {
      committed = this.dropOldest();
    }
    this.applyGauge(msg);
    if (committed) {
      this.onCommittedCb?.({ cid: committed.cid, erased: committed.color === EMPTY_COLOR });
    }
    if (!this.hasEverPlaced) {
      this.hasEverPlaced = true;
      this.onPlacedCb?.();
    }
  }

  private onError(msg: Extract<ServerMessage, { t: "error" }>): void {
    // Every placement error echoes the op's `cid`; fall back to FIFO if an error
    // variant ever omits it (e.g. one not tied to a specific `place`).
    if (typeof msg.cid === "string") this.rollback(msg.cid);
    else this.rollbackOldest();
    const f = ERROR_FEEDBACK[msg.code] ?? ERROR_FEEDBACK.internal;
    this.emitFeedback({ kind: f.kind, messageKey: f.messageKey, code: msg.code });
  }

  private onCooldown(until: number): void {
    // No cid on a cooldown frame → roll back the oldest un-acked op (TCP order).
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

  private rollback(cid: string): void {
    const p = this.pending.get(cid);
    if (!p) return;
    this.pending.delete(cid);
    this.surface.setPixel(p.x, p.y, p.prevColor); // revert the optimistic paint
  }

  private rollbackOldest(): void {
    const first = this.pending.keys().next();
    if (first.done) return;
    this.rollback(first.value);
  }

  /** Commit (drop, keep painted) the oldest un-acked op — the cid-less ack fallback. Returns the dropped entry. */
  private dropOldest(): PendingPlacement | undefined {
    const first = this.pending.keys().next();
    if (first.done) return undefined;
    const entry = this.pending.get(first.value);
    this.pending.delete(first.value);
    return entry;
  }

  /**
   * The un-acked placements as `place` messages carrying their ORIGINAL cid, to
   * re-send after a reconnect (CA5 idempotency: SET NX on (canvas,user,cid) makes
   * the resend place exactly once). Oldest-first.
   */
  resendQueue(): PlaceMessage[] {
    return [...this.pending.values()].map((p) => ({ t: "place", x: p.x, y: p.y, color: p.color, cid: p.cid }));
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
