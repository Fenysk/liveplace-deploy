/**
 * Viewer-side legibility of moderation events (UX Lot I — [FEN-121], spec §D8
 * row "Événement de modération" + ux-spec FEN-83 copy table). The whole point of
 * this lot's viewer half is **lisibilité, zéro feature** (C1 / F8 / D8): when a
 * streamer freezes the canvas or wipes an area, the watcher must understand that
 * "a collective event just happened" WITHOUT jargon and WITHOUT anxiety — never a
 * raw "you were wiped" or a silent, unexplained repaint.
 *
 * This module is the framework-agnostic, unit-tested core (the lot's
 * Definition-of-Done). It is a pure reducer over two liveness snapshots: given
 * what the viewer last observed and what it observes now, it returns the single
 * non-anxiogène notice to surface (or `null`). CanvasView feeds it the live
 * signals (frozen flag from the place-state, and a server-initiated bulk-change
 * counter from net.ts) and renders the returned i18n KEY — the actual colour /
 * icon / toast styling is deliberately out of scope (delegated to the UI phase).
 *
 * Why a dedicated signal and not "any resync": the protocol is frozen and a
 * *reconnect* also replaces the buffer with a fresh snapshot (canvas.offline →
 * resync). That is a NETWORK event ("on remet la fresque à jour"), not a
 * moderation one, and must NOT read as "an area was changed" (that would be the
 * anxiety we are trying to avoid). So the net layer only bumps `bulkChangeSeq`
 * for a *server-initiated* mass overwrite that is NOT the client's own
 * reconnect-driven resync; this reducer keys off that counter, never off the
 * raw snapshot frame. See net.ts `onModerationResync`.
 */
import type { MessageKey } from "@canvas/i18n";

/**
 * The viewer-observable liveness facts this reducer compares between renders.
 * Intentionally minimal — it carries only what distinguishes a moderation event
 * from ordinary canvas traffic.
 */
export interface CanvasLiveness {
  /**
   * Placement is currently frozen (gel). Sourced from the unified place-state
   * (`placement_closed` → `frozen`), so freeze legibility and the "can I place?"
   * indicator never drift.
   */
  frozen: boolean;
  /**
   * Monotonic count of *server-initiated* bulk overwrites the viewer has
   * observed (wipe / ban-and-wipe). Bumped by net.ts ONLY for mass changes that
   * are not the client's own reconnect resync, so a network blip never surfaces
   * as moderation. A strict increase between snapshots means "an area just
   * changed for everyone".
   */
  bulkChangeSeq: number;
}

export type ModerationNoticeKind =
  | "areaChanged" // a wipe / ban-wipe replaced part of the fresco for everyone
  | "paused" // placement was just frozen (gel)
  | "reopened"; // placement was just reopened (recovery — reassuring, not alarming)

/**
 * A transient, non-anxiogène viewer notice. Carries an i18n KEY (C6: every state
 * has a text label, never colour alone) and a11y/dismissal hints — but makes no
 * visual decision.
 */
export interface ModerationNotice {
  kind: ModerationNoticeKind;
  /** Unified copy key (`canvas.moderation.*`); always a text label. */
  messageKey: MessageKey;
  /**
   * A11y politeness. Always `"polite"` — a moderation event is informational,
   * never an `assertive`/alert interruption (that is the anxiety we avoid; D8).
   */
  ariaLive: "polite";
  /**
   * Suggested auto-dismiss delay (ms). The notice is a brief, sober "something
   * happened" — it must not linger like an error. 0 would mean sticky; none are.
   */
  autoDismissMs: number;
}

/** Shared sober dismissal window — long enough to read, short enough to forget. */
const NOTICE_TTL_MS = 6000;

/**
 * Derive the single moderation notice to show given the previously-observed and
 * the current liveness. Pure: same inputs → same output. Returns `null` when
 * nothing collective changed (the common case, every ordinary frame).
 *
 * Precedence when several transitions coincide (a ban-and-wipe both freezes and
 * overwrites): the *area change* is the most salient, most reassuring-to-explain
 * fact ("une zone vient d'être modifiée"), so it wins over the freeze label. A
 * freeze with no overwrite is `paused`; a reopen is the gentle recovery note.
 */
export function deriveModerationNotice(
  prev: CanvasLiveness,
  next: CanvasLiveness,
): ModerationNotice | null {
  if (next.bulkChangeSeq > prev.bulkChangeSeq) {
    return {
      kind: "areaChanged",
      messageKey: "canvas.moderation.areaChanged",
      ariaLive: "polite",
      autoDismissMs: NOTICE_TTL_MS,
    };
  }
  if (next.frozen && !prev.frozen) {
    return {
      kind: "paused",
      messageKey: "canvas.moderation.paused",
      ariaLive: "polite",
      autoDismissMs: NOTICE_TTL_MS,
    };
  }
  if (prev.frozen && !next.frozen) {
    return {
      kind: "reopened",
      messageKey: "canvas.moderation.reopened",
      ariaLive: "polite",
      autoDismissMs: NOTICE_TTL_MS,
    };
  }
  return null;
}
