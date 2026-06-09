/**
 * @canvas/i18n — the i18n foundation for LivePlace (F13, FR/EN).
 *
 * Framework-agnostic core: locale types, detection, persistence, catalogs and
 * an observable store. React bindings live in the `./react` entry so this core
 * stays dependency-free and usable from the OBS view / SSR.
 *
 * Contract notes for later frontend work:
 *  - Add UI strings to `messages/en.ts` (source of truth) AND `messages/fr.ts`;
 *    the compiler enforces parity. Never hardcode user-facing text.
 *  - Initial locale = detectInitialLocale({ stored, twitchLocale, navigatorLanguages }).
 *  - Persist a manual switch via the store's `onChange` (cookie now;
 *    `profiles.locale` when authenticated — owned by FEN-11).
 */
export {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  isLocale,
  normalizeLocale,
  type Locale,
} from "./locale.js";

export { detectInitialLocale, type DetectSources } from "./detect.js";

export { interpolate, type MessageParams } from "./format.js";

export {
  LOCALE_COOKIE,
  parseLocaleCookie,
  serializeLocaleCookie,
  readLocaleCookie,
  writeLocaleCookie,
  cookiePersistence,
  type CookieOptions,
  type LocalePersistence,
} from "./persistence.js";

export {
  createI18n,
  type I18n,
  type I18nOptions,
  type TranslateFn,
} from "./store.js";

export {
  CATALOGS,
  en,
  fr,
  type Catalog,
  type MessageKey,
} from "./messages/index.js";
