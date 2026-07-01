/**
 * G2 "porte 2-temps" — guided onboarding gate (FEN-584).
 *
 * A non-blocking 2-step overlay (Bienvenue + Outils) that sits on top of the
 * existing OnboardingCoach. It triggers once per canvas (per-canvas welcome key)
 * and once globally (model key). After the porte, the coach takes over.
 *
 * Trigger conditions (§3):
 *   1. Viewer is authenticated.
 *   2. placeState.kind not in {notFound, archived, banned, ended, offline, loading}.
 *   3. Welcome not yet seen for THIS canvasId.
 *   4. Model not yet learned globally (OnboardingCoach v1 experienced flag).
 *   5. Viewer is not the canvas owner.
 *
 * Persistence:
 *   - Welcome (per-canvas): `liveplace.onboarding.welcome.{canvasId}`
 *   - Model (global): reuses `liveplace.onboarding.v1` (OnboardingCoach storage)
 *
 * Instrumentation: emits onboarding_started / onboarding_skipped / first_pixel_placed
 * via the optional `onEvent` callback for time-to-first-pixel measurement.
 */

export type GatedStep = "welcome" | "tools";
export type GateState = "hidden" | "welcome" | "tools" | "skip-confirm" | "done";

export interface GuidedOnboardingEvent {
  type:
    | "trigger"       // conditions met, try to show
    | "start"         // "C'est parti" → Temps 2
    | "place-first"   // "Poser mon premier pixel" → close + aim
    | "skip"          // "Passer" → skip-confirm
    | "confirm-skip"  // confirm → done
    | "cancel-skip"   // resume tour
    | "escape"        // Échap → skip-confirm
    | "external-action" // user staged/committed → auto-close
    | "howto";         // "Comment ça marche" → reopen tools
}

export type OnboardingInstrumentEvent = "onboarding_started" | "onboarding_skipped" | "first_pixel_placed";

export interface GuidedOnboardingCallbacks {
  onAim?: () => void;
  onEvent?: (event: OnboardingInstrumentEvent, timestampMs: number) => void;
}

/** localStorage-backed per-canvas welcome storage. */
export interface WelcomeStorage {
  hasSeen: (canvasId: string) => boolean;
  markSeen: (canvasId: string) => void;
}

export function createLocalWelcomeStorage(): WelcomeStorage | null {
  const PREFIX = "liveplace.onboarding.welcome.";
  try {
    localStorage.getItem(PREFIX + "probe"); // test access
    return {
      hasSeen: (canvasId) => {
        try { return localStorage.getItem(PREFIX + canvasId) === "1"; } catch { return false; }
      },
      markSeen: (canvasId) => {
        try { localStorage.setItem(PREFIX + canvasId, "1"); } catch { /* ignore */ }
      },
    };
  } catch { return null; }
}

export interface TriggerInput {
  authenticated: boolean;
  /** placeState.kind from derivePlaceState */
  placeKind: string;
  /** True if this user owns the canvas (skip onboarding for owners) */
  isOwner: boolean;
  canvasId: string | null;
  welcomeStorage: WelcomeStorage | null;
  modelLearned: boolean;
}

const DEAD_END_STATES = new Set(["notFound", "archived", "banned", "ended"]);
const DEFER_STATES = new Set(["offline", "loading"]);

/** Returns true when the trigger conditions are ALL met (§3). */
export function shouldTrigger(input: TriggerInput): boolean {
  const { authenticated, placeKind, isOwner, canvasId, welcomeStorage, modelLearned } = input;
  if (!authenticated) return false;
  if (isOwner) return false;
  if (DEAD_END_STATES.has(placeKind)) return false;
  if (DEFER_STATES.has(placeKind)) return false; // E5: defer, don't block
  if (!canvasId) return false;
  if (welcomeStorage?.hasSeen(canvasId)) return false;
  if (modelLearned) return false;
  return true;
}

/**
 * Pure state machine for the guided onboarding gate.
 * Stateless transitions: each send() returns a new GateState.
 */
export function transition(state: GateState, event: GuidedOnboardingEvent["type"]): GateState {
  switch (state) {
    case "hidden":
      if (event === "trigger") return "welcome";
      if (event === "howto") return "tools";
      return "hidden";

    case "welcome":
      if (event === "start") return "tools";
      if (event === "skip" || event === "escape") return "skip-confirm";
      if (event === "external-action") return "done";
      return "welcome";

    case "tools":
      if (event === "place-first") return "done";
      if (event === "skip" || event === "escape") return "skip-confirm";
      if (event === "external-action") return "done";
      if (event === "howto") return "tools"; // already there
      return "tools";

    case "skip-confirm":
      if (event === "confirm-skip") return "done";
      if (event === "cancel-skip") {
        // Return to the step that triggered skip — we don't track it, re-show tools
        return "tools";
      }
      return "skip-confirm";

    case "done":
      if (event === "howto") return "tools"; // always reachable
      return "done";
  }
}

/**
 * Managed guided-onboarding controller with side-effects (persistence, callbacks).
 * Wraps the pure transition function and handles storage writes.
 */
export class GuidedOnboardingController {
  private _state: GateState = "hidden";
  private canvasId: string | null = null;
  private welcomeStorage: WelcomeStorage | null;
  private callbacks: GuidedOnboardingCallbacks;
  private startedAt: number | null = null;

  constructor(opts: {
    welcomeStorage: WelcomeStorage | null;
    callbacks?: GuidedOnboardingCallbacks;
  }) {
    this.welcomeStorage = opts.welcomeStorage;
    this.callbacks = opts.callbacks ?? {};
  }

  get state(): GateState { return this._state; }

  /** Check trigger conditions and open the gate if eligible. */
  tryTrigger(input: TriggerInput): void {
    if (this._state !== "hidden") return;
    if (!shouldTrigger(input)) return;
    this.canvasId = input.canvasId;
    this._state = transition(this._state, "trigger");
    if (this._state !== "hidden") {
      this.startedAt = Date.now();
      this.callbacks.onEvent?.("onboarding_started", this.startedAt);
      // Mark welcome as seen immediately so a reload doesn't re-show Temps 1.
      if (this.canvasId) this.welcomeStorage?.markSeen(this.canvasId);
    }
  }

  send(event: GuidedOnboardingEvent["type"]): void {
    const prev = this._state;
    this._state = transition(this._state, event);

    if (event === "confirm-skip" && prev !== "done") {
      this.callbacks.onEvent?.("onboarding_skipped", Date.now());
    }

    if ((event === "place-first" || event === "external-action") && prev !== "done") {
      if (event === "place-first") {
        this.callbacks.onAim?.();
      }
    }
  }

  /** Call on a real placement commit (`placed` feedback) for time-to-first-pixel. */
  notifyFirstPixelPlaced(): void {
    this.callbacks.onEvent?.("first_pixel_placed", Date.now());
  }

  /** "Comment ça marche" — always reopen Temps 2 regardless of gate state. */
  openHowto(): void {
    this._state = transition(this._state, "howto");
  }
}
