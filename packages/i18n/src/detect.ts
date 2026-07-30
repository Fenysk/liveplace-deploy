import { DEFAULT_LOCALE, normalizeLocale, type Locale } from "./locale.js";

export interface DetectSources {
  /**
   * The user's persisted preference — `profiles.locale` when authenticated,
   * otherwise the locale cookie. Takes precedence over auto-detection because
   * an explicit choice (CA2) must survive across sessions and devices.
   */
  stored?: string | null;
  /** Locale reported by Twitch for the authenticated user (e.g. `fr`). */
  twitchLocale?: string | null;
  /** Browser language preferences, most-preferred first (`navigator.languages`). */
  navigatorLanguages?: readonly string[] | null;
  /** Fallback when nothing else resolves. Defaults to {@link DEFAULT_LOCALE}. */
  fallback?: Locale;
}

/**
 * Resolve the initial locale (F13 — "détection initiale").
 *
 * Precedence, first match wins:
 *   1. stored preference (cookie / profiles.locale)
 *   2. Twitch locale
 *   3. browser languages (in order)
 *   4. fallback (DEFAULT_LOCALE)
 *
 * Every candidate is normalised, so `fr-FR`, `en-US`, etc. resolve correctly,
 * and unsupported tags are skipped rather than forcing the fallback early.
 */
export function detectInitialLocale(sources: DetectSources = {}): Locale {
  const fallback = sources.fallback ?? DEFAULT_LOCALE;

  const candidates: Array<string | null | undefined> = [
    sources.stored,
    sources.twitchLocale,
    ...(sources.navigatorLanguages ?? []),
  ];

  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate);
    if (locale) return locale;
  }

  return fallback;
}
