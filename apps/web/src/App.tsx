import { LanguageSwitcher, useTranslate } from "@canvas/i18n/react";
import { useState, type CSSProperties, type ReactNode } from "react";
import { AuthButton } from "./auth/AuthButton.js";
import { Link } from "./router.js";
import { paths } from "./routes.js";

/**
 * Shared hit-area floor for global-nav links (FEN-125 / WCAG 2.5.5 — 44×44px).
 * The text glyphs alone fall well under the touch minimum; `inline-flex` +
 * `minHeight`/`minWidth` give the `<a>` itself a full-size tap target on a
 * phone, independent of the (delegated) fine visual pass. Exported so the canvas
 * escape hatch and any other global-nav surface can share the same floor.
 */
export const navTapTargetStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 44,
  minWidth: 44,
  padding: "0 0.5rem",
  textDecoration: "none",
  color: "inherit",
};

/**
 * Skip-to-content link (FEN-125). Now that the persistent nav precedes `<main>`
 * on every page surface, keyboard/SR users would tab through it on each
 * navigation; this standard escape lets them jump straight to the content. The
 * web shell ships no global stylesheet, so visibility is toggled with focus
 * state (off-screen until focused) rather than a `:focus` CSS rule.
 */
function SkipToContent(): React.ReactElement {
  const t = useTranslate();
  const [focused, setFocused] = useState(false);
  const hidden: CSSProperties = {
    position: "absolute",
    left: -9999,
    top: 0,
    width: 1,
    height: 1,
    overflow: "hidden",
  };
  const shown: CSSProperties = {
    position: "absolute",
    left: 8,
    top: 8,
    zIndex: 100,
    display: "inline-flex",
    alignItems: "center",
    minHeight: 44,
    padding: "0 1rem",
    borderRadius: 8,
    background: "#fff",
    border: "1px solid #ccc",
    color: "inherit",
    textDecoration: "none",
  };
  return (
    <a
      href="#main-content"
      style={focused ? shown : hidden}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      {t("nav.skipToContent")}
    </a>
  );
}

/**
 * Shared page shell (FEN-114). Wraps the non-hero surfaces (gallery, profile,
 * 404) with a single **persistent global nav** so they stop being islands:
 * from any of them you can reach the canvas (brand/home) and the gallery
 * without typing a URL, and the signed-in identity links through to its profile
 * (handled inside {@link AuthButton}).
 *
 * Every visible string goes through `t(...)` so the whole shell switches FR↔EN
 * in place (CA1). Layout/visuals are intentionally minimal — the fine UI pass is
 * delegated (Lot G marks shell styling out of scope); only the wiring lives here.
 *
 * Note: the per-canvas leaderboard is a rang-3, in-canvas element (D5) and the
 * board kept that entry light (Q3); it is deliberately NOT promoted to a global
 * nav item, which would otherwise dead-end (no standalone leaderboard route).
 */
export function AppShell({ children }: { children: ReactNode }): React.ReactElement {
  const t = useTranslate();
  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      <SkipToContent />
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
          padding: "0.5rem 1rem",
          borderBottom: "1px solid #e3e3e3",
        }}
      >
        {/* alignItems center (was baseline) so the ≥44px tap targets line up. */}
        <nav
          aria-label={t("nav.primary")}
          style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
        >
          <Link to={paths.home()} style={{ ...navTapTargetStyle, fontWeight: 700 }}>
            {t("app.title")}
          </Link>
          <Link to={paths.canvas()} style={navTapTargetStyle}>
            {t("nav.canvas")}
          </Link>
          <Link to={paths.gallery()} style={navTapTargetStyle}>
            {t("nav.gallery")}
          </Link>
          <Link to={paths.studio()} style={navTapTargetStyle}>
            {t("nav.studio")}
          </Link>
        </nav>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <AuthButton />
          <LanguageSwitcher />
        </div>
      </header>

      <main id="main-content" tabIndex={-1} style={{ maxWidth: 960, margin: "2rem auto", padding: "0 1rem" }}>
        {children}
      </main>
    </div>
  );
}
