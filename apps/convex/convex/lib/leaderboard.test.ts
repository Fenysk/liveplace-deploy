/**
 * Acceptance tests for the F10 leaderboard read-model (FEN-30).
 * Runs under Node's built-in test runner with native TS type-stripping —
 * no Convex runtime, no dependency install required:
 *
 *   node --test apps/convex/convex/lib/leaderboard.test.ts
 *
 * Covers the take clamp (default / floor / ceiling / garbage), the allow-list
 * projection (no userId / private leak, profile fallback), and competition
 * ranking with ties.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampLeaderboardLimit,
  rankLeaderboard,
  toLeaderboardEntry,
  DEFAULT_LEADERBOARD_LIMIT,
  MAX_LEADERBOARD_LIMIT,
  type LeaderboardProfileRow,
  type LeaderboardStatRow,
} from "./leaderboard.ts";

// A stat row carrying simulated PRIVATE columns to prove the allow-list boundary
// never surfaces them (CA2).
function row(overrides: Partial<LeaderboardStatRow> = {}): LeaderboardStatRow {
  return {
    userId: "user_secret_1",
    points: 100,
    pixelsPlaced: 42,
    gaugeMaxBonus: 7, // private — must not leak
    updatedAt: 1_700_000_000_000, // private — must not leak
    ...overrides,
  };
}

const profiles: Record<string, LeaderboardProfileRow> = {
  user_a: { login: "alice", displayName: "Alice", avatarUrl: "https://cdn/a.png" },
  user_b: { login: "bob", displayName: "Bob", avatarUrl: null },
};
const profileOf = (id: string): LeaderboardProfileRow | null => profiles[id] ?? null;

// ── clampLeaderboardLimit ────────────────────────────────────────────────────

test("clamp: missing / non-finite falls back to the default", () => {
  assert.equal(clampLeaderboardLimit(undefined), DEFAULT_LEADERBOARD_LIMIT);
  assert.equal(clampLeaderboardLimit(NaN), DEFAULT_LEADERBOARD_LIMIT);
  assert.equal(clampLeaderboardLimit(Infinity), DEFAULT_LEADERBOARD_LIMIT);
});

test("clamp: floors to >= 1 and ceils to the max", () => {
  assert.equal(clampLeaderboardLimit(0), 1);
  assert.equal(clampLeaderboardLimit(-5), 1);
  assert.equal(clampLeaderboardLimit(1_000), MAX_LEADERBOARD_LIMIT);
  assert.equal(clampLeaderboardLimit(10), 10);
  assert.equal(clampLeaderboardLimit(10.9), 10); // floored, not rounded
});

// ── toLeaderboardEntry (allow-list projection) ───────────────────────────────

test("projection surfaces only public fields — no userId / private columns leak", () => {
  const entry = toLeaderboardEntry(1, row({ userId: "user_a" }), profileOf("user_a"));
  assert.deepEqual(entry, {
    rank: 1,
    login: "alice",
    displayName: "Alice",
    avatarUrl: "https://cdn/a.png",
    points: 100,
    pixelsPlaced: 42,
  });
  // CA2: the Better Auth user id and private columns are absent from the output.
  assert.deepEqual(Object.keys(entry).sort(), [
    "avatarUrl",
    "displayName",
    "login",
    "pixelsPlaced",
    "points",
    "rank",
  ]);
});

test("projection falls back to a non-identifying placeholder when the profile is missing", () => {
  const entry = toLeaderboardEntry(3, row({ userId: "ghost" }), profileOf("ghost"));
  assert.equal(entry.login, "—");
  assert.equal(entry.displayName, "Anonymous");
  assert.equal(entry.avatarUrl, null);
  assert.equal(entry.rank, 3);
});

// ── rankLeaderboard (competition ranking) ────────────────────────────────────

test("ranks pre-sorted rows 1..N when all scores are distinct", () => {
  const rows = [
    row({ userId: "user_a", points: 100 }),
    row({ userId: "user_b", points: 50 }),
  ];
  const board = rankLeaderboard(rows, profileOf);
  assert.deepEqual(
    board.map((e) => [e.rank, e.login, e.points]),
    [
      [1, "alice", 100],
      [2, "bob", 50],
    ],
  );
});

test("ties share a rank and the next distinct score skips positions (1,2,2,4)", () => {
  const rows = [
    row({ userId: "user_a", points: 100 }),
    row({ userId: "user_b", points: 80 }),
    row({ userId: "ghost", points: 80 }),
    row({ userId: "user_a", points: 30 }),
  ];
  const ranks = rankLeaderboard(rows, profileOf).map((e) => e.rank);
  assert.deepEqual(ranks, [1, 2, 2, 4]);
});

test("empty board yields an empty array", () => {
  assert.deepEqual(rankLeaderboard([], profileOf), []);
});
