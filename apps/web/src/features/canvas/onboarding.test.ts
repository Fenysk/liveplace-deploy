/**
 * Tests for the FEN-118 adaptive onboarding coach — the Definition-of-Done for
 * Lot C ("onboarding viewer adaptatif, just-in-time").
 *   node --test apps/web/src/features/canvas/onboarding.test.ts
 *
 * Covers the acceptance criteria (ux-spec §D9, impl-breakdown Lot C):
 *   - a néophyte learns quoi/comment/coût BEFORE their first failure
 *   - a connaisseur is never blocked by a tutorial (hints court-circuités by action)
 *   - no mandatory modal / wall of text — at most one non-blocking hint at a time
 *   - a hint never reappears once absorbed (persistence "vu" par étape)
 *   - implicit profile detection from behaviour (never asks "es-tu débutant ?")
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  OnboardingCoach,
  ONBOARDING_STEPS,
  type OnboardingStorage,
  type PersistedOnboarding,
} from "./onboarding.ts";

/** In-memory storage double so the funnel is fully deterministic. */
function fakeStorage(initial?: PersistedOnboarding): OnboardingStorage & { state: PersistedOnboarding | null } {
  return {
    state: initial ?? null,
    load() {
      return this.state;
    },
    save(s) {
      this.state = s;
    },
  };
}

test("néophyte funnel: learns quoi/comment/coût before the first failure", () => {
  const coach = new OnboardingCoach();

  // Arrival: a one-line invite to act.
  assert.equal(coach.send({ type: "arrive" })?.step, "arrival");

  // First aim: the "how" (vise une case, choisis ta couleur). Arrival is absorbed.
  const aim = coach.send({ type: "aim" });
  assert.equal(aim?.step, "aim");

  // First placed pixel: the "aha" + the cost lesson (limited, refills over time)…
  const placed = coach.send({ type: "placed" });
  assert.equal(placed?.step, "firstPixel");

  // …which lands BEFORE the first empty gauge (the first possible "failure").
  const empty = coach.send({ type: "gauge-empty", params: { seconds: 9 } });
  assert.equal(empty?.step, "gaugeEmpty");
  assert.equal(empty?.params?.seconds, 9);

  // Profile stays novice — they leaned on the hints.
  assert.equal(coach.profile, "novice");
});

test("connaisseur: acting immediately short-circuits the basic hints, flags experienced", () => {
  const coach = new OnboardingCoach();
  coach.send({ type: "arrive" }); // arrival nudge shows…

  // …but the user stages a cell straight away, before reading aim.
  const afterStage = coach.send({ type: "stage" });
  assert.equal(afterStage, null, "acting clears the basic nudge");
  assert.equal(coach.profile, "experienced", "fast action ⇒ implicit experienced profile");

  // A later aim does NOT resurrect the aim hint (absorbed by action).
  assert.equal(coach.send({ type: "aim" }), null);
  // And the hesitation prompt is suppressed for a connaisseur.
  assert.equal(coach.send({ type: "idle" }), null);
});

test("a hint never reappears once absorbed (within a session)", () => {
  const coach = new OnboardingCoach();
  assert.equal(coach.send({ type: "arrive" })?.step, "arrival");
  coach.clearActive();
  // Re-entering the same trigger does not re-show it.
  assert.equal(coach.send({ type: "arrive" }), null);

  assert.equal(coach.send({ type: "aim" })?.step, "aim");
  coach.clearActive();
  assert.equal(coach.send({ type: "aim" }), null);
});

test("persistence: an absorbed step does not reappear in a fresh session", () => {
  const storage = fakeStorage();
  const first = new OnboardingCoach({ storage });
  first.send({ type: "arrive" });
  first.send({ type: "aim" });
  first.send({ type: "placed" });

  // New coach, same storage (reload) — none of the seen steps fire again.
  const reloaded = new OnboardingCoach({ storage });
  assert.equal(reloaded.send({ type: "arrive" }), null);
  assert.equal(reloaded.send({ type: "aim" }), null);
  assert.equal(reloaded.send({ type: "placed" }), null);
});

test("persistence: a returning connaisseur stays experienced (basics suppressed)", () => {
  const storage = fakeStorage();
  const first = new OnboardingCoach({ storage });
  first.send({ type: "stage" }); // becomes experienced
  assert.equal(first.profile, "experienced");

  const reloaded = new OnboardingCoach({ storage });
  assert.equal(reloaded.profile, "experienced");
  assert.equal(reloaded.send({ type: "arrive" }), null, "arrival suppressed for returning connaisseur");
});

test("progressive disclosure: a milestone outranks a passive nudge, never the reverse", () => {
  const coach = new OnboardingCoach();
  coach.send({ type: "arrive" }); // low-priority arrival active

  // A placed pixel (milestone) replaces the arrival nudge.
  assert.equal(coach.send({ type: "placed" })?.step, "firstPixel");

  // Idle while a milestone is showing does not bury it.
  assert.equal(coach.send({ type: "idle" })?.step, "firstPixel");
});

test("hesitation: idle offers help once for a novice; a wall offers it even to a connaisseur", () => {
  const novice = new OnboardingCoach();
  assert.equal(novice.send({ type: "idle" })?.step, "hesitation");
  novice.send({ type: "dismiss" });
  assert.equal(novice.send({ type: "idle" }), null, "help is not nagging — shown once");

  // A blocked attempt (cap / locked) surfaces help regardless of profile.
  const pro = new OnboardingCoach();
  pro.send({ type: "stage" }); // experienced now
  assert.equal(pro.send({ type: "idle" }), null, "no idle nag for a connaisseur");
  assert.equal(pro.send({ type: "blocked-attempt" })?.step, "hesitation", "but a wall still offers help");
});

test("gauge-grew surfaces the reserve-threshold causality hint once, with params", () => {
  const coach = new OnboardingCoach();
  const grew = coach.send({ type: "gauge-grew", params: { max: 6 } });
  assert.equal(grew?.step, "pointsThreshold");
  assert.equal(grew?.params?.max, 6);
  coach.clearActive();
  assert.equal(coach.send({ type: "gauge-grew" }), null, "shown once");
});

test("recall: 'how it works' is always available, even for a connaisseur", () => {
  const coach = new OnboardingCoach();
  coach.send({ type: "stage" }); // experienced, aim absorbed
  assert.equal(coach.send({ type: "aim" }), null);
  // Manual recall bypasses seen/experienced.
  const recalled = coach.recall();
  assert.equal(recalled.step, "aim");
  assert.equal(recalled.dismissible, true);
});

test("no hint key is missing from the funnel step list", () => {
  // Guards against adding a step without wiring its metadata.
  assert.equal(ONBOARDING_STEPS.length, new Set(ONBOARDING_STEPS).size);
  assert.ok(ONBOARDING_STEPS.includes("firstPixel"));
});
