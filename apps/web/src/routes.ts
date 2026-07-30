/**
 * Pure routing validators and path builders (FEN-114 / FEN-433 / FEN-2100 T5).
 *
 * No React or DOM dependency — fully unit-testable under the node test runner.
 * `resolveRoute` and the custom router switch have been removed; TanStack Router
 * file-based routes own all URL matching. Only the pure validators and the
 * canonical path builders remain here, consumed by route files and tests.
 */

// ─────────────────────────────────────────────────────────────────────────────
// FEN-433 (AC-4 / C7 / FEN-2050) — reserved segments. Single source of truth
// lives in @canvas/canvas-rules; aliased here so this module's existing callers
// continue to work unchanged.
// ─────────────────────────────────────────────────────────────────────────────

import { RESERVED_SLUGS } from "@canvas/canvas-rules";

export const RESERVED_SEGMENTS: ReadonlySet<string> = RESERVED_SLUGS;

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
 * Canonical internal hrefs — single source of truth for all inter-page links.
 * Slug/login are percent-encoded here; TanStack route params decode them back.
 *
 * FEN-433: `paths.canvas(slug)` produces `/{slug}` (canonical, no `/c/`).
 * The old `/c/{slug}` form still works via c.$slug.tsx redirect.
 */
export const paths = {
  /** Home — landing page (`/`). */
  home: (): string => "/",
  /** A canvas by slug (`/{slug}`). No slug → home (`/`). */
  canvas: (slug?: string | null): string =>
    slug ? `/${encodeURIComponent(slug)}` : "/",
  /** Public gallery / canvas discovery. */
  gallery: (): string => "/gallery",
  /** Streamer studio dashboard — "Mes canvas" (FEN-120 / WF-5). */
  studio: (): string => "/studio",
  /** Minimal create-canvas path (FEN-120 / WF-6). */
  studioCreate: (): string => "/studio/new",
  /** Design-system states board — Arcade component reference (FEN-268, Lot 0). */
  statesBoard: (): string => "/states",
} as const;

