/**
 * Navigation contract tests (FEN-114 / FEN-433 / FEN-2100 T5).
 *
 * Two sections:
 *   1. Pure validator helpers (`isPseudoSegment`, `normalizePseudo`,
 *      `isReservedSegment`, `paths` builders) — no DOM, no router needed.
 *   2. TanStack Router route matching via `createMemoryHistory` + inline
 *      route tree — verifies the same URL→route decisions that
 *      `resolveRoute` used to cover, now via the real router primitives.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  paths,
  isReservedSegment,
  isPseudoSegment,
  normalizePseudo,
} from "./routes.ts";
import {
  createMemoryHistory,
  createRouter,
  createRootRoute,
  createRoute,
} from "@tanstack/react-router";

// ─── Section 1 — pure validators ────────────────────────────────────────────

test("path builders produce the canonical hrefs", () => {
  assert.equal(paths.home(), "/");
  assert.equal(paths.canvas(), "/");
  assert.equal(paths.canvas("main"), "/main");
  assert.equal(paths.gallery(), "/gallery");
  assert.equal(paths.studio(), "/studio");
  assert.equal(paths.studioCreate(), "/studio/new");
  assert.equal(paths.statesBoard(), "/states");
});

test("canvas path builder encodes special characters", () => {
  assert.equal(paths.canvas("alice_1"), "/alice_1");
  assert.equal(paths.canvas("bob_stream"), "/bob_stream");
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
  assert.equal(normalizePseudo("alice%20x"), "alice x"); // space invalid in PSEUDO_RE
});

// ─── Section 2 — TanStack Router matching via createMemoryHistory ────────────
//
// Inline minimal route tree mirrors the real app routes without pulling in
// React components, so the tests run under bare `node:test` (no DOM/jsdom).

const rootRoute = createRootRoute();
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
const pseudoRoute = createRoute({ getParentRoute: () => rootRoute, path: "/$pseudo" });
const canvasRoute = createRoute({ getParentRoute: () => rootRoute, path: "/canvas" });
const galleryRoute = createRoute({ getParentRoute: () => rootRoute, path: "/gallery" });
const statesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/states" });
const studioRoute = createRoute({ getParentRoute: () => rootRoute, path: "/studio" });
const studioNewRoute = createRoute({ getParentRoute: () => studioRoute, path: "/new" });
const cSlugRoute = createRoute({ getParentRoute: () => rootRoute, path: "/c/$slug" });
const splatRoute = createRoute({ getParentRoute: () => rootRoute, path: "/$" });

const routeTree = rootRoute.addChildren([
  indexRoute,
  pseudoRoute,
  canvasRoute,
  galleryRoute,
  statesRoute,
  studioRoute.addChildren([studioNewRoute]),
  cSlugRoute,
  splatRoute,
]);

async function matchedRouteIds(pathname: string): Promise<string[]> {
  const history = createMemoryHistory({ initialEntries: [pathname] });
  const router = createRouter({ routeTree, history });
  await router.load();
  return router.state.matches.map((m) => m.routeId);
}

test("/ matches the index route", async () => {
  const ids = await matchedRouteIds("/");
  assert.ok(ids.includes("/"));
});

test("/states matches the states route", async () => {
  const ids = await matchedRouteIds("/states");
  assert.ok(ids.includes("/states"), `expected /states in ${ids.join(",")}`);
});

test("/gallery matches the gallery route (redirects in real app)", async () => {
  const ids = await matchedRouteIds("/gallery");
  assert.ok(ids.includes("/gallery"), `expected /gallery in ${ids.join(",")}`);
});

test("/canvas matches the canvas redirect route", async () => {
  const ids = await matchedRouteIds("/canvas");
  assert.ok(ids.includes("/canvas"), `expected /canvas in ${ids.join(",")}`);
});

test("/$pseudo matches single-segment canvas paths", async () => {
  const ids = await matchedRouteIds("/ninja");
  assert.ok(ids.includes("/$pseudo"), `expected /$pseudo in ${ids.join(",")}`);
});

test("/$pseudo captures the slug param", async () => {
  const history = createMemoryHistory({ initialEntries: ["/ninja"] });
  const router = createRouter({ routeTree, history });
  await router.load();
  const match = router.state.matches.find((m) => m.routeId === "/$pseudo");
  assert.equal((match?.params as { pseudo?: string })?.pseudo, "ninja");
});

test("/c/$slug matches the legacy redirect route", async () => {
  const ids = await matchedRouteIds("/c/main");
  assert.ok(ids.includes("/c/$slug"), `expected /c/$slug in ${ids.join(",")}`);
});

test("/studio matches the studio layout", async () => {
  const ids = await matchedRouteIds("/studio");
  assert.ok(ids.includes("/studio"), `expected /studio in ${ids.join(",")}`);
});

test("/studio/new matches the studio new sub-route", async () => {
  const ids = await matchedRouteIds("/studio/new");
  assert.ok(ids.includes("/studio/new"), `expected /studio/new in ${ids.join(",")}`);
});

test("multi-segment paths fall to the splat catch-all (/$)", async () => {
  // e.g. /{slug}/obs (OBS browser source) — handled by catch-all in real app
  const ids = await matchedRouteIds("/alice/obs");
  assert.ok(ids.includes("/$"), `expected /$ in ${ids.join(",")}`);
});

test("unknown multi-segment paths also fall to the splat catch-all", async () => {
  const ids = await matchedRouteIds("/a/b/c");
  assert.ok(ids.includes("/$"), `expected /$ in ${ids.join(",")}`);
});

// Single-segment paths like /obs, /gallery, /admin hit /$pseudo (not the splat),
// since /$pseudo is a more specific single-segment dynamic route.
test("single-segment reserved paths hit /$pseudo (beforeLoad validates in real app)", async () => {
  const ids = await matchedRouteIds("/obs");
  // /$pseudo catches it; real app's beforeLoad throws notFound for reserved segments
  assert.ok(ids.includes("/$pseudo"), `expected /$pseudo in ${ids.join(",")}`);
});

test("hyphenated single-segment paths hit /$pseudo (beforeLoad returns notFound in real app)", async () => {
  const ids = await matchedRouteIds("/cette-page-nexiste-pas");
  assert.ok(ids.includes("/$pseudo"), `expected /$pseudo in ${ids.join(",")}`);
});
