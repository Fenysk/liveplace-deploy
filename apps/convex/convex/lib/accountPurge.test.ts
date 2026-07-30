/**
 * Unit tests for the account-deletion purge decisions (FEN-1966, C-4 / §3).
 * Runs under Node's built-in test runner with native TS type-stripping:
 *
 *   node --test apps/convex/convex/lib/accountPurge.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANONYMIZED_ACTOR,
  moderatorRowMatches,
  pixelModerationNeedsScrub,
  planPlacementPurge,
  scrubAuditRow,
  scrubBanRow,
} from "./accountPurge.ts";

const USER = "user_gone";
const OTHER = "user_stays";
const OWNED = new Set(["canvas_perso"]);

test("D-1 Option A: placements on other canvases are anonymised, NEVER deleted", () => {
  assert.equal(planPlacementPurge({ canvasId: "canvas_autrui", userId: USER }, USER, OWNED), "anonymize");
  // Own-canvas rows die with the §3d cascade.
  assert.equal(planPlacementPurge({ canvasId: "canvas_perso", userId: USER }, USER, OWNED), "delete");
  // Someone else's rows and already-anonymised rows (re-run) are untouched.
  assert.equal(planPlacementPurge({ canvasId: "canvas_autrui", userId: OTHER }, USER, OWNED), "skip");
  assert.equal(planPlacementPurge({ canvasId: "canvas_autrui" }, USER, OWNED), "skip");
});

test("ban rows targeting the user are deleted; moderator roles are anonymised", () => {
  assert.deepEqual(scrubBanRow({ userId: USER, bannedBy: OTHER }, USER), { kind: "delete" });
  assert.deepEqual(scrubBanRow({ userId: OTHER, bannedBy: USER }, USER), {
    kind: "patch",
    patch: { bannedBy: ANONYMIZED_ACTOR },
  });
  const lifted = scrubBanRow({ userId: OTHER, bannedBy: USER, liftedBy: USER }, USER);
  assert.equal(lifted?.kind, "patch");
  assert.equal(lifted && "liftedBy" in lifted.patch, true);
  // Unrelated row / re-run on an already-anonymised row → nothing to do.
  assert.equal(scrubBanRow({ userId: OTHER, bannedBy: OTHER }, USER), null);
  assert.equal(scrubBanRow({ userId: OTHER, bannedBy: ANONYMIZED_ACTOR }, USER), null);
});

test("moderator roster rows match by app id or stable twitchId", () => {
  assert.equal(moderatorRowMatches({ userId: USER, twitchId: "1" }, USER, "42"), true);
  assert.equal(moderatorRowMatches({ twitchId: "42" }, USER, "42"), true);
  assert.equal(moderatorRowMatches({ userId: OTHER, twitchId: "7" }, USER, "42"), false);
  // No known twitchId (profile already gone on a re-run) → never match by "".
  assert.equal(moderatorRowMatches({ twitchId: "" }, USER, null), false);
  assert.equal(moderatorRowMatches({ twitchId: "" }, USER, ""), false);
});

test("pixelModeration keeps the row, clears only the removed author", () => {
  assert.equal(pixelModerationNeedsScrub({ removedUserId: USER }, USER), true);
  assert.equal(pixelModerationNeedsScrub({ removedUserId: OTHER }, USER), false);
  assert.equal(pixelModerationNeedsScrub({}, USER), false); // re-run
});

test("auditLog anonymises actor and target independently, idempotently", () => {
  assert.deepEqual(scrubAuditRow({ actorUserId: USER }, USER), { actorUserId: ANONYMIZED_ACTOR });
  const both = scrubAuditRow({ actorUserId: USER, targetUserId: USER }, USER);
  assert.equal(both?.actorUserId, ANONYMIZED_ACTOR);
  assert.equal(both && "targetUserId" in both, true);
  const targetOnly = scrubAuditRow({ actorUserId: OTHER, targetUserId: USER }, USER);
  assert.equal(targetOnly !== null && !("actorUserId" in targetOnly), true);
  // Already scrubbed (re-run) → no patch.
  assert.equal(scrubAuditRow({ actorUserId: ANONYMIZED_ACTOR }, USER), null);
  assert.equal(scrubAuditRow({ actorUserId: OTHER, targetUserId: OTHER }, USER), null);
});
