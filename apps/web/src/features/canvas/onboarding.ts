/**
 * Adaptive just-in-time viewer onboarding (FEN-118, Lot C) — a framework-agnostic
 * coach that decides WHICH contextual hint (if any) to surface at each step of the
 * viewer funnel, learns the user's profile implicitly from behaviour, and never
 * shows a hint twice once it has been absorbed.
 *
 * Design (ux-spec §D9, impl-breakdown Lot C):
 *   - "Apprendre en faisant": hints are anchored to funnel events (arrival, first
 *     aim, first pixel, first empty gauge, first reserve threshold, hesitation),
 *     never to a blocking modal or a wall of text.
 *   - Progressive disclosure: at most ONE hint is active at a time; milestone
 *     feedback (a placed pixel, an empty gauge) outranks passive nudges.
 *   - "Court-circuité pour les connaisseurs": a user who acts immediately graduates
 *     the basic steps BY ACTION (the hint is absorbed, never shown) and is flagged
 *     `experienced` — basic nudges and the hesitation prompt are then suppressed.
 *   - Implicit profile detection: we never ask "are you a beginner?"; we watch the
 *     behaviour (acting fast ⇒ efface; hesitating / hitting a wall ⇒ offer help).
 *   - Persistence: "seen" is remembered per step (via an injectable storage) so an
 *     absorbed hint never reappears, even across reloads/sessions.
 *
 * This module is pure logic (no DOM, no React) so the Definition-of-Done — the
 * automated test suite — can drive the whole funnel deterministically.
 * UI (banner style, motion, illustrations) is delegated (out of scope, see Lot C).
 */
import type { MessageKey } from "@canvas/i18n";

/** Funnel steps, in entonnoir order. Each maps to one contextual hint. */
export const ONBOARDING_STEPS = [
  "arrival",
  "aim",
  "firstPixel",
  "gaugeEmpty",
  "pointsThreshold",
  "hesitation",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** The "basics" — nudges that teach the core gesture and are court-circuités for connaisseurs. */
const BASIC_STEPS: ReadonlySet<OnboardingStep> = new Set(["arrival", "aim", "hesitation"]);

export type HintParams = Record<string, string | number>;

/** A hint to render. `messageKey` flows through `@canvas/i18n` so it is FR/EN in place. */
export interface OnboardingHint {
  step: OnboardingStep;
  messageKey: MessageKey;
  /** Whether the user can explicitly dismiss it (hesitation + manual recall). */
  dismissible: boolean;
  /** Auto-hide delay in ms, or `null` to keep it until graduated/dismissed. */
  autoHideMs: number | null;
  params?: HintParams;
}

/** Behaviour signals fed in by the surface (CanvasView) as the viewer progresses. */
export type OnboardingEvent =
  | { type: "arrive" }
  | { type: "aim" } // first hover / mobile cell reveal
  | { type: "stage" } // staged a cell into the batch (a productive action)
  | { type: "commit" } // validated the batch
  | { type: "placed" } // a pixel landed on the canvas — the "aha"
  | { type: "gauge-empty"; params?: HintParams } // ran out of pixels (cooldown begins)
  | { type: "gauge-grew"; params?: HintParams } // reserve max grew (Lot D claim / points threshold)
  | { type: "idle" } // hesitation timer fired (inactive a few seconds)
  | { type: "blocked-attempt" } // tried an action that can't go through (cap / locked)
  | { type: "dismiss" }; // user dismissed the active hint

interface StepMeta {
  key: MessageKey;
  dismissible: boolean;
  autoHideMs: number | null;
  /** Higher priority replaces a lower-priority active hint; equal/lower does not. */
  priority: number;
}

const STEP_META: Record<OnboardingStep, StepMeta> = {
  arrival: { key: "canvas.onboarding.arrival", dismissible: false, autoHideMs: 5000, priority: 0 },
  aim: { key: "canvas.onboarding.aim", dismissible: false, autoHideMs: null, priority: 1 },
  firstPixel: { key: "canvas.onboarding.firstPixel", dismissible: false, autoHideMs: 5000, priority: 3 },
  gaugeEmpty: { key: "canvas.onboarding.gaugeEmpty", dismissible: false, autoHideMs: 5000, priority: 3 },
  pointsThreshold: { key: "canvas.onboarding.pointsThreshold", dismissible: false, autoHideMs: 5000, priority: 3 },
  hesitation: { key: "canvas.onboarding.help", dismissible: true, autoHideMs: null, priority: 1 },
};

export type OnboardingProfile = "novice" | "experienced";

export interface PersistedOnboarding {
  seen: OnboardingStep[];
  experienced: boolean;
}

/** Pluggable persistence so "seen per step" survives reloads (and tests can inject a fake). */
export interface OnboardingStorage {
  load(): PersistedOnboarding | null;
  save(state: PersistedOnboarding): void;
}

export interface OnboardingOptions {
  storage?: OnboardingStorage | null;
}

export class OnboardingCoach {
  private readonly storage: OnboardingStorage | null;
  private readonly seen = new Set<OnboardingStep>();
  private experienced = false;
  private active: OnboardingHint | null = null;

  constructor(opts: OnboardingOptions = {}) {
    this.storage = opts.storage ?? null;
    const loaded = this.storage?.load() ?? null;
    if (loaded) {
      for (const s of loaded.seen) this.seen.add(s);
      this.experienced = loaded.experienced;
    }
  }

  /** The hint currently to display, or `null`. */
  get current(): OnboardingHint | null {
    return this.active;
  }

  get profile(): OnboardingProfile {
    return this.experienced ? "experienced" : "novice";
  }

  get seenSteps(): readonly OnboardingStep[] {
    return [...this.seen];
  }

  /** Feed a behaviour signal; returns the (possibly updated) active hint. */
  send(event: OnboardingEvent): OnboardingHint | null {
    switch (event.type) {
      case "arrive":
        this.maybeShow("arrival");
        break;
      case "aim":
        this.absorb("arrival"); // aiming graduates the arrival nudge
        this.maybeShow("aim");
        break;
      case "stage":
        // Staging a cell is the demonstration that the viewer found the gesture:
        // efface — stop nudging (the hesitation prompt is suppressed from here on).
        this.experienced = true;
        this.absorb("arrival");
        this.absorb("aim");
        break;
      case "commit":
        this.absorb("arrival");
        this.absorb("aim");
        break;
      case "placed":
        this.maybeShow("firstPixel");
        break;
      case "gauge-empty":
        this.maybeShow("gaugeEmpty", event.params);
        break;
      case "gauge-grew":
        this.maybeShow("pointsThreshold", event.params);
        break;
      case "idle":
        // A connaisseur is never bothered by the hesitation prompt.
        if (!this.experienced) this.maybeShow("hesitation");
        break;
      case "blocked-attempt":
        // Hitting a wall ⇒ offer help even to an experienced user (ux-spec §D9).
        this.maybeShow("hesitation", undefined, true);
        break;
      case "dismiss":
        if (this.active) {
          this.markSeen(this.active.step);
          this.active = null;
        }
        break;
    }
    this.persist();
    return this.active;
  }

  /**
   * Manual recall ("Comment ça marche") — always available (rang 3) so a
   * connaisseur can re-read the core gesture without being blocked. Bypasses
   * `seen` / `experienced`; the user dismisses it when done.
   */
  recall(): OnboardingHint {
    const meta = STEP_META.aim;
    this.active = { step: "aim", messageKey: meta.key, dismissible: true, autoHideMs: 6000 };
    return this.active;
  }

  /** Hide the active hint (e.g. auto-hide elapsed) without un-seeing it. */
  clearActive(): void {
    this.active = null;
  }

  private maybeShow(step: OnboardingStep, params?: HintParams, force = false): void {
    if (!force) {
      if (this.seen.has(step)) return; // absorbed — never re-show
      if (this.experienced && BASIC_STEPS.has(step)) return; // efface for connaisseurs
    }
    const meta = STEP_META[step];
    // Progressive disclosure: a lower-priority hint never buries an active higher one.
    if (this.active && meta.priority < STEP_META[this.active.step].priority) return;
    this.active = {
      step,
      messageKey: meta.key,
      dismissible: meta.dismissible,
      autoHideMs: meta.autoHideMs,
      params,
    };
    this.markSeen(step); // showing once is enough
  }

  /** Graduate a step by action: mark seen and drop it if it is the active hint. */
  private absorb(step: OnboardingStep): void {
    if (this.active?.step === step) this.active = null;
    this.markSeen(step);
  }

  private markSeen(step: OnboardingStep): void {
    this.seen.add(step);
  }

  private persist(): void {
    this.storage?.save({ seen: [...this.seen], experienced: this.experienced });
  }
}

const DEFAULT_STORAGE_KEY = "liveplace.onboarding.v1";

/**
 * localStorage-backed storage, or `null` when no usable storage exists (SSR /
 * private mode). Failures are swallowed — onboarding must never break the canvas.
 */
export function createLocalOnboardingStorage(key: string = DEFAULT_STORAGE_KEY): OnboardingStorage | null {
  let ls: Storage;
  try {
    if (typeof localStorage === "undefined") return null;
    ls = localStorage;
  } catch {
    return null;
  }
  return {
    load() {
      try {
        const raw = ls.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<PersistedOnboarding>;
        const seen = Array.isArray(parsed.seen)
          ? parsed.seen.filter((s): s is OnboardingStep => (ONBOARDING_STEPS as readonly string[]).includes(s))
          : [];
        return { seen, experienced: Boolean(parsed.experienced) };
      } catch {
        return null;
      }
    },
    save(state) {
      try {
        ls.setItem(key, JSON.stringify(state));
      } catch {
        /* quota / disabled — ignore, onboarding is best-effort */
      }
    },
  };
}
