import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CATALOGS,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  createI18n,
  detectInitialLocale,
  en,
  fr,
  interpolate,
  isLocale,
  normalizeLocale,
  parseLocaleCookie,
  serializeLocaleCookie,
  LOCALE_COOKIE,
} from "../src/index.js";

// ── locale helpers ──────────────────────────────────────────────────────────

test("normalizeLocale collapses regional variants and rejects unknown tags", () => {
  assert.equal(normalizeLocale("fr-FR"), "fr");
  assert.equal(normalizeLocale("en_US"), "en");
  assert.equal(normalizeLocale("FR"), "fr");
  assert.equal(normalizeLocale("de"), null);
  assert.equal(normalizeLocale(""), null);
  assert.equal(normalizeLocale(null), null);
});

test("isLocale guards the supported set", () => {
  assert.equal(isLocale("fr"), true);
  assert.equal(isLocale("en"), true);
  assert.equal(isLocale("es"), false);
  assert.equal(isLocale(42), false);
});

// ── catalog parity (the compiler enforces it; this guards at runtime too) ─────

test("FR and EN catalogs have identical key sets and no empty strings", () => {
  const enKeys = Object.keys(en).sort();
  const frKeys = Object.keys(fr).sort();
  assert.deepEqual(frKeys, enKeys, "FR/EN key sets must match exactly");
  for (const locale of SUPPORTED_LOCALES) {
    for (const [key, value] of Object.entries(CATALOGS[locale])) {
      assert.ok(value.length > 0, `${locale}.${key} must not be empty`);
    }
  }
});

// ── interpolation ─────────────────────────────────────────────────────────────

test("interpolate fills placeholders and preserves unknown ones", () => {
  assert.equal(interpolate("Next pixel in {seconds}s", { seconds: 5 }), "Next pixel in 5s");
  assert.equal(interpolate("Hi {name}", {}), "Hi {name}");
  assert.equal(interpolate("no params"), "no params");
});

// ── detection precedence ──────────────────────────────────────────────────────

test("detectInitialLocale honours precedence: stored > twitch > navigator > fallback", () => {
  assert.equal(
    detectInitialLocale({ stored: "en", twitchLocale: "fr", navigatorLanguages: ["fr"] }),
    "en",
    "stored preference wins",
  );
  assert.equal(
    detectInitialLocale({ twitchLocale: "fr-FR", navigatorLanguages: ["en"] }),
    "fr",
    "twitch wins over navigator",
  );
  assert.equal(
    detectInitialLocale({ navigatorLanguages: ["de", "fr-CA", "en"] }),
    "fr",
    "first supported navigator language wins",
  );
  assert.equal(detectInitialLocale({ stored: "es" }), DEFAULT_LOCALE, "unknown stored → fallback");
  assert.equal(detectInitialLocale({}), DEFAULT_LOCALE);
  assert.equal(detectInitialLocale({ fallback: "fr" }), "fr");
});

// ── cookie round-trip ──────────────────────────────────────────────────────────

test("cookie serialize/parse round-trips and ignores other cookies", () => {
  const cookie = serializeLocaleCookie("fr");
  assert.match(cookie, new RegExp(`^${LOCALE_COOKIE}=fr`));
  assert.match(cookie, /Max-Age=\d+/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);

  assert.equal(parseLocaleCookie(`theme=dark; ${LOCALE_COOKIE}=fr; other=1`), "fr");
  assert.equal(parseLocaleCookie("theme=dark"), null);
  assert.equal(parseLocaleCookie(""), null);
  assert.equal(parseLocaleCookie(`${LOCALE_COOKIE}=de`), null, "unsupported value → null");
});

// ── store: CA1 (switch without reload) + onChange persistence (CA2) ───────────

test("store.setLocale switches in place and notifies subscribers synchronously", () => {
  const saved: string[] = [];
  const i18n = createI18n({ locale: "en", onChange: (l) => saved.push(l) });

  let notifications = 0;
  const unsub = i18n.subscribe(() => notifications++);

  assert.equal(i18n.getLocale(), "en");
  assert.equal(i18n.t("nav.gallery"), "Gallery");

  i18n.setLocale("fr");
  assert.equal(i18n.getLocale(), "fr", "locale flips in place — no reload needed");
  assert.equal(i18n.t("nav.gallery"), "Galerie", "translations follow the new locale");
  assert.equal(notifications, 1, "subscriber notified synchronously");
  assert.deepEqual(saved, ["fr"], "onChange fired for persistence");

  i18n.setLocale("fr");
  assert.equal(notifications, 1, "no-op setLocale does not notify");

  unsub();
  i18n.setLocale("en");
  assert.equal(notifications, 1, "unsubscribed listener no longer notified");
});

test("store.toggle cycles FR↔EN", () => {
  const i18n = createI18n({ locale: "en" });
  i18n.toggle();
  assert.equal(i18n.getLocale(), "fr");
  i18n.toggle();
  assert.equal(i18n.getLocale(), "en");
});

test("store.t interpolates params in the active locale", () => {
  const i18n = createI18n({ locale: "fr" });
  assert.equal(i18n.t("canvas.cooldown", { seconds: 3 }), "Prochain pixel dans 3s");
});

test("store.t degrades a missing key to the key itself and never throws (FEN-1515)", () => {
  // A drifted catalog (key present in the type but absent at runtime) must not
  // crash the render — most critically the ErrorBoundary fallback, whose throw
  // re-blanks the page. `interpolate(undefined, params)` used to throw
  // `Cannot read properties of undefined (reading 'replace')`; now t() returns
  // the key. Simulate the drift with a catalog missing one key.
  const partial = { ...fr, "state.error.title": undefined } as unknown as typeof fr;
  const i18n = createI18n({
    locale: "fr",
    catalogs: { fr: partial, en },
  });
  assert.doesNotThrow(() => i18n.t("state.error.title"));
  assert.equal(i18n.t("state.error.title"), "state.error.title");
  // Even with params (the throwing path), it degrades instead of crashing.
  assert.doesNotThrow(() => i18n.t("state.error.title", { seconds: 1 }));
});
