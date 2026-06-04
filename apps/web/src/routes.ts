/**
 * Pure routing core (FEN-114) — path builders + URL→route resolution, with NO
 * React or DOM dependency so the whole navigation contract unit-tests headlessly
 * (the web `test` script is logic-only; see net.test.ts / obs.test.ts).
 *
 * `router.tsx` renders the React `<Router>` on top of {@link resolveRoute}, and
 * every surface builds its inter-page links through {@link paths} so the
 * "maillage" (canvas↔gallery↔profile) stays in one place and round-trips with
 * the matchers below: a `paths.profile(login)` href is parsed back by
 * `resolveRoute` to the same `login` (encode here ↔ decode there).
 *
 * This module is intentionally self-contained (no relative imports) so the whole
 * navigation contract unit-tests under the node test runner. The OBS overlay
 * (`/obs`, `/{slug}/obs`) is matched separately by `obs.ts#isObsPath` and
 * intercepted in `router.tsx` BEFORE `resolveRoute` runs — keep that order, as
 * `resolveRoute` classifies an OBS path as `notFound`.
 */

/**
 * Canonical internal hrefs. Centralised so links can't drift from the routes
 * `resolveRoute` accepts. Slug/login are percent-encoded here and decoded back
 * in {@link resolveRoute}, so a value with spaces/`#`/… survives the round-trip.
 */
export const paths = {
  /** Home = the default-canvas hero (`/`). */
  home: (): string => "/",
  /** A named canvas (`/c/:slug`); no slug → the default canvas at `/`. */
  canvas: (slug?: string | null): string =>
    slug ? `/c/${encodeURIComponent(slug)}` : "/",
  /** Public gallery / canvas discovery. */
  gallery: (): string => "/gallery",
  /** A public player profile (`/u/:login`). */
  profile: (login: string): string => `/u/${encodeURIComponent(login)}`,
  /** Streamer studio dashboard — "Mes canvas" (FEN-120 / WF-5). */
  studio: (): string => "/studio",
  /** Minimal create-canvas path (FEN-120 / WF-6). */
  studioCreate: (): string => "/studio/new",
  /** Per-canvas "Diffuser" (OBS) screen (FEN-120 / WF-7). */
  studioBroadcast: (slug: string): string => `/studio/broadcast/${encodeURIComponent(slug)}`,
} as const;

/**
 * A resolved route — the discriminated target a path maps to. OBS is handled
 * separately (see {@link resolveRoute}), so it is intentionally not a member.
 */
export type RouteMatch =
  | { kind: "canvas"; slug: string | null }
  | { kind: "profile"; login: string }
  | { kind: "gallery" }
  | { kind: "studioDashboard" }
  | { kind: "studioCreate" }
  | { kind: "studioBroadcast"; slug: string }
  | { kind: "notFound" };

/**
 * Match a single-segment-param pattern (e.g. `/u/:login`) against a concrete
 * path. Returns the captured params, or `null` when it doesn't match.
 */
export function matchRoute(
  pattern: string,
  path: string,
): Record<string, string> | null {
  const patternSegments = pattern.split("/").filter(Boolean);
  const pathSegments = path.split("/").filter(Boolean);
  if (patternSegments.length !== pathSegments.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const patternSeg = patternSegments[i]!;
    const pathSeg = pathSegments[i]!;
    if (patternSeg.startsWith(":")) {
      params[patternSeg.slice(1)] = pathSeg;
    } else if (patternSeg !== pathSeg) {
      return null;
    }
  }
  return params;
}

/**
 * Resolve a `location.pathname` to its route target. The single source of truth
 * for "what renders here", including the dedicated **404** (`notFound`) for any
 * unknown path — previously unknown paths silently fell back to the home shell,
 * which read as a dead-end (no "this page doesn't exist" signal).
 *
 * Params are decoded here (never lower-cased): login resolution is
 * case-insensitive SERVER-side, so pre-normalising would mask that.
 */
export function resolveRoute(pathname: string): RouteMatch {
  // NB: OBS overlay paths (`/obs`, `/{slug}/obs`) are intercepted upstream in
  // router.tsx via `obs.ts#isObsPath` BEFORE this runs; here they fall through
  // to `notFound`. Keep that ordering.

  // The live canvas is the landing experience.
  if (pathname === "/" || pathname === "/canvas") {
    return { kind: "canvas", slug: null };
  }
  const canvas = matchRoute("/c/:slug", pathname);
  if (canvas) return { kind: "canvas", slug: decodeURIComponent(canvas.slug!) };

  const profile = matchRoute("/u/:login", pathname);
  if (profile) return { kind: "profile", login: decodeURIComponent(profile.login!) };

  if (pathname === "/gallery") return { kind: "gallery" };

  // Streamer studio (FEN-120). Order matters: the exact paths first, then the
  // `/studio/broadcast/:slug` pattern (3 segments) — `/studio/new` (2 segments)
  // can't collide with it, and `/studio/<anything-else>` falls through to 404.
  if (pathname === "/studio") return { kind: "studioDashboard" };
  if (pathname === "/studio/new") return { kind: "studioCreate" };
  const broadcast = matchRoute("/studio/broadcast/:slug", pathname);
  if (broadcast) return { kind: "studioBroadcast", slug: decodeURIComponent(broadcast.slug!) };

  // Anything else is a real 404 — no silent home-shell fallback.
  return { kind: "notFound" };
}
