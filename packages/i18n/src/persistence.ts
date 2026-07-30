import { normalizeLocale, type Locale } from "./locale.js";

/**
 * Cookie name holding the anonymous locale preference. Read server-side (SSR /
 * OBS view) and client-side. Not HttpOnly: the client needs to read it to pick
 * the initial locale before any round-trip.
 */
export const LOCALE_COOKIE = "liveplace_locale";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Parse a `Cookie:` / `document.cookie` string and extract the locale. Pure. */
export function parseLocaleCookie(cookieString: string | null | undefined): Locale | null {
  if (!cookieString) return null;
  for (const part of cookieString.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== LOCALE_COOKIE) continue;
    return normalizeLocale(decodeURIComponent(part.slice(eq + 1).trim()));
  }
  return null;
}

export interface CookieOptions {
  /** Lifetime in seconds. Defaults to one year. */
  maxAge?: number;
  path?: string;
  sameSite?: "Lax" | "Strict" | "None";
  secure?: boolean;
}

/** Build the string to assign to `document.cookie` for a locale. Pure. */
export function serializeLocaleCookie(locale: Locale, options: CookieOptions = {}): string {
  const {
    maxAge = ONE_YEAR_SECONDS,
    path = "/",
    sameSite = "Lax",
    secure = true,
  } = options;
  const attrs = [
    `${LOCALE_COOKIE}=${encodeURIComponent(locale)}`,
    `Max-Age=${maxAge}`,
    `Path=${path}`,
    `SameSite=${sameSite}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser convenience wrappers (no-op when `document` is unavailable, e.g. SSR).
// ─────────────────────────────────────────────────────────────────────────────

export function readLocaleCookie(): Locale | null {
  if (typeof document === "undefined") return null;
  return parseLocaleCookie(document.cookie);
}

export function writeLocaleCookie(locale: Locale, options?: CookieOptions): void {
  if (typeof document === "undefined") return;
  document.cookie = serializeLocaleCookie(locale, options);
}

/**
 * Where a chosen locale is persisted so it survives sessions (CA2).
 *
 * Two implementations exist:
 *  - {@link cookiePersistence}: anonymous users, here.
 *  - a Convex-backed impl writing `profiles.locale`, owned by the auth/profile
 *    work (F1/F11 — see FEN-11). When authenticated, prefer that one so the
 *    preference follows the account across devices; still mirror to the cookie
 *    so the very first paint (before the session loads) is correct.
 */
export interface LocalePersistence {
  load(): Locale | null | Promise<Locale | null>;
  save(locale: Locale): void | Promise<void>;
}

export const cookiePersistence: LocalePersistence = {
  load: () => readLocaleCookie(),
  save: (locale) => writeLocaleCookie(locale),
};
