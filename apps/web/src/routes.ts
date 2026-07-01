/**
 * Pure routing core (FEN-114 / FEN-433) — path builders + URL→route resolution,
 * with NO React or DOM dependency so the whole navigation contract unit-tests
 * headlessly (the web `test` script is logic-only; see net.test.ts / obs.test.ts).
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

// ─────────────────────────────────────────────────────────────────────────────
// FEN-433 (AC-4 / C7) — reserved segments. Single source of truth for the
// front-end (canonical list; the Convex back-end mirrors this in RESERVED_SLUGS
// in canvases.ts). A URL segment that matches any of these is NEVER routed to a
// canvas — it's a system path or a hard-reserved word.
// ─────────────────────────────────────────────────────────────────────────────

export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set([
  "api", "healthz", "health", "metrics", "status",
  "auth", "login", "logout", "signin", "signup", "oauth", "callback",
  "c", "u",
  "admin", "settings", "account", "me", "dashboard", "explore",
  "home", "about", "terms", "privacy", "legal", "help", "support",
  "og", "embed", "overlay", "obs",
  "gallery", "studio", "states", "leaderboard",
  "static", "assets", "public", "_next",
  "favicon.ico", "robots.txt", "sitemap.xml", "manifest.json",
  "404", "500", "well-known", ".well-known",
  // FEN-479 (AC-2): "default" is the internal gateway fallback canvas id
  // (DEFAULT_CANVAS_ID). Reserving it prevents the orphaned pre-FEN-433 canvas
  // row from being routed as a live canvas. ensureDefaultCanvas was removed in
  // FEN-433 (AC-2/B5); this closes the routing gap.
  "default",
]);

/** True when a URL segment is a reserved system path and cannot be a canvas slug. */
export function isReservedSegment(segment: string): boolean {
  return RESERVED_SEGMENTS.has(segment.toLowerCase());
}

/** Lowercase a pseudo and strip leading/trailing spaces (URL is case-insensitive). */
export function normalizePseudo(pseudo: string): string {
  return decodeURIComponent(pseudo).toLowerCase().trim();
}

// Regex for a valid canvas pseudo: Twitch login format [a-z0-9_], 1-25 chars.
// Hyphens are intentionally excluded: Twitch usernames never contain hyphens, so
// a hyphenated single-segment path (e.g. /cette-page-nexiste-pas) is clearly NOT
// a canvas route and must fall through to the 404 NotFoundPage (G9 AC1).
const PSEUDO_RE = /^[a-z0-9_]{1,25}$/;

/** True when a (decoded, lowercased) segment looks like a valid canvas slug. */
export function isPseudoSegment(segment: string): boolean {
  return PSEUDO_RE.test(segment) && !isReservedSegment(segment);
}

/**
 * Canonical internal hrefs. Centralised so links can't drift from the routes
 * `resolveRoute` accepts. Slug/login are percent-encoded here and decoded back
 * in {@link resolveRoute}, so a value with spaces/`#`/… survives the round-trip.
 *
 * FEN-433: `paths.canvas(slug)` now produces `/{slug}` (canonical, no `/c/`).
 * The old `/c/{slug}` form still works (resolveRoute issues an SPA replace),
 * and the server-side 301 for `/c/` is handled by DevOps at the reverse proxy.
 */
export const paths = {
  /** Home — landing page (`/`). */
  home: (): string => "/",
  /** A canvas by slug (`/{slug}`). No slug → home (`/`). */
  canvas: (slug?: string | null): string =>
    slug ? `/${encodeURIComponent(slug)}` : "/",
  /** Public gallery / canvas discovery. */
  gallery: (): string => "/gallery",
  /** A public player profile (`/u/:login`). */
  profile: (login: string): string => `/u/${encodeURIComponent(login)}`,
  /** Streamer studio dashboard — "Mes canvas" (FEN-120 / WF-5). */
  studio: (): string => "/studio",
  /** Minimal create-canvas path (FEN-120 / WF-6). */
  studioCreate: (): string => "/studio/new",
  /** Design-system states board — Arcade component reference (FEN-268, Lot 0). */
  statesBoard: (): string => "/states",
} as const;

/**
 * A resolved route — the discriminated target a path maps to. OBS is handled
 * separately (see {@link resolveRoute}), so it is intentionally not a member.
 */
export type RouteMatch =
  | { kind: "home" }
  | { kind: "canvas"; slug: string }
  | { kind: "canvasLegacyRedirect"; slug: string }
  | { kind: "profile"; login: string }
  | { kind: "studioDashboard" }
  | { kind: "studioCreate" }
  | { kind: "studioBroadcastRedirect" }
  | { kind: "statesBoard" }
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
 * FEN-433: `/` is now a dedicated "home" route (HomeView or redirect to personal
 * canvas). `/[pseudo]` is the canonical canvas URL; `/c/[slug]` emits a legacy
 * redirect. Params are decoded and lowercased for the `pseudo` segment (URL is
 * case-insensitive; server resolves case-insensitively too).
 */
export function resolveRoute(pathname: string): RouteMatch {
  // NB: OBS overlay paths (`/obs`, `/{slug}/obs`) are intercepted upstream in
  // router.tsx via `obs.ts#isObsPath` BEFORE this runs; here they fall through
  // to `notFound`. Keep that ordering.

  // Home landing page.
  if (pathname === "/") {
    return { kind: "home" };
  }

  // Legacy `/canvas` redirect — treat as home.
  if (pathname === "/canvas") {
    return { kind: "home" };
  }

  // Legacy `/c/:slug` — emit a redirect to `/:slug` (SPA replaceState; DevOps 301).
  const legacyCanvas = matchRoute("/c/:slug", pathname);
  if (legacyCanvas) {
    return { kind: "canvasLegacyRedirect", slug: decodeURIComponent(legacyCanvas.slug!) };
  }

  const profile = matchRoute("/u/:login", pathname);
  if (profile) return { kind: "profile", login: decodeURIComponent(profile.login!) };

  // "/gallery" is reserved (RESERVED_SEGMENTS) but no longer a SPA route.
  // The SPA redirects /gallery → / in router.tsx; the server 301 is DevOps.

  // Streamer studio (FEN-120). Order matters: the exact paths first, then the
  // `/studio/broadcast/:slug` pattern (3 segments) — `/studio/new` (2 segments)
  // can't collide with it, and `/studio/<anything-else>` falls through to 404.
  if (pathname === "/studio") return { kind: "studioDashboard" };
  if (pathname === "/studio/new") return { kind: "studioCreate" };
  // FEN-1217: `/studio/broadcast/:slug` route removed; SPA-redirect to /studio (CEO Q2).
  const broadcast = matchRoute("/studio/broadcast/:slug", pathname);
  if (broadcast) return { kind: "studioBroadcastRedirect" };

  // Design-system reference board (FEN-268, Lot 0) — QA capture surface.
  if (pathname === "/states") return { kind: "statesBoard" };

  // FEN-433 (AC-4 / C1) — `/[pseudo]` canonical canvas route. Must come AFTER
  // all system routes so nothing reserved is accidentally claimed by a canvas.
  // Matches a single non-empty segment that looks like a valid pseudo and is not
  // reserved. The segment is lowercased: URL is case-insensitive.
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 1) {
    const pseudo = normalizePseudo(segments[0]!);
    if (isPseudoSegment(pseudo)) {
      return { kind: "canvas", slug: pseudo };
    }
  }

  // Anything else is a real 404 — no silent home-shell fallback.
  return { kind: "notFound" };
}
