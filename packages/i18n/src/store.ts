import { interpolate, type MessageParams } from "./format.js";
import { SUPPORTED_LOCALES, type Locale } from "./locale.js";
import { CATALOGS, type Catalog, type MessageKey } from "./messages/index.js";

/** Translate function: look up a key for the current locale and interpolate. */
export type TranslateFn = (key: MessageKey, params?: MessageParams) => string;

export interface I18nOptions {
  /** Initial locale (usually from `detectInitialLocale`). */
  locale: Locale;
  /** Catalogs to use. Defaults to the shipped FR/EN catalogs. */
  catalogs?: Record<Locale, Catalog>;
  /**
   * Called whenever the locale changes (including via `toggle`). This is where
   * persistence lives — write the cookie and/or `profiles.locale`. Kept out of
   * the store itself so the core stays free of browser/Convex concerns.
   */
  onChange?: (locale: Locale) => void;
}

/**
 * A tiny observable i18n store. The whole point of F13's CA1 ("switch FR↔EN
 * without reload") is that {@link setLocale} mutates in place and notifies
 * subscribers synchronously — React binds to it via `useSyncExternalStore`, so
 * a locale change re-renders the tree instead of reloading the page.
 *
 * Framework-agnostic and dependency-free: usable from React, the OBS view, or
 * plain DOM.
 */
export interface I18n {
  getLocale(): Locale;
  setLocale(locale: Locale): void;
  /** Cycle to the next supported locale (FR↔EN for the MVP). */
  toggle(): void;
  /** Subscribe to locale changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Translate `key` in the current locale, with optional interpolation. */
  t: TranslateFn;
}

export function createI18n(options: I18nOptions): I18n {
  const catalogs = options.catalogs ?? CATALOGS;
  let locale: Locale = options.locale;
  const listeners = new Set<() => void>();

  const setLocale = (next: Locale): void => {
    if (next === locale) return;
    locale = next;
    options.onChange?.(next);
    for (const listener of listeners) listener();
  };

  const t: TranslateFn = (key, params) => {
    // A missing key degrades to the key itself rather than `undefined` — the
    // `MessageKey` type says every key is present, but a real catalog can drift
    // (a key removed from one locale, a typo). `interpolate(undefined, params)`
    // would throw `Cannot read properties of undefined`, and when that happens
    // inside the ErrorBoundary fallback it re-blanks the whole page (FEN-1515).
    // Returning the key is the standard safe i18n fallback: visible, never throws.
    const template = catalogs[locale][key] ?? key;
    return interpolate(template, params);
  };

  return {
    getLocale: () => locale,
    setLocale,
    toggle: () => {
      const i = SUPPORTED_LOCALES.indexOf(locale);
      const next = SUPPORTED_LOCALES[(i + 1) % SUPPORTED_LOCALES.length]!;
      setLocale(next);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    t,
  };
}
