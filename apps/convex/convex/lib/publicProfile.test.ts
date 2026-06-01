/**
 * Acceptance tests for the F11 public profile read-model (FEN-22).
 * Runs under Node's built-in test runner with native TS type-stripping —
 * no Convex runtime, no dependency install required:
 *
 *   node --test apps/convex/convex/lib/publicProfile.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPublicProfile,
  toPublicUser,
  type CanvasRow,
  type ProfileRow,
  type StatRow,
} from "./publicProfile.ts";

// A profile row carrying simulated PRIVATE columns (email / token / ids) to
// prove the allow-list boundary never surfaces them (CA2).
const profile: ProfileRow = {
  userId: "user_1",
  login: "pixelqueen",
  displayName: "PixelQueen",
  avatarUrl: "https://cdn.twitch.tv/avatar/pixelqueen.png",
  createdAt: 1_700_000_000_000,
  email: "secret@example.com", // private — must never leak
  oauthAccessToken: "tok_supersecret", // private — must never leak
};

const canvases: Record<string, CanvasRow> = {
  cv_main: { _id: "cv_main", slug: "main", title: "Main Canvas" },
  cv_event: { _id: "cv_event", slug: "halloween", title: "Halloween 2026" },
};

const stats: StatRow[] = [
  { canvasId: "cv_main", pixelsPlaced: 120, points: 340, bestRank: 7 },
  { canvasId: "cv_event", pixelsPlaced: 50, points: 900 },
  // stat for a canvas that no longer exists — must be skipped, not crash:
  { canvasId: "cv_missing", pixelsPlaced: 5, points: 5 },
];

const built = buildPublicProfile({
  profile,
  stats,
  canvasOf: (id) => canvases[id] ?? null,
});

// ── CA1: pixels placed and points per canvas ────────────────────────────────
test("CA1 — exposes pixels placed and points per canvas", () => {
  const main = built.canvases.find((c) => c.canvasSlug === "main");
  const event = built.canvases.find((c) => c.canvasSlug === "halloween");
  assert.ok(main && event);
  assert.equal(main!.pixelsPlaced, 120);
  assert.equal(main!.points, 340);
  assert.equal(main!.bestRank, 7);
  assert.equal(main!.canvasTitle, "Main Canvas");
  assert.equal(event!.pixelsPlaced, 50);
  assert.equal(event!.points, 900);
  assert.equal(event!.bestRank, null); // not yet ranked
});

test("CA1 — totals and canvasesJoined aggregate the known canvases only", () => {
  assert.equal(built.totals.pixelsPlaced, 170); // 120 + 50 (missing skipped)
  assert.equal(built.totals.points, 1240); // 340 + 900
  assert.equal(built.totals.canvasesJoined, 2);
});

test("CA1 — canvases ordered best (most points) first", () => {
  assert.deepEqual(
    built.canvases.map((c) => c.canvasSlug),
    ["halloween", "main"],
  );
});

test("unknown/deleted canvas rows are skipped, not fatal", () => {
  assert.equal(built.canvases.length, 2);
});

// ── CA2: no private data exposed ─────────────────────────────────────────────
test("CA2 — public user contains only allow-listed fields", () => {
  const pub = toPublicUser(profile);
  assert.deepEqual(Object.keys(pub).sort(), [
    "avatarUrl",
    "displayName",
    "login",
    "memberSince",
  ]);
});

test("CA2 — no private value leaks anywhere in the serialized profile", () => {
  const blob = JSON.stringify(built);
  for (const secret of [
    "secret@example.com", // email
    "tok_supersecret", // oauth token
    "user_1", // internal user id
  ]) {
    assert.equal(
      blob.includes(secret),
      false,
      `private value leaked into public profile: ${secret}`,
    );
  }
});
