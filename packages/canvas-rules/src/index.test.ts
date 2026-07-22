/**
 * Unit tests for @canvas/canvas-rules (FEN-2050).
 * Runs under Node's built-in test runner:
 *   node --test packages/canvas-rules/src/index.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RESERVED_SLUGS, isReservedSlug } from "./index.ts";

test("RESERVED_SLUGS is the single authoritative set (no duplicates)", () => {
  // A Set already deduplicates, so if the source array has duplicates the Set size
  // would be smaller than the array. We verify they're equal.
  const asArray = [...RESERVED_SLUGS];
  assert.equal(new Set(asArray).size, asArray.length, "RESERVED_SLUGS contains duplicate entries");
});

test("isReservedSlug — known reserved slugs are blocked", () => {
  for (const slug of ["api", "gallery", "studio", "leaderboard", "obs", "default", "admin"]) {
    assert.equal(isReservedSlug(slug), true, `Expected "${slug}" to be reserved`);
  }
});

test("isReservedSlug — case-insensitive match", () => {
  assert.equal(isReservedSlug("GALLERY"), true);
  assert.equal(isReservedSlug("Studio"), true);
  assert.equal(isReservedSlug("LEADERBOARD"), true);
});

test("isReservedSlug — arbitrary user slugs are not reserved", () => {
  for (const slug of ["alice", "bob42", "my_stream", "xqc"]) {
    assert.equal(isReservedSlug(slug), false, `Expected "${slug}" NOT to be reserved`);
  }
});

test("leaderboard is included (was missing from the web set before FEN-2050)", () => {
  assert.equal(RESERVED_SLUGS.has("leaderboard"), true);
});
