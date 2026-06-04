import { LanguageSwitcher, useTranslate } from "@canvas/i18n/react";
import type { ReactNode } from "react";
import { AuthButton } from "./auth/AuthButton.js";
import { Link } from "./router.js";
import { paths } from "./routes.js";

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
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
          padding: "0.75rem 1rem",
          borderBottom: "1px solid #e3e3e3",
        }}
      >
        <nav
          aria-label={t("nav.primary")}
          style={{ display: "flex", alignItems: "baseline", gap: "1.25rem" }}
        >
          <Link to={paths.home()} style={{ fontWeight: 700, textDecoration: "none", color: "inherit" }}>
            {t("app.title")}
          </Link>
          <Link to={paths.canvas()}>{t("nav.canvas")}</Link>
          <Link to={paths.gallery()}>{t("nav.gallery")}</Link>
          <Link to={paths.studio()}>{t("nav.studio")}</Link>
        </nav>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <AuthButton />
          <LanguageSwitcher />
        </div>
      </header>

      <main style={{ maxWidth: 960, margin: "2rem auto", padding: "0 1rem" }}>{children}</main>
    </div>
  );
}
