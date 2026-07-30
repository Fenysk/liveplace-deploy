/**
 * Streamer crisis panel — pure view-model (UX Lot I — [FEN-121], spec §D6 Flow
 * S3 / ux-spec FEN-83 WF-8 "Réagir (crise / raid)"). React- and Convex-free so
 * the whole crisis interaction logic unit-tests headlessly (the web `test` script
 * is logic-only), matching the studioView.ts convention. i18n keys are RETURNED,
 * never resolved here; the actual visual weight / colour / iconography is
 * delegated to the UI phase (marked in the lot).
 *
 * The lot's hard acceptance is **"trouver gel/ban/wipe en < 10 s sous stress"**.
 * That drives the shape of this VM:
 *   - There is ALWAYS exactly one front-and-center primary action reachable in a
 *     single gesture: ❄ Freeze placing while the canvas is open, ↺ Reopen once
 *     frozen. The streamer never hunts for the panic button.
 *   - The destructive crisis tools (ban an author, wipe an area) are **grouped**
 *     and only surfaced once placement is frozen (Flow S3: "une fois gelé : accès
 *     groupé crise") — you freeze first, then triage. This keeps the calm-state
 *     surface to a single unambiguous button.
 *   - Wiping is reversible and re-reveals what was underneath (cadre §2.5); the
 *     panel carries a warning key near the wipe tool so the streamer is forewarned
 *     ("prévenir le streamer"), and pairs the wipe with its restore affordance.
 *   - First-crisis onboarding (D9): signal ONCE where the emergency freeze lives,
 *     then never again (`freezeHintSeen` persists the "vu" flag).
 *
 * Backend contract (NOT called here — this VM only names the mapping so the thin
 * React page wires the right Convex action): apps/convex/convex/moderation.ts —
 * `setFrozen` / `banAndWipe` / `deletePixels` / `restore` (all exist, FEN-52).
 */
import type { MessageKey } from "@canvas/i18n";

/** i18n KEYs for the crisis action labels (returned, never resolved here). */
export type CrisisActionLabelKey =
  | "studio.crisis.freeze"
  | "studio.crisis.reopen"
  | "studio.crisis.ban"
  | "studio.crisis.wipe"
  | "studio.crisis.restore";

/** The Convex `moderation.ts` function a crisis action dispatches to. */
export type CrisisBackendAction = "setFrozen" | "banAndWipe" | "deletePixels" | "restore";

/** Stable id for a crisis action — what the page keys handlers / pending state on. */
export type CrisisActionId = "freeze" | "reopen" | "ban" | "wipe" | "restore";

/**
 * A single crisis control. `emphasis` separates the always-present 1-gesture
 * panic control (`primary`) from the grouped triage tools (`grouped`); no visual
 * decision is encoded — only the role.
 */
export interface CrisisAction {
  id: CrisisActionId;
  labelKey: CrisisActionLabelKey;
  /** Documents which Convex moderation function the page should invoke. */
  backend: CrisisBackendAction;
  emphasis: "primary" | "grouped";
  /** Destructive actions get a confirm step + warning (ban/wipe); freeze is one-tap. */
  destructive: boolean;
  /** True while this action's dispatch is in flight — the page disables it (idempotency guard). */
  pending: boolean;
}

export interface CrisisPanelView {
  /**
   * `calm` = placement open, only the emergency freeze is shown. `frozen` =
   * placement paused, the grouped crisis tools + reopen are available.
   */
  phase: "calm" | "frozen";
  /** Headline status copy for the panel (`studio.crisis.status.*`). */
  statusKey: MessageKey;
  /** The single always-reachable 1-gesture control (freeze when calm, reopen when frozen). */
  primary: CrisisAction;
  /** Grouped triage tools — empty when calm; [ban, wipe] once frozen (Flow S3). */
  group: CrisisAction[];
  /** §2.5 warning shown by the wipe tool ("ce qui était dessous réapparaît"); null when calm. */
  wipeWarningKey: MessageKey | null;
  /** First-crisis onboarding hint (D9) — shown once, then null after `freezeHintSeen`. */
  firstCrisisHintKey: MessageKey | null;
}

export interface CrisisPanelInput {
  /** Whether placement is currently open (from the active canvas `placementOpen`). */
  placementOpen: boolean;
  /** The action whose dispatch is in flight, if any — drives the `pending` flag. */
  pendingAction?: CrisisActionId | null;
  /**
   * Persisted "vu" flag for the first-crisis freeze hint (D9 persistence). When
   * false and the canvas is still open, the panel points once at the freeze
   * button; suppressed forever after.
   */
  freezeHintSeen?: boolean;
}

function action(
  id: CrisisActionId,
  labelKey: CrisisActionLabelKey,
  backend: CrisisBackendAction,
  emphasis: "primary" | "grouped",
  destructive: boolean,
  pendingAction: CrisisActionId | null | undefined,
): CrisisAction {
  return { id, labelKey, backend, emphasis, destructive, pending: pendingAction === id };
}

/**
 * Build the crisis panel descriptor from the live canvas state. Pure: same
 * inputs → same output.
 *
 * Calm (open): one button — ❄ Freeze placing — plus the one-time freeze hint.
 * Frozen: ↺ Reopen as the primary recovery, the grouped [Ban, Wipe] triage tools,
 * and the wipe "underneath reappears" warning.
 */
export function buildCrisisPanel(input: CrisisPanelInput): CrisisPanelView {
  const pending = input.pendingAction ?? null;

  if (input.placementOpen) {
    return {
      phase: "calm",
      statusKey: "studio.crisis.status.calm",
      primary: action("freeze", "studio.crisis.freeze", "setFrozen", "primary", false, pending),
      group: [],
      wipeWarningKey: null,
      // Signal the panic button's location exactly once (D9), never mid-crisis.
      firstCrisisHintKey: input.freezeHintSeen ? null : "studio.crisis.firstHint",
    };
  }

  return {
    phase: "frozen",
    statusKey: "studio.crisis.status.frozen",
    primary: action("reopen", "studio.crisis.reopen", "setFrozen", "primary", false, pending),
    group: [
      action("ban", "studio.crisis.ban", "banAndWipe", "grouped", true, pending),
      action("wipe", "studio.crisis.wipe", "deletePixels", "grouped", true, pending),
    ],
    wipeWarningKey: "studio.crisis.wipeWarning",
    firstCrisisHintKey: null,
  };
}
