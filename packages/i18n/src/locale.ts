/**
 * Supported locales for LivePlace (F13 — Multilingue FR/EN).
 *
 * MVP scope is strictly French + English. Adding a locale is intentionally a
 * code change: append to {@link SUPPORTED_LOCALES} and add a catalog under
 * `messages/`. Anything outside FR/EN is out of scope for the MVP.
 */
export const SUPPORTED_LOCALES = ["en", "fr"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Universal fallback used only when neither the stored preference, the Twitch
 * locale, nor the browser languages resolve to a supported locale. English is
 * the safe international default; French audiences are caught by detection
 * (most fr-* navigators / Twitch locales normalise to `fr`).
 */
export const DEFAULT_LOCALE: Locale = "en";

/** Type guard: is `value` one of the supported locales? */
export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * Normalise a BCP-47 language tag (e.g. `fr-FR`, `en_US`, `FR`) to a supported
 * {@link Locale}, or `null` if it maps to nothing we ship. Only the primary
 * subtag is considered — regional variants collapse to the base language.
 */
export function normalizeLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return isLocale(primary) ? primary : null;
}
