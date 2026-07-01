/**
 * Navigation contract tests (FEN-114 / FEN-433) — Definition-of-Done for Lot G.
 *
 * Logic-only (no DOM), matching the web `test` script. Covers:
 *   1. `resolveRoute` maps every known surface AND sends unknown paths to a real
 *      `notFound` (404) instead of the silent home-shell fallback.
 *   2. `paths` builders round-trip THROUGH `resolveRoute` where applicable.
 *   3. FEN-433: `/[pseudo]` canonical canvas route, `/c/[slug]` legacy redirect,
 *      reserved segments, and `home` route.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  paths,
  resolveRoute,
  isReservedSegment,
  isPseudoSegment,
  normalizePseudo,
} from "./routes.ts";

test("home route resolves to kind=home", () => {
  assert.deepEqual(resolveRoute("/"), { kind: "home" });
  assert.deepEqual(resolveRoute("/canvas"), { kind: "home" });
});

test("canonical canvas route /[pseudo] resolves to kind=canvas", () => {
  assert.deepEqual(resolveRoute("/ninja"), { kind: "canvas", slug: "ninja" });
  assert.deepEqual(resolveRoute("/alice_1"), { kind: "canvas", slug: "alice_1" });
  // Hyphens are not valid Twitch login characters → hyphenated paths go to 404 (G9 AC1).
  assert.deepEqual(resolveRoute("/bob-stream"), { kind: "notFound" });
});

test("legacy /c/:slug resolves to kind=canvasLegacyRedirect", () => {
  assert.deepEqual(resolveRoute("/c/main"), { kind: "canvasLegacyRedirect", slug: "main" });
  assert.deepEqual(resolveRoute("/c/alice"), { kind: "canvasLegacyRedirect", slug: "alice" });
});

test("known system surfaces resolve to their route", () => {
  // FEN-1160 (C-3): /gallery is fused into home; SPA redirects in router.tsx.
  // resolveRoute itself returns notFound (reserved segment, no route handler).
  assert.deepEqual(resolveRoute("/gallery"), { kind: "notFound" });
  assert.deepEqual(resolveRoute("/u/ninja"), { kind: "profile", login: "ninja" });
});

test("streamer studio surfaces resolve to their route (FEN-120)", () => {
  assert.deepEqual(resolveRoute("/studio"), { kind: "studioDashboard" });
  assert.deepEqual(resolveRoute("/studio/new"), { kind: "studioCreate" });
  // FEN-1217: /studio/broadcast/:slug redirects to /studio (CEO Q2).
  assert.deepEqual(resolveRoute("/studio/broadcast/neon"), { kind: "studioBroadcastRedirect" });
});

test("reserved segments are NOT routed to canvas (AC-4)", () => {
  // These are reserved system paths — must 404, not resolve to a canvas.
  // FEN-1160: /gallery is reserved but has no route; notFound, not a canvas.
  assert.deepEqual(resolveRoute("/gallery"), { kind: "notFound" });
  assert.deepEqual(resolveRoute("/studio"), { kind: "studioDashboard" });
  // Pure reserved words with no matching system route → 404
  assert.deepEqual(resolveRoute("/admin"), { kind: "notFound" });
  assert.deepEqual(resolveRoute("/api"), { kind: "notFound" });
  assert.deepEqual(resolveRoute("/login"), { kind: "notFound" });
  assert.deepEqual(resolveRoute("/me"), { kind: "notFound" });
  assert.deepEqual(resolveRoute("/obs"), { kind: "notFound" });
  assert.deepEqual(resolveRoute("/c"), { kind: "notFound" });
  assert.deepEqual(resolveRoute("/u"), { kind: "notFound" });
});

test("unknown paths resolve to a real 404, not the home shell", () => {
  assert.deepEqual(resolveRoute("/gallery/extra"), { kind: "notFound" });
  assert.deepEqual(resolveRoute("/leaderboard"), { kind: "notFound" }); // reserved
  // Studio sub-paths that aren't real surfaces 404 (no silent dashboard fallback).
  assert.deepEqual(resolveRoute("/studio/bogus"), { kind: "notFound" });
  assert.deepEqual(resolveRoute("/studio/broadcast"), { kind: "notFound" });
  // Multi-segment paths with no matching system route → 404
  assert.deepEqual(resolveRoute("/a/b"), { kind: "notFound" });
  // Hyphenated single-segment paths 404 — Twitch logins don't have hyphens (G9 AC1).
  assert.deepEqual(resolveRoute("/cette-page-nexiste-pas"), { kind: "notFound" });
  assert.deepEqual(resolveRoute("/canvas-qui-nexiste-pas"), { kind: "notFound" });
});

test("pseudo segment is lowercased (case-insensitive URL)", () => {
  assert.deepEqual(resolveRoute("/Ninja"), { kind: "canvas", slug: "ninja" });
  assert.deepEqual(resolveRoute("/ALICE"), { kind: "canvas", slug: "alice" });
});

test("params are decoded for profile and studio routes", () => {
  assert.deepEqual(resolveRoute("/u/Ninja"), { kind: "profile", login: "Ninja" });
  assert.deepEqual(resolveRoute("/u/a%20b"), { kind: "profile", login: "a b" });
});

test("path builders produce the canonical hrefs", () => {
  assert.equal(paths.home(), "/");
  assert.equal(paths.canvas(), "/");
  assert.equal(paths.canvas("main"), "/main");
  assert.equal(paths.gallery(), "/gallery");
  assert.equal(paths.profile("ninja"), "/u/ninja");
  assert.equal(paths.studio(), "/studio");
  assert.equal(paths.studioCreate(), "/studio/new");
});

test("canvas path builder encodes special characters and round-trips", () => {
  // Note: Twitch logins are [a-z0-9_] — underscores and numbers are valid.
  assert.equal(paths.canvas("alice_1"), "/alice_1");
  assert.equal(paths.canvas("bob_stream"), "/bob_stream");
  // Hyphens: paths.canvas() can BUILD a hyphenated URL but resolveRoute returns
  // notFound for it (hyphens are not valid Twitch login chars — G9 AC1 fix).
  assert.deepEqual(resolveRoute(paths.canvas("bob-stream")), { kind: "notFound" });
  // A slug with a space would encode and still round-trip through resolveRoute
  // via decodeURIComponent → lowercase → isPseudoSegment check
  // (encoded space %20 fails PSEUDO_RE → notFound, by design)
});

test("isReservedSegment helper", () => {
  assert.equal(isReservedSegment("gallery"), true);
  assert.equal(isReservedSegment("GALLERY"), true); // case-insensitive
  assert.equal(isReservedSegment("admin"), true);
  assert.equal(isReservedSegment("obs"), true);
  assert.equal(isReservedSegment("ninja"), false);
  assert.equal(isReservedSegment("alice"), false);
});

test("isPseudoSegment helper", () => {
  assert.equal(isPseudoSegment("ninja"), true);
  assert.equal(isPseudoSegment("alice_1"), true);
  // Hyphens are not valid Twitch login characters — hyphenated paths 404 (G9 AC1).
  assert.equal(isPseudoSegment("bob-stream"), false);
  assert.equal(isPseudoSegment("cette-page-nexiste-pas"), false);
  assert.equal(isPseudoSegment("gallery"), false); // reserved
  assert.equal(isPseudoSegment("admin"), false); // reserved
  assert.equal(isPseudoSegment(""), false); // empty
  assert.equal(isPseudoSegment("a b"), false); // invalid chars
});

test("normalizePseudo lowercases and decodes", () => {
  assert.equal(normalizePseudo("Ninja"), "ninja");
  assert.equal(normalizePseudo("ALICE"), "alice");
  assert.equal(normalizePseudo("alice%20x"), "alice x"); // space is invalid in PSEUDO_RE
});
