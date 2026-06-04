/**
 * Streamer crisis panel view-model tests (Lot I, FEN-121) — Definition-of-Done.
 *
 * Logic-only (no DOM/Convex), matching the web `test` script. Covers the lot's
 * acceptance ("trouver gel/ban/wipe en < 10 s sous stress") as pure invariants:
 *   - there is ALWAYS exactly one 1-gesture primary control (freeze, then reopen)
 *   - ban + wipe are grouped and appear ONLY once frozen (Flow S3 "une fois gelé")
 *   - wiping carries the §2.5 "underneath reappears" warning + a restore pairing
 *   - the first-crisis freeze hint shows once, then never (D9 persistence)
 *   - each action names the correct Convex moderation.ts backend function
 *   - every returned i18n key resolves in BOTH catalogs (FR/EN parity, C6 label).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCrisisPanel, type CrisisActionLabelKey } from "./crisisView.ts";
import { en } from "../../../../../packages/i18n/src/messages/en.ts";
import { fr } from "../../../../../packages/i18n/src/messages/fr.ts";

test("calm (placement open): a single 1-gesture primary = freeze, no triage group", () => {
  const v = buildCrisisPanel({ placementOpen: true });
  assert.equal(v.phase, "calm");
  assert.equal(v.primary.id, "freeze");
  assert.equal(v.primary.emphasis, "primary");
  assert.equal(v.primary.backend, "setFrozen");
  assert.equal(v.primary.destructive, false);
  assert.deepEqual(v.group, []); // calm surface stays unambiguous: one button
  assert.equal(v.wipeWarningKey, null);
  assert.equal(v.statusKey, "studio.crisis.status.calm");
});

test("frozen (placement paused): primary flips to reopen, grouped [ban, wipe] appear", () => {
  const v = buildCrisisPanel({ placementOpen: false });
  assert.equal(v.phase, "frozen");
  assert.equal(v.primary.id, "reopen");
  assert.equal(v.primary.backend, "setFrozen");
  assert.deepEqual(
    v.group.map((a) => a.id),
    ["ban", "wipe"],
  );
  assert.ok(v.group.every((a) => a.emphasis === "grouped"));
});

test("ban + wipe are destructive and map to their Convex moderation functions", () => {
  const v = buildCrisisPanel({ placementOpen: false });
  const ban = v.group.find((a) => a.id === "ban");
  const wipe = v.group.find((a) => a.id === "wipe");
  assert.ok(ban && wipe);
  assert.equal(ban.backend, "banAndWipe");
  assert.equal(wipe.backend, "deletePixels");
  assert.ok(ban.destructive && wipe.destructive);
});

test("the panic button is always reachable: a primary exists in BOTH phases", () => {
  assert.ok(buildCrisisPanel({ placementOpen: true }).primary);
  assert.ok(buildCrisisPanel({ placementOpen: false }).primary);
});

test("wipe carries the §2.5 'underneath reappears' warning once frozen", () => {
  const v = buildCrisisPanel({ placementOpen: false });
  assert.equal(v.wipeWarningKey, "studio.crisis.wipeWarning");
});

test("first-crisis freeze hint: shown when unseen + open, suppressed after seen", () => {
  assert.equal(
    buildCrisisPanel({ placementOpen: true, freezeHintSeen: false }).firstCrisisHintKey,
    "studio.crisis.firstHint",
  );
  assert.equal(
    buildCrisisPanel({ placementOpen: true, freezeHintSeen: true }).firstCrisisHintKey,
    null,
  );
  // never nag mid-crisis: no hint once frozen, regardless of the seen flag
  assert.equal(
    buildCrisisPanel({ placementOpen: false, freezeHintSeen: false }).firstCrisisHintKey,
    null,
  );
});

test("pending: only the in-flight action is marked pending (idempotency guard)", () => {
  const v = buildCrisisPanel({ placementOpen: false, pendingAction: "ban" });
  assert.equal(v.group.find((a) => a.id === "ban")?.pending, true);
  assert.equal(v.group.find((a) => a.id === "wipe")?.pending, false);
  assert.equal(v.primary.pending, false);
  // freeze dispatch in flight from the calm phase
  const calm = buildCrisisPanel({ placementOpen: true, pendingAction: "freeze" });
  assert.equal(calm.primary.pending, true);
});

test("pure: same input → identical output", () => {
  assert.deepEqual(
    buildCrisisPanel({ placementOpen: false, pendingAction: null, freezeHintSeen: true }),
    buildCrisisPanel({ placementOpen: false, pendingAction: null, freezeHintSeen: true }),
  );
});

test("every crisis label key + status key resolves in BOTH catalogs (FR/EN parity, C6)", () => {
  const keys: string[] = [
    "studio.crisis.status.calm",
    "studio.crisis.status.frozen",
    "studio.crisis.wipeWarning",
    "studio.crisis.firstHint",
  ];
  for (const phaseOpen of [true, false]) {
    const v = buildCrisisPanel({ placementOpen: phaseOpen });
    keys.push(v.primary.labelKey, ...v.group.map((a) => a.labelKey));
  }
  // restore is part of the wipe/undo pairing even if not in the default group
  keys.push("studio.crisis.restore" satisfies CrisisActionLabelKey);
  for (const k of new Set(keys)) {
    assert.ok(k in en, `missing EN key: ${k}`);
    assert.ok(k in fr, `missing FR key: ${k}`);
  }
});
