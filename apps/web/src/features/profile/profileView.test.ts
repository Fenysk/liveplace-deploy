/**
 * Tests for the profile page view-model (F11, FEN-22).
 *   node --test apps/web/src/features/profile/profileView.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProfileView, type PublicProfile } from "./profileView.ts";

const sample: PublicProfile = {
  user: {
    login: "pixelqueen",
    displayName: "PixelQueen",
    avatarUrl: null,
    memberSince: Date.UTC(2023, 10, 14), // Nov 2023
  },
  totals: { pixelsPlaced: 1234, points: 5678, canvasesJoined: 2 },
  canvases: [
    {
      canvasSlug: "halloween",
      canvasTitle: "Halloween 2026",
      pixelsPlaced: 1000,
      points: 5000,
      bestRank: 3,
    },
    {
      canvasSlug: "main",
      canvasTitle: "Main Canvas",
      pixelsPlaced: 234,
      points: 678,
      bestRank: null,
    },
  ],
};

test("loading state when result is undefined", () => {
  assert.deepEqual(buildProfileView(undefined), { state: "loading" });
});

test("notFound state when result is null", () => {
  assert.deepEqual(buildProfileView(null), {
    state: "notFound",
    titleKey: "profile.notFound",
  });
});

test("ready state formats totals and per-canvas stats (CA1)", () => {
  const v = buildProfileView(sample, "en");
  assert.equal(v.state, "ready");
  if (v.state !== "ready") return;
  assert.equal(v.totals.pixelsPlaced, "1,234");
  assert.equal(v.totals.points, "5,678");
  assert.equal(v.canvases.length, 2);
  assert.equal(v.canvases[0]!.canvasTitle, "Halloween 2026");
  assert.equal(v.canvases[0]!.points, "5,000");
  assert.deepEqual(v.canvases[0]!.bestRank, {
    key: "profile.rank",
    params: { rank: "3" },
  });
  assert.equal(v.canvases[1]!.bestRank, null); // unranked canvas
  assert.equal(v.isEmpty, false);
});

test("empty state flag when no canvases joined", () => {
  const v = buildProfileView(
    { ...sample, canvases: [], totals: { pixelsPlaced: 0, points: 0, canvasesJoined: 0 } },
    "en",
  );
  assert.equal(v.state, "ready");
  if (v.state !== "ready") return;
  assert.equal(v.isEmpty, true);
});

test("locale-aware number formatting (fr groups with spaces)", () => {
  const v = buildProfileView(sample, "fr");
  if (v.state !== "ready") return;
  // fr-style grouping uses a (narrow) no-break space, not a comma.
  assert.equal(v.totals.points.includes(","), false);
  assert.match(v.totals.points, /5\s?678/u);
});
