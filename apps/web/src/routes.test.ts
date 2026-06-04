/**
 * Navigation contract tests (FEN-114) — Definition-of-Done for Lot G.
 *
 * Logic-only (no DOM), matching the web `test` script. Covers the two halves of
 * the spec's acceptance ("reach every surface without typing a URL; no
 * dead-ends; dedicated 404"):
 *   1. `resolveRoute` maps every known surface AND sends unknown paths to a real
 *      `notFound` (404) instead of the silent home-shell fallback.
 *   2. `paths` builders round-trip THROUGH `resolveRoute` — the hrefs the
 *      maillage links emit are exactly the ones the router resolves back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { paths, resolveRoute } from "./routes.ts";

test("known surfaces resolve to their route", () => {
  assert.deepEqual(resolveRoute("/"), { kind: "canvas", slug: null });
  assert.deepEqual(resolveRoute("/canvas"), { kind: "canvas", slug: null });
  assert.deepEqual(resolveRoute("/c/main"), { kind: "canvas", slug: "main" });
  assert.deepEqual(resolveRoute("/gallery"), { kind: "gallery" });
  assert.deepEqual(resolveRoute("/u/ninja"), { kind: "profile", login: "ninja" });
});

test("unknown paths resolve to a real 404, not the home shell", () => {
  assert.deepEqual(resolveRoute("/nope"), { kind: "notFound" });
  assert.deepEqual(resolveRoute("/gallery/extra"), { kind: "notFound" });
  assert.deepEqual(resolveRoute("/u"), { kind: "notFound" });
  assert.deepEqual(resolveRoute("/c"), { kind: "notFound" });
  assert.deepEqual(resolveRoute("/leaderboard"), { kind: "notFound" });
});

test("params are decoded, never lower-cased (server resolves case-insensitively)", () => {
  assert.deepEqual(resolveRoute("/u/Ninja"), { kind: "profile", login: "Ninja" });
  assert.deepEqual(resolveRoute("/u/a%20b"), { kind: "profile", login: "a b" });
  assert.deepEqual(resolveRoute("/c/My%20Canvas"), { kind: "canvas", slug: "My Canvas" });
});

test("path builders produce the canonical hrefs", () => {
  assert.equal(paths.home(), "/");
  assert.equal(paths.canvas(), "/");
  assert.equal(paths.canvas("main"), "/c/main");
  assert.equal(paths.gallery(), "/gallery");
  assert.equal(paths.profile("ninja"), "/u/ninja");
});

test("builders encode special characters so they round-trip through resolveRoute", () => {
  const login = "a b#c";
  const slug = "My Canvas";
  assert.deepEqual(resolveRoute(paths.profile(login)), { kind: "profile", login });
  assert.deepEqual(resolveRoute(paths.canvas(slug)), { kind: "canvas", slug });
});
