/**
 * Pure parsing of the Twitch Helix `GET /users` response (FEN-109).
 *
 * Why this exists: the Twitch OIDC id_token used at sign-in exposes `sub` (the
 * numeric id) and `preferred_username` (the display name) but NOT the canonical
 * lowercase `login` slug. The `account.onCreate` trigger therefore seeds
 * `profiles.login` with `displayName.toLowerCase()` — exact for latin pseudos
 * but wrong for internationalised/localised display names. Helix `/users` is the
 * authoritative source for the real `login`; this helper extracts the identity
 * fields from its JSON body so the I/O action (auth.ts:backfillExactLogin) stays
 * a thin, untested wrapper while the fiddly shape-validation is unit-tested here.
 *
 * Helix `GET /users` (no params, bearer = the user's own token) returns the
 * authenticated user as `{ data: [{ id, login, display_name, ... }] }`.
 */

export interface HelixUserIdentity {
  /** Stable numeric Twitch user id (== OIDC `sub` == account.accountId). */
  twitchId: string;
  /** Canonical Twitch login slug, normalised to lowercase (matches by_login). */
  login: string;
  /** Display name, if present (mirrors `user.name`). */
  displayName?: string;
}

/**
 * Extract the first user identity from a Helix `/users` body, or `null` when the
 * body is malformed / empty or carries no usable `login`. Defensive against
 * arbitrary JSON: never throws. The `login` is trimmed and lowercased so it is
 * consistent with the `profiles.by_login` index (which stores lowercase) even
 * though Twitch already returns `login` lowercased by convention.
 */
export function parseHelixUser(body: unknown): HelixUserIdentity | null {
  if (!body || typeof body !== "object") return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return null;

  const u = data[0] as {
    id?: unknown;
    login?: unknown;
    display_name?: unknown;
  };

  const login = typeof u.login === "string" ? u.login.trim().toLowerCase() : "";
  if (!login) return null; // no usable slug → nothing to patch

  const twitchId = typeof u.id === "string" ? u.id : "";
  const displayName =
    typeof u.display_name === "string" && u.display_name.length > 0
      ? u.display_name
      : undefined;

  return { twitchId, login, displayName };
}
