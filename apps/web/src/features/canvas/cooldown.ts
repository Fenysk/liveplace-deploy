/**
 * Cooldown engagement model (UX Lot F — [FEN-119], spec §F / ux-spec FEN-83).
 *
 * The genuine content of this lot is to turn the gauge-empty wait from a dead
 * "you're blocked" stop into anticipation/planning: while a charge is refilling
 * the player may already *arm* their next cell, and the instant it refills the
 * pose costs a single gesture. This module is the framework-agnostic,
 * unit-tested core (the lot's Definition-of-Done); CanvasView feeds it the live
 * (effective) gauge + the staged-batch size and renders the result. The actual
 * colour/icon is deliberately out of scope (delegated to the UI phase, per the
 * issue), so every state here carries an i18n message KEY, never a literal.
 *
 * Relation to the other lots it builds on:
 *   - Lot E ([FEN-117] derivePlaceState): the rang-1 "puis-je poser ?" indicator
 *     keeps owning the yes/no answer. While charges are empty its state is
 *     `cooldown` (canPlace=false), so commit stays gated — you cannot *fire*
 *     mid-cooldown. This module only governs the *arming* (pre-positioning) that
 *     Lot E currently forbids (its cap goes to 0 at 0 charges) and the
 *     forward-oriented countdown copy.
 *   - Lot A ([FEN-113] BatchSelection): arming reuses the staged batch — arming a
 *     cell is just staging it. The only change is the ceiling: during cooldown
 *     {@link armingCapacity} permits one "next" cell so the batch isn't frozen
 *     at 0. At refill the existing per-`cid` commit fires it in one gesture.
 *
 * Sobriety (spec): there is no "skip cooldown". You never get the pixel sooner —
 * you only get to aim it ahead of time, so the refill costs one gesture instead
 * of aim-then-confirm.
 */
import type { MessageKey } from "@canvas/i18n";

export interface CooldownInput {
  /**
   * Charges available right now, with the optimistic tier overlay already folded
   * in (CanvasView passes the *effective* gauge so a just-claimed réserve lifts
   * cooldown to ready exactly as the Lot E indicator sees it). `<= 0` ⇒ cooling.
   */
  charges: number;
  /** Epoch ms at which the next charge returns (drives the live countdown). */
  cooldownUntil: number;
  /** Current epoch ms — injected so derivation stays pure/deterministic. */
  now: number;
  /** Cells currently staged in the batch (i.e. armed). */
  staged: number;
}

/**
 * The engagement phase, driving the forward-oriented copy:
 *   - `ready`         — charges available, nothing armed: ordinary "go" state,
 *                       this module says nothing (Lot E's indicator carries it).
 *   - `waiting`       — cooling, nothing armed yet: invite to aim the next cell.
 *   - `armed`         — cooling, ≥1 cell armed: it will drop the instant it refills.
 *   - `refilledArmed` — refilled WITH a cell still armed: one gesture to drop it.
 */
export type CooldownPhase = "ready" | "waiting" | "armed" | "refilledArmed";

export interface CooldownView {
  phase: CooldownPhase;
  /** True while the gauge is empty (charges <= 0) — the arming window. */
  onCooldown: boolean;
  /** Whole seconds until the next charge (ceil, floored at 0); 0 when not cooling. */
  secondsUntilNext: number;
  /** How many cells may be staged right now (the batch ceiling). */
  capacity: number;
  /** May the user stage ONE MORE new cell right now? (capacity not yet reached) */
  canArm: boolean;
  /** Charges available AND something armed ⇒ a single gesture commits it. */
  readyToFire: boolean;
  /**
   * Engagement line key for the forward-oriented countdown, or `null` when there
   * is nothing to add over the rang-1 indicator (plain ready, empty batch).
   */
  messageKey: MessageKey | null;
  params?: Record<string, string | number>;
}

/**
 * Cells stageable right now. Normally your available charges; while cooling
 * (empty gauge) exactly ONE — the next cell you may pre-aim. One, not the full
 * réserve: charges refill one at a time, so arming more than the next would
 * promise a multi-cell drop the refill can't honour, and the surplus would just
 * be rolled back per-`cid` at commit. One armed cell = one refill = one gesture.
 */
export function armingCapacity(charges: number, onCooldown: boolean): number {
  if (onCooldown) return 1;
  return Math.max(0, Math.floor(charges));
}

/** Whole seconds until `untilMs` (ceil, floored at 0). */
function secondsUntil(untilMs: number, now: number): number {
  return Math.max(0, Math.ceil((untilMs - now) / 1000));
}

/**
 * Derive the cooldown engagement view from the live (effective) gauge and the
 * armed-batch size. Pure: same inputs → same output.
 *
 * `onCooldown` keys on an EMPTY gauge (`charges <= 0`), matching exactly the
 * condition under which Lot E's {@link derivePlaceState} reports `cooldown`
 * (canPlace=false). That alignment is deliberate: arming is permitted on the
 * same edge the commit is forbidden, so the two states never disagree.
 */
export function deriveCooldownView(input: CooldownInput): CooldownView {
  const { charges, cooldownUntil, now, staged } = input;
  const onCooldown = charges <= 0;
  const secondsUntilNext = onCooldown ? secondsUntil(cooldownUntil, now) : 0;
  const capacity = armingCapacity(charges, onCooldown);
  const canArm = staged < capacity;
  const readyToFire = charges > 0 && staged > 0;

  // The cooling-phase messages no longer interpolate {seconds} (FEN-165): the
  // ticking value is surfaced via `secondsUntilNext` in a separate aria-hidden
  // visual span, so the live region announces the phase transition once instead
  // of re-announcing every second. Hence no `params` on the cooling phases.
  if (onCooldown) {
    if (staged > 0) {
      return {
        phase: "armed",
        onCooldown,
        secondsUntilNext,
        capacity,
        canArm,
        readyToFire,
        messageKey: "canvas.cooldown.armed",
      };
    }
    return {
      phase: "waiting",
      onCooldown,
      secondsUntilNext,
      capacity,
      canArm,
      readyToFire,
      messageKey: null,
    };
  }

  if (readyToFire) {
    // A3 (FEN-418): the bar gauge signals the recharged state visually; the
    // "Rechargé — valide pour poser" text is redundant — the primary CTA
    // "Poser X pixels" already carries the call to action.
    return {
      phase: "refilledArmed",
      onCooldown,
      secondsUntilNext,
      capacity,
      canArm,
      readyToFire,
      messageKey: null,
    };
  }

  return {
    phase: "ready",
    onCooldown,
    secondsUntilNext,
    capacity,
    canArm,
    readyToFire,
    messageKey: null,
  };
}
