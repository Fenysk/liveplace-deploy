/**
 * Shared return-to contract for the post-login redirect flow (FEN-1462 S0).
 *
 * Consumed by S2/S3/S4 — interface is frozen; do not add runtime dependencies.
 * Reuses resolveRoute / isPseudoSegment (routes.ts) and isObsPath (obs.ts);
 * no duplication of routing logic.
 */

import { resolveRoute, isPseudoSegment, normalizePseudo, paths } from '../routes.ts';
import { isObsPath } from '../features/canvas/obs.ts';

export const POSTLOGIN_OWNCANVAS_KEY = 'lp-postlogin-owncanvas';

/**
 * Sanitize a raw `return-to` path (e.g. from a URL query parameter).
 * Returns the path unchanged when safe, or null when it must be rejected.
 *
 * AC8: rejects protocol-relative (//) paths, absolute-URL schemes
 * (http/https/javascript/data:…), backslashes, and routes that resolve
 * to notFound. OBS paths are accepted because they are valid app pages.
 */
export function sanitizeReturnTo(path: string | null | undefined): string | null {
  if (path == null || path === '') return null;

  // Backslash — path traversal / Windows-style confusion.
  if (path.includes('\\')) return null;

  // Protocol-relative URLs: //evil.com
  if (path.startsWith('//')) return null;

  // Absolute URL schemes: http:, https:, javascript:, data:, …
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(path)) return null;

  // Must start with a single /
  if (!path.startsWith('/')) return null;

  // OBS paths are valid pages even though resolveRoute classifies them notFound.
  if (isObsPath(path)) return path;

  // Reject anything that doesn't map to a known SPA route.
  const route = resolveRoute(path);
  if (route.kind === 'notFound') return null;

  return path;
}

/** The classification of the page a user was on before the OAuth redirect. */
export type OriginClass = { case: 'A'; canvasPath: string } | { case: 'B' };

/**
 * Classify a pathname as a canvas origin (case A) or a non-canvas origin (case B).
 *
 * AC2/AC3: any `/{pseudo}` path → case A.
 * Q5: `/{pseudo}/obs` → case A with canvasPath `/{pseudo}` (strips /obs).
 * Bare `/obs` and all non-canvas routes → case B.
 */
export function classifyOrigin(pathname: string): OriginClass {
  // Check OBS paths before resolveRoute, which marks them notFound.
  if (isObsPath(pathname)) {
    const parts = pathname.split('/').filter(Boolean);
    // /obs          → parts.length === 1 → case B
    // /pseudo/obs   → parts.length === 2 → candidate for case A
    if (parts.length === 2) {
      const slug = normalizePseudo(parts[0]!);
      if (isPseudoSegment(slug)) {
        return { case: 'A', canvasPath: `/${slug}` };
      }
    }
    return { case: 'B' };
  }

  const route = resolveRoute(pathname);
  if (route.kind === 'canvas') {
    // route.slug is already normalized (lowercase, decoded).
    return { case: 'A', canvasPath: `/${route.slug}` };
  }

  return { case: 'B' };
}

/** Persist the "redirect to own canvas after login" flag in sessionStorage. */
export function markPostLoginOwnCanvas(): void {
  try {
    sessionStorage.setItem(POSTLOGIN_OWNCANVAS_KEY, '1');
  } catch {
    // sessionStorage unavailable (private-mode quota, etc.) — non-fatal.
  }
}

/**
 * Consume the flag: returns true and removes it if present, false if absent.
 * Call once in the post-login effect to avoid repeated redirects.
 */
export function consumePostLoginOwnCanvas(): boolean {
  try {
    const v = sessionStorage.getItem(POSTLOGIN_OWNCANVAS_KEY);
    if (v === null) return false;
    sessionStorage.removeItem(POSTLOGIN_OWNCANVAS_KEY);
    return true;
  } catch {
    return false;
  }
}

// ── S2 resolver (FEN-1472) ────────────────────────────────────────────────────

export type PostLoginOwnCanvasVerdict =
  | { kind: "noop" }                    // flag absent, or session settled anonymous
  | { kind: "pending" }                 // waiting for session or me query to settle
  | { kind: "redirect"; path: string }  // slug resolved — caller should replace()
  | { kind: "fallback" };              // slug null after settle — caller shows toast

/**
 * Pure resolver for the own-canvas redirect (case B).  Separated from the React
 * hook so it can be unit-tested without a DOM or browser environment.
 *
 *   flagConsumed — true if consumePostLoginOwnCanvas() returned true at mount
 *   session      — Better Auth session object (null = anonymous or not yet set)
 *   isPending    — true while Better Auth hasn't resolved the session yet
 *   me           — auth:me Convex query result (undefined = still loading)
 */
export function resolvePostLoginOwnCanvas(params: {
  flagConsumed: boolean;
  session: unknown;
  isPending: boolean;
  me: { personalCanvasSlug: string | null } | null | undefined;
}): PostLoginOwnCanvasVerdict {
  const { flagConsumed, session, isPending, me } = params;
  if (!flagConsumed) return { kind: "noop" };
  if (isPending) return { kind: "pending" };
  if (session == null) return { kind: "noop" };  // settled anonymous
  if (me === undefined) return { kind: "pending" };
  const slug = me?.personalCanvasSlug ?? null;
  if (slug) return { kind: "redirect", path: paths.canvas(slug) };
  return { kind: "fallback" };
}
