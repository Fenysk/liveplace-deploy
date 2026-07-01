/**
 * Guided onboarding gate (G2) — sequencing invariant tests (FEN-710 AC3).
 *
 * Key invariant: coach and G2 gate must never render simultaneously.
 * The render guard in CanvasView suppresses the coach pill while the gate is
 * active (welcome/tools/skip-confirm). These tests document the gate states
 * that are considered "active" so the guard stays correct through refactors.
 *
 *   node --test apps/web/src/features/canvas/guidedOnboarding.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  shouldTrigger,
  transition,
  GuidedOnboardingController,
  type GateState,
  type TriggerInput,
} from "./guidedOnboarding.ts";
import { OnboardingCoach } from "./onboarding.ts";

/** Mirrors the render guard in CanvasView — true means coach must be hidden. */
function isGateActive(state: GateState): boolean {
  return state !== "hidden" && state !== "done";
}

// ── shouldTrigger ────────────────────────────────────────────────────────────

test("shouldTrigger: true for authenticated first-visit viewer (the bug precondition)", () => {
  const seen = new Set<string>();
  const input: TriggerInput = {
    authenticated: true,
    placeKind: "canPlace",
    isOwner: false,
    canvasId: "abc123",
    welcomeStorage: {
      hasSeen: (id) => seen.has(id),
      markSeen: (id) => { seen.add(id); },
    },
    modelLearned: false,
  };
  assert.equal(shouldTrigger(input), true);
});

test("shouldTrigger: false for unauthenticated viewer", () => {
  const input: TriggerInput = {
    authenticated: false,
    placeKind: "canPlace",
    isOwner: false,
    canvasId: "abc123",
    welcomeStorage: null,
    modelLearned: false,
  };
  assert.equal(shouldTrigger(input), false);
});

test("shouldTrigger: false once model is learned (experienced viewer)", () => {
  const input: TriggerInput = {
    authenticated: true,
    placeKind: "canPlace",
    isOwner: false,
    canvasId: "abc123",
    welcomeStorage: null,
    modelLearned: true,
  };
  assert.equal(shouldTrigger(input), false);
});

// ── Gate active states (render-guard invariant) ───────────────────────────────

test("isGateActive: welcome/tools/skip-confirm suppress the coach", () => {
  assert.equal(isGateActive("welcome"), true);
  assert.equal(isGateActive("tools"), true);
  assert.equal(isGateActive("skip-confirm"), true);
});

test("isGateActive: hidden/done allow the coach", () => {
  assert.equal(isGateActive("hidden"), false);
  assert.equal(isGateActive("done"), false);
});

// ── State machine transitions ─────────────────────────────────────────────────

test("transition: trigger opens gate to welcome", () => {
  assert.equal(transition("hidden", "trigger"), "welcome");
});

test("transition: welcome → tools → done (happy path)", () => {
  let s = transition("hidden", "trigger");
  assert.equal(s, "welcome");
  s = transition(s, "start");
  assert.equal(s, "tools");
  s = transition(s, "place-first");
  assert.equal(s, "done");
  assert.equal(isGateActive(s), false, "gate inactive after done — coach can show");
});

test("transition: skip path → done, coach unlocked", () => {
  let s: GateState = "welcome";
  s = transition(s, "skip");
  assert.equal(s, "skip-confirm");
  s = transition(s, "confirm-skip");
  assert.equal(s, "done");
  assert.equal(isGateActive(s), false, "gate inactive after confirm-skip");
});

test("transition: external-action closes gate from any active step", () => {
  for (const step of ["welcome", "tools"] as const) {
    const s = transition(step, "external-action");
    assert.equal(s, "done");
    assert.equal(isGateActive(s), false);
  }
});

// ── Sequencing invariant: coach tier-available vs gate ────────────────────────

test("AC3 invariant: coach tier-available emits no hint (pointsThreshold bubble removed)", () => {
  // pointsThreshold hint was removed per FEN-1292 (Alexis board request).
  // tier-available no longer triggers any coachmark.
  const coach = new OnboardingCoach();
  const hint = coach.send({ type: "tier-available" });

  assert.equal(hint, null, "coach must not emit any hint for tier-available");
});
