/**
 * Unified "puis-je poser ?" state (UX Lot E — [FEN-117], spec §D8 / ux-spec
 * FEN-83). The genuine content of this lot is a SINGLE indicator that answers
 * "yes / no + why + when" for every placement state, computed BEFORE the click
 * so the affordance can be disabled/explained instead of failing on attempt
 * (C2 "prévenir plutôt que punir"). This module is the framework-agnostic,
 * unit-tested core (the lot's Definition-of-Done); the React layer (CanvasView)
 * feeds it live signals and renders the result, and the actual colour/icon are
 * deliberately out of scope (delegated to the UI phase).
 *
 * Each state carries an i18n message KEY (never a literal), so every state has a
 * text label (C6: no state relies on colour alone) and FR/EN parity is free.
 *
 * Signals it fuses (no single source knows the whole answer):
 *   - WS connection + gauge (apps/web .../net.ts, FROZEN @canvas/protocol)
 *   - Better Auth session (signed in?) — anonymous users have no gauge
 *   - Convex `canvases.canPlace` permission contract (canvasRules.evaluatePlacement):
 *       { allowed, reason? } where reason ∈ canvas_archived | placement_closed
 *       | outside_event_window | canvas_not_found
 *   - the canvas event window (eventStartAt/eventEndAt) to SPLIT the backend's
 *     single `outside_event_window` into the two UX states the spec demands:
 *     "pas commencé" (future, with a "when") vs "terminé" (past).
 *
 * Backend gap (documented, routed): `canPlace` does NOT yet evaluate bans, so a
 * ban is only knowable pre-click via {@link PlaceStateInput.bannedHint} (sticky
 * flag the client sets from a WS `banned` error). Until the backend adds a
 * `banned` reason to `canPlace`, a freshly-loaded banned user sees the open
 * state until their first (refused) attempt — see the FEN-117 comment thread.
 */
import type { GaugeState } from "@canvas/protocol";
import type { MessageKey } from "@canvas/i18n";

/** WS transport state, mirrored from `net.ts` `ConnectionStatus`. */
export type ConnectionState = "connecting" | "open" | "offline";

/**
 * Deny reasons from the Convex `canvases.canPlace` contract, plus `banned`
 * (forward-compatible: the backend may add it — see the file header gap note).
 */
export type CanPlaceReason =
  | "canvas_archived"
  | "placement_closed"
  | "outside_event_window"
  | "canvas_not_found"
  | "banned";

/** The `canvases.canPlace` return shape; `undefined` while the query loads. */
export interface Permission {
  allowed: boolean;
  reason?: CanPlaceReason;
}

/**
 * Every distinct placement state. Ordered roughly most-blocking → ready. Exactly
 * one is `canPlace: true` ("ready"); all others explain why not (+ when).
 */
export type PlaceStateKind =
  | "loading" // permission/gauge not known yet
  | "offline" // WS dropped after connecting — reconnecting
  | "notFound" // canvas_not_found — nothing to place on
  | "archived" // canvas archived — read-only, forever
  | "banned" // this user can no longer place here
  | "ended" // event window has passed
  | "notStarted" // event window is in the future (carries the open time)
  | "frozen" // streamer/mod froze placement (placement_closed) — temporary
  | "signedOut" // canvas is open, but the visitor must sign in to place
  | "cooldown" // signed in & allowed, but the gauge is empty (carries the refill)
  | "ready"; // can place right now

export interface PlaceState {
  kind: PlaceStateKind;
  /** The single yes/no answer the whole indicator exists to give. */
  canPlace: boolean;
  /**
   * Whether the block is structural/permanent (notFound/archived/banned/ended)
   * vs transient/actionable (offline/loading/frozen/signedOut/cooldown). A UI
   * hint only — no visual decision is made here.
   */
  blocking: boolean;
  /** Unified label key (always present — C6: text for every state). */
  messageKey: MessageKey;
  /** Interpolation params for {@link messageKey} (e.g. `{ seconds }`, `{ time }`). */
  params?: Record<string, string | number>;
  /**
   * Epoch ms at which this state resolves on a clock, when applicable: the next
   * charge (cooldown) or the event open instant (notStarted). Lets the UI drive
   * a live countdown without re-deriving the reason.
   */
  until?: number;
}

export interface PlaceStateInput {
  /** WS transport state. */
  connection: ConnectionState;
  /** Is the visitor signed in? Anonymous visitors can watch but not place. */
  authenticated: boolean;
  /** `canvases.canPlace` result; `undefined` while the Convex query loads. */
  permission: Permission | undefined;
  /** Event window start (epoch ms) — splits `outside_event_window`. */
  eventStartAt?: number | null;
  /** Event window end (epoch ms) — splits `outside_event_window`. */
  eventEndAt?: number | null;
  /** Latest WS gauge; `null` before the first welcome/gauge frame. */
  gauge: GaugeState | null;
  /**
   * Sticky ban learned from a WS `banned` error (stopgap until `canPlace`
   * evaluates bans). When true, the state is `banned` regardless of the gauge.
   */
  bannedHint?: boolean;
  /** Current epoch ms (injected for deterministic tests). */
  now: number;
  /**
   * Formats an epoch-ms instant into a short local time label for the
   * "pas commencé / ça ouvre à {time}" state. Injected so derivation stays pure
   * and locale-/timezone-agnostic; defaults to {@link defaultFormatTime}.
   */
  formatTime?: (epochMs: number) => string;
  /**
   * Resolves the open instant into a day-aware descriptor (today / tomorrow /
   * other + a short date) so `notStarted` can name the day, not just the time
   * (R1, FEN-138 — Recognition over Recall: "Opens at 14:30" can't be planned
   * around if the open day is unknown). Injected like {@link formatTime} to keep
   * derivation pure; defaults to {@link defaultFormatWhen}, which uses
   * {@link formatTime} for the time component so a custom time format still wins.
   */
  formatWhen?: (epochMs: number, now: number) => OpenWhen;
}

/**
 * Day-relative description of the event open instant, used to pick the right
 * `notStarted` label. `date` is only meaningful (and only set) for `"other"`.
 */
export interface OpenWhen {
  day: "today" | "tomorrow" | "other";
  /** Short local time, e.g. "14:30". */
  time: string;
  /** Short local date, e.g. "7 juin" / "Jun 7" — set only when `day === "other"`. */
  date?: string;
}

/** Seconds (ceil, floored at 0) until `untilMs` — drives the cooldown countdown. */
export function secondsUntil(untilMs: number, now: number): number {
  return Math.max(0, Math.ceil((untilMs - now) / 1000));
}

/** Default short local time, e.g. "14:30". Replaceable for tests/locale control. */
export function defaultFormatTime(epochMs: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(
      new Date(epochMs),
    );
  } catch {
    return new Date(epochMs).toISOString().slice(11, 16);
  }
}

/** Local-midnight epoch for `epochMs` — the basis for whole-day comparisons. */
function startOfLocalDay(epochMs: number): number {
  const d = new Date(epochMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Default day-aware resolver for the open instant (R1). Classifies the open day
 * relative to `now` in the LOCAL calendar (not a fixed 24h offset — "tomorrow"
 * means the next calendar day even if it's <24h away), and only computes a date
 * label when the day is neither today nor tomorrow. `formatTime` is delegated so
 * a caller-injected time format keeps applying; ISO is the last-resort fallback.
 */
export function defaultFormatWhen(
  epochMs: number,
  now: number,
  formatTime: (epochMs: number) => string = defaultFormatTime,
): OpenWhen {
  const time = formatTime(epochMs);
  try {
    const dayDiff = Math.round((startOfLocalDay(epochMs) - startOfLocalDay(now)) / 86_400_000);
    if (dayDiff <= 0) return { day: "today", time };
    if (dayDiff === 1) return { day: "tomorrow", time };
    const date = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(
      new Date(epochMs),
    );
    return { day: "other", time, date };
  } catch {
    // Never lose the information: fall back to an ISO date on the "other" branch.
    return { day: "other", time, date: new Date(epochMs).toISOString().slice(0, 10) };
  }
}

/** True when the gauge is known and has no charges left (on cooldown). */
function gaugeEmpty(gauge: GaugeState | null): boolean {
  return gauge !== null && gauge.charges <= 0;
}

/**
 * Split the backend's single `outside_event_window` deny into the two UX states
 * the spec differentiates. With a known start in the future → "pas commencé"
 * (carry the open time); otherwise the window has ended → "terminé".
 */
function windowState(input: PlaceStateInput): PlaceState {
  const { eventStartAt, now } = input;
  if (eventStartAt != null && now < eventStartAt) {
    const when = input.formatWhen
      ? input.formatWhen(eventStartAt, now)
      : defaultFormatWhen(eventStartAt, now, input.formatTime ?? defaultFormatTime);
    const common = { kind: "notStarted" as const, canPlace: false, blocking: false, until: eventStartAt };
    if (when.day === "tomorrow") {
      return { ...common, messageKey: "canvas.state.notStarted.tomorrow", params: { time: when.time } };
    }
    if (when.day === "other") {
      return {
        ...common,
        messageKey: "canvas.state.notStarted.date",
        params: { date: when.date ?? "", time: when.time },
      };
    }
    return { ...common, messageKey: "canvas.state.notStarted", params: { time: when.time } };
  }
  return {
    kind: "ended",
    canPlace: false,
    blocking: true,
    messageKey: "canvas.state.ended",
  };
}

/**
 * Derive the single unified placement state from all live signals. Pure: same
 * inputs → same output. Precedence is deliberate so the most informative /
 * authoritative reason wins when several are simultaneously true:
 *
 *   notFound → archived → banned → ended → notStarted → frozen
 *     → signedOut → offline → loading → cooldown → ready
 *
 * Rationale for the ordering:
 *   - Structural canvas facts (gone / archived / event over) outrank personal
 *     and transient ones: telling a banned user "sign in" on an archived canvas
 *     would be wrong.
 *   - `banned` outranks the canvas event/freeze states (it's permanent & always
 *     true for this user) but not `archived`/`notFound` (read-only-for-everyone
 *     is the more useful message there).
 *   - Canvas-wide blocks (frozen, window) outrank `signedOut`: a frozen canvas
 *     refuses everyone, so prompting sign-in there is misleading.
 *   - `signedOut`/`cooldown`/`ready` are only reached once the canvas itself is
 *     known to allow placement (`permission.allowed === true`).
 */
export function derivePlaceState(input: PlaceStateInput): PlaceState {
  const { permission, connection, authenticated, gauge, now } = input;

  // Ban is permanent + personal: honour it as soon as either the backend reason
  // or the sticky WS hint says so (before the canvas event/freeze states).
  const banned = input.bannedHint === true || permission?.reason === "banned";

  // ── Authoritative canvas-level denials (from the canPlace contract) ──────────
  if (permission && permission.allowed === false) {
    switch (permission.reason) {
      case "canvas_not_found":
        return { kind: "notFound", canPlace: false, blocking: true, messageKey: "canvas.state.notFound" };
      case "canvas_archived":
        return { kind: "archived", canPlace: false, blocking: true, messageKey: "canvas.state.archived" };
      case "banned":
        return { kind: "banned", canPlace: false, blocking: true, messageKey: "canvas.state.banned" };
      case "outside_event_window":
        // banned outranks the event window (permanent, personal).
        if (banned) {
          return { kind: "banned", canPlace: false, blocking: true, messageKey: "canvas.state.banned" };
        }
        return windowState(input);
      case "placement_closed":
        if (banned) {
          return { kind: "banned", canPlace: false, blocking: true, messageKey: "canvas.state.banned" };
        }
        return { kind: "frozen", canPlace: false, blocking: false, messageKey: "canvas.state.frozen" };
      default:
        // Unknown/absent reason on a denial → safest is the generic frozen-ish
        // "you can't place" without inventing a cause; treat as not-ready.
        return { kind: "frozen", canPlace: false, blocking: false, messageKey: "canvas.state.frozen" };
    }
  }

  // A sticky ban can be known before the permission query resolves (WS error).
  if (banned) {
    return { kind: "banned", canPlace: false, blocking: true, messageKey: "canvas.state.banned" };
  }

  // ── Canvas allows placement (or permission not yet known) ───────────────────
  // Sign-in is the next gate: anonymous visitors can watch but not place.
  if (!authenticated) {
    return { kind: "signedOut", canPlace: false, blocking: false, messageKey: "canvas.state.signedOut" };
  }

  // Transport: a drop after connecting is a transient "reconnecting" state.
  if (connection === "offline") {
    return { kind: "offline", canPlace: false, blocking: false, messageKey: "canvas.offline" };
  }

  // Still discovering the canvas: permission unknown, no gauge, or first connect.
  if (permission === undefined || gauge === null || connection === "connecting") {
    return { kind: "loading", canPlace: false, blocking: false, messageKey: "canvas.state.loading" };
  }

  // Allowed + signed in + connected, but the gauge is empty → cooldown (when).
  if (gaugeEmpty(gauge)) {
    return {
      kind: "cooldown",
      canPlace: false,
      blocking: false,
      messageKey: "canvas.state.cooldown",
      params: { seconds: secondsUntil(gauge.cooldownUntil, now) },
      until: gauge.cooldownUntil,
    };
  }

  // Everything green. Pick the singular label at exactly one charge (R2): the
  // i18n layer has no plural engine, so the count drives the key, not ICU.
  return {
    kind: "ready",
    canPlace: true,
    blocking: false,
    messageKey: gauge.charges === 1 ? "canvas.state.ready.one" : "canvas.state.ready",
    params: { charges: gauge.charges, max: gauge.max },
  };
}
