/**
 * React bindings for @canvas/i18n. Separate entry (`@canvas/i18n/react`) so the
 * core stays dependency-free. React is a peer dependency.
 *
 * CA1 ("switch FR↔EN without reload") is satisfied by `useSyncExternalStore`:
 * components subscribe to the store and re-render on locale change — no reload.
 */
import {
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { SUPPORTED_LOCALES, type Locale } from "./locale.js";
import type { I18n, TranslateFn } from "./store.js";

const I18nContext = createContext<I18n | null>(null);

export interface I18nProviderProps {
  i18n: I18n;
  children: ReactNode;
}

export function I18nProvider({ i18n, children }: I18nProviderProps): ReactNode {
  return createElement(I18nContext.Provider, { value: i18n }, children);
}

function useStore(): I18n {
  const i18n = useContext(I18nContext);
  if (!i18n) throw new Error("useI18n must be used within an <I18nProvider>");
  return i18n;
}

/** Access the store directly (e.g. to call `setLocale`/`toggle`). */
export function useI18n(): I18n {
  return useStore();
}

/** Current locale; re-renders the component when it changes. */
export function useLocale(): Locale {
  const i18n = useStore();
  return useSyncExternalStore(i18n.subscribe, i18n.getLocale, i18n.getLocale);
}

/**
 * The translate function, bound to the current locale. Subscribing via
 * `useLocale` guarantees the component re-renders (and re-translates) on switch.
 */
export function useTranslate(): TranslateFn {
  const i18n = useStore();
  useLocale();
  return i18n.t;
}

export interface LanguageSwitcherProps {
  className?: string;
}

/**
 * Minimal accessible language switcher: one button per supported locale, the
 * active one marked `aria-pressed`. Clicking switches in place (no reload) and
 * triggers the store's `onChange` persistence.
 */
export function LanguageSwitcher({ className }: LanguageSwitcherProps): ReactNode {
  const i18n = useStore();
  const locale = useLocale();
  return createElement(
    "div",
    { className, role: "group", "aria-label": i18n.t("lang.label") },
    SUPPORTED_LOCALES.map((code) =>
      createElement(
        "button",
        {
          key: code,
          type: "button",
          "aria-pressed": code === locale,
          onClick: () => i18n.setLocale(code),
        },
        i18n.t(code === "fr" ? "lang.fr" : "lang.en"),
      ),
    ),
  );
}
