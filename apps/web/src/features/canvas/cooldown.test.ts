/**
 * Tests for the FEN-119 cooldown engagement model — the Definition-of-Done
 * surface for UX Lot F ("tests automatisés = DoD").
 *   node --test apps/web/src/features/canvas/cooldown.test.ts
 *
 * Covers the acceptance criteria:
 *   - during cooldown the user may AIM/ARM the next cell (capacity ≥ 1 at 0
 *     charges, where Lot E's batch cap was 0 → frozen)
 *   - sobriety: arming is capped at exactly ONE next cell — never the full
 *     réserve, so there is no multi-pixel "skip cooldown"
 *   - at refill the armed cell drops in a single gesture (readyToFire)
 *   - the wait reads as anticipation, not a block: every phase carries a
 *     forward-oriented TEXT key, and both catalogs (FR + EN) provide a string
 *   - the arming window aligns exactly with Lot E's `cooldown` edge (empty gauge)
 *   - a live, monotonically-decreasing countdown
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveCooldownView,
  armingCapacity,
  type CooldownInput,
  type CooldownPhase,
} from "./cooldown.ts";
import type { MessageKey } from "@canvas/i18n";
import { en } from "../../../../../packages/i18n/src/messages/en.ts";
import { fr } from "../../../../../packages/i18n/src/messages/fr.ts";

const NOW = 1_700_000_000_000;

function view(over: Partial<CooldownInput> = {}) {
  return deriveCooldownView({
    charges: 0,
    cooldownUntil: NOW + 30_000,
    now: NOW,
    staged: 0,
    ...over,
  });
}

// ── Arming during cooldown (the core of the lot) ────────────────────────────

test("empty gauge ⇒ on cooldown, and one cell may still be armed", () => {
  const v = view({ charges: 0, staged: 0 });
  assert.equal(v.onCooldown, true);
  assert.equal(v.capacity, 1, "the next cell can be pre-aimed even at 0 charges");
  assert.equal(v.canArm, true);
});

test("arming is capped at ONE next cell — no multi-pixel skip-cooldown", () => {
  // Already armed the one allowed cell: no more arming this cooldown.
  const v = view({ charges: 0, staged: 1 });
  assert.equal(v.capacity, 1);
  assert.equal(v.canArm, false, "a second cell cannot be armed while cooling");
  assert.equal(v.phase, "armed");
});

test("armingCapacity: charges when ready, exactly one while cooling", () => {
  assert.equal(armingCapacity(5, false), 5);
  assert.equal(armingCapacity(0, true), 1);
  assert.equal(armingCapacity(3, true), 1, "cooling caps at one regardless of charges arg");
  assert.equal(armingCapacity(-2, false), 0, "never negative");
});

// ── Refill → one-gesture drop ───────────────────────────────────────────────

test("refill with an armed cell ⇒ ready to fire in one gesture", () => {
  const v = view({ charges: 1, staged: 1 });
  assert.equal(v.onCooldown, false);
  assert.equal(v.readyToFire, true);
  assert.equal(v.phase, "refilledArmed");
  assert.equal(v.messageKey, "canvas.cooldown.ready");
});

test("charges available but nothing armed ⇒ plain ready, no extra line", () => {
  const v = view({ charges: 3, staged: 0 });
  assert.equal(v.phase, "ready");
  assert.equal(v.readyToFire, false);
  assert.equal(v.messageKey, null, "Lot E's indicator owns the plain ready copy");
  assert.equal(v.capacity, 3);
});

// ── Forward-oriented copy per phase ─────────────────────────────────────────

test("waiting (cooling, nothing armed) invites aiming the next cell", () => {
  const v = view({ charges: 0, staged: 0 });
  assert.equal(v.phase, "waiting");
  assert.equal(v.messageKey, "canvas.cooldown.waiting");
  // FEN-165: the phase message no longer carries {seconds} (the announced text
  // must stay static so a polite live region doesn't spam every tick). The
  // ticking value lives on `secondsUntilNext` for the aria-hidden visual span.
  assert.equal(v.params, undefined);
  assert.equal(v.secondsUntilNext, 30);
});

test("armed (cooling, one armed) announces the upcoming drop", () => {
  const v = view({ charges: 0, staged: 1 });
  assert.equal(v.messageKey, "canvas.cooldown.armed");
  // FEN-165: no {seconds} in the announced message; countdown via secondsUntilNext.
  assert.equal(v.params, undefined);
  assert.equal(v.secondsUntilNext, 30);
});

test("every non-null phase key exists in BOTH catalogs (FR/EN parity)", () => {
  const keys = new Set<MessageKey>();
  for (const charges of [0, 1]) {
    for (const staged of [0, 1]) {
      const v = deriveCooldownView({ charges, cooldownUntil: NOW + 5_000, now: NOW, staged });
      if (v.messageKey) keys.add(v.messageKey);
    }
  }
  // The Lot F additions must all be reachable and present in both locales.
  assert.ok(keys.has("canvas.cooldown.waiting"));
  assert.ok(keys.has("canvas.cooldown.armed"));
  assert.ok(keys.has("canvas.cooldown.ready"));
  for (const k of keys) {
    assert.equal(typeof en[k], "string", `en missing ${k}`);
    assert.equal(typeof fr[k], "string", `fr missing ${k}`);
  }
  // The mobile arm-button label also needs FR/EN strings.
  assert.equal(typeof en["canvas.armHere"], "string");
  assert.equal(typeof fr["canvas.armHere"], "string");
});

// ── Live countdown ──────────────────────────────────────────────────────────

test("countdown ceils to whole seconds and floors at zero", () => {
  assert.equal(view({ cooldownUntil: NOW + 1 }).secondsUntilNext, 1);
  assert.equal(view({ cooldownUntil: NOW + 2_400 }).secondsUntilNext, 3);
  assert.equal(view({ cooldownUntil: NOW - 5_000 }).secondsUntilNext, 0, "past deadline never negative");
});

test("countdown decreases monotonically as time advances", () => {
  const until = NOW + 10_000;
  const a = deriveCooldownView({ charges: 0, cooldownUntil: until, now: NOW, staged: 0 });
  const b = deriveCooldownView({ charges: 0, cooldownUntil: until, now: NOW + 4_000, staged: 0 });
  assert.ok(b.secondsUntilNext < a.secondsUntilNext);
});

test("not cooling ⇒ no countdown", () => {
  assert.equal(view({ charges: 2 }).secondsUntilNext, 0);
});

// ── Phase exhaustiveness (every phase reachable & distinct) ──────────────────

test("all four phases are reachable", () => {
  const seen = new Set<CooldownPhase>();
  seen.add(view({ charges: 0, staged: 0 }).phase); // waiting
  seen.add(view({ charges: 0, staged: 1 }).phase); // armed
  seen.add(view({ charges: 1, staged: 1 }).phase); // refilledArmed
  seen.add(view({ charges: 1, staged: 0 }).phase); // ready
  assert.deepEqual([...seen].sort(), ["armed", "ready", "refilledArmed", "waiting"]);
});
