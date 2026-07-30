import {
  DEFAULT_LOCALE,
  createI18n,
  detectInitialLocale,
  readLocaleCookie,
  writeLocaleCookie,
  type Locale,
} from "@canvas/i18n";

/**
 * App-wide i18n store.
 *
 * Initial locale (F13 detection): persisted preference (cookie) > Twitch locale
 * > browser languages > default. The Twitch locale is only known once the user
 * is authenticated, so it is wired in by the auth layer (FEN-11); until then,
 * cookie + navigator cover the anonymous path.
 *
 * On every switch we persist to the cookie (CA2) and reflect the language on
 * `<html lang>` for accessibility / SEO. When a session exists, the auth/profile
 * layer should additionally write `profiles.locale` (FEN-11/FEN-22) and pass it
 * in as `stored` on next load so the preference follows the account.
 */
const initialLocale = detectInitialLocale({
  stored: readLocaleCookie(),
  twitchLocale: null,
  navigatorLanguages: typeof navigator !== "undefined" ? navigator.languages : null,
  fallback: DEFAULT_LOCALE,
});

function reflectHtmlLang(locale: Locale): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
}

export const i18n = createI18n({
  locale: initialLocale,
  onChange: (locale) => {
    writeLocaleCookie(locale);
    reflectHtmlLang(locale);
  },
});

reflectHtmlLang(initialLocale);
