/**
 * @canvas/canvas-rules — shared reserved-slug list (FEN-433 / FEN-2050).
 *
 * Single source of truth consumed by:
 *   - apps/convex  (canvasRules.ts — server-side slug validation)
 *   - apps/web     (routes.ts — client-side route guard)
 *
 * Previously each app defined its own copy and they drifted (e.g. `"leaderboard"`
 * was missing from the web set). Having one package eliminates the drift.
 */

/**
 * URL segments that are permanently reserved and may never be claimed as canvas
 * slugs. Enforced server-side (B6: Convex mutation rejects the slug) and
 * client-side (the router never routes a matching single-segment path to a canvas).
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
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
  // FEN-479 (AC-2): "default" is the internal gateway fallback canvas id.
  "default",
]);

/** True when `slug` (case-insensitive) is a reserved system path. */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}
