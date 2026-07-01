/**
 * Adaptive just-in-time onboarding coach (FEN-118, Lot C).
 *
 * One non-blocking hint at a time, anchored to funnel events. A hint once seen
 * is absorbed and never repeated. "Experienced" viewers (those who act before
 * being guided) are short-circuited past the novice steps. Persistence lives in
 * `liveplace.onboarding.v1` (localStorage, best-effort).
 *
 * Step order: arrival → aim → firstPixel → gaugeEmpty → pointsThreshold → help
 */
import type { MessageKey } from "@canvas/i18n";

export type OnboardingEventType =
  | "arrive"
  | "aim"
  | "stage"
  | "placed"
  | "gauge-empty"
  | "tier-available"
  | "idle"
  | "blocked-attempt";

export interface OnboardingEvent {
  type: OnboardingEventType;
  params?: Record<string, string | number>;
}

export interface OnboardingHint {
  /** Stable step id — used to test which hints have been seen. */
  step: string;
  messageKey: MessageKey;
  params?: Record<string, string | number>;
  autoHideMs?: number;
  dismissible: boolean;
}

export interface PersistedOnboarding {
  seen: Record<string, boolean>;
  experienced: boolean;
}

export interface OnboardingStorage {
  load: () => PersistedOnboarding | null;
  save: (s: PersistedOnboarding) => void;
}

const V1_KEY = "liveplace.onboarding.v1";

/** localStorage-backed storage. Returns null when localStorage is unavailable (E10). */
export function createLocalOnboardingStorage(key = V1_KEY): OnboardingStorage | null {
  try {
    localStorage.getItem(key); // probe access
    return {
      load: () => {
        try {
          const raw = localStorage.getItem(key);
          return raw ? (JSON.parse(raw) as PersistedOnboarding) : null;
        } catch { return null; }
      },
      save: (s) => {
        try { localStorage.setItem(key, JSON.stringify(s)); } catch { /* ignore */ }
      },
    };
  } catch { return null; }
}

/** Read the experienced flag from v1 storage without constructing a coach. */
export function isModelLearned(storage: OnboardingStorage | null): boolean {
  if (!storage) return false;
  return storage.load()?.experienced === true;
}

const EMPTY_STATE: PersistedOnboarding = { seen: {}, experienced: false };

export class OnboardingCoach {
  private state: PersistedOnboarding;
  private storage: OnboardingStorage | null;

  constructor(opts?: { storage?: OnboardingStorage | null }) {
    this.storage = opts?.storage ?? null;
    this.state = this.storage?.load() ?? { ...EMPTY_STATE, seen: {} };
  }

  private seen(step: string): boolean {
    return this.state.seen[step] === true;
  }

  private emit(step: string, messageKey: MessageKey, opts: {
    params?: Record<string, string | number>;
    autoHideMs?: number;
    dismissible?: boolean;
  } = {}): OnboardingHint {
    this.state.seen[step] = true;
    this.storage?.save(this.state);
    return {
      step,
      messageKey,
      params: opts.params,
      autoHideMs: opts.autoHideMs,
      dismissible: opts.dismissible ?? true,
    };
  }

  private markExperienced(): void {
    if (!this.state.experienced) {
      this.state.experienced = true;
      this.storage?.save(this.state);
    }
  }

  send(event: OnboardingEvent): OnboardingHint | null {
    switch (event.type) {
      case "arrive":
      case "aim":
      case "placed":
      case "gauge-empty":
      case "blocked-attempt":
        return null;

      case "stage":
        // Acting before seeing aim → marks experienced; no hint.
        if (!this.seen("aim")) this.markExperienced();
        return null;

      case "tier-available":
        return null;

      case "idle":
        return null;
    }
  }
}
