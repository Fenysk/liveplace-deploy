/**
 * Round-trip return persistence for the pre-OAuth modal (FEN-580 / G1 spec §5.4).
 *
 * When an anonymous user clicks "Continue with Twitch" in the auth modal, the
 * page navigates away for the OAuth flow. Two things need to survive that redirect:
 *
 *   1. The staged pixel batch (P0/P1) — so the user's in-progress work isn't lost.
 *   2. The draw intent + view cadrage (P1) — so the user returns in draw mode at
 *      the same zoom/pan position they left at.
 *
 * We use `sessionStorage` (not `localStorage`) so the state is tab-scoped and
 * automatically expires when the tab closes. Keys are scoped by canvas slug so
 * parallel tabs on different canvases can't bleed into each other.
 *
 * Better Auth redirects to `callbackURL` after OAuth; since query/hash survival
 * across that redirect is not guaranteed, cadrage and intent travel via
 * sessionStorage rather than the URL (spec §5.4 fallback rule).
 */

import type { SelectionEntry } from "../features/canvas/selection.js";

const INTENT_KEY_PREFIX = "lp:intent:";
const BATCH_KEY_PREFIX = "lp:batch:";

export interface ReturnIntent {
  intent: "draw";
  scale?: number;
  tx?: number;
  ty?: number;
}

/** Persist the draw intent + optional view cadrage for a given canvas slug. */
export function saveReturnIntent(slug: string, data: ReturnIntent): void {
  try {
    sessionStorage.setItem(INTENT_KEY_PREFIX + slug, JSON.stringify(data));
  } catch {
    // sessionStorage unavailable (private mode quota, etc.) — non-fatal, P1 gracefully absent
  }
}

/** Load and return the persisted return intent for a slug, or null if absent. */
export function loadReturnIntent(slug: string): ReturnIntent | null {
  try {
    const raw = sessionStorage.getItem(INTENT_KEY_PREFIX + slug);
    if (!raw) return null;
    return JSON.parse(raw) as ReturnIntent;
  } catch {
    return null;
  }
}

/** Remove the return intent entry for a slug (called after it has been consumed). */
export function clearReturnIntent(slug: string): void {
  try {
    sessionStorage.removeItem(INTENT_KEY_PREFIX + slug);
  } catch {
    // ignore
  }
}

/** Persist the staged batch cells for a given canvas slug. */
export function saveBatch(slug: string, entries: readonly SelectionEntry[]): void {
  try {
    sessionStorage.setItem(BATCH_KEY_PREFIX + slug, JSON.stringify(entries));
  } catch {
    // non-fatal
  }
}

/** Load the persisted batch cells for a slug, or an empty array if absent. */
export function loadBatch(slug: string): SelectionEntry[] {
  try {
    const raw = sessionStorage.getItem(BATCH_KEY_PREFIX + slug);
    if (!raw) return [];
    return JSON.parse(raw) as SelectionEntry[];
  } catch {
    return [];
  }
}

/** Remove the persisted batch for a slug (called after it has been restored). */
export function clearBatch(slug: string): void {
  try {
    sessionStorage.removeItem(BATCH_KEY_PREFIX + slug);
  } catch {
    // ignore
  }
}
