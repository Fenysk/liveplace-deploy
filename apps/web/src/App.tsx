import { LanguageSwitcher, useTranslate } from "@canvas/i18n/react";
import { AuthButton } from "./auth/AuthButton.js";

/**
 * Minimal app shell. Every visible string goes through `t(...)` so the whole
 * UI switches FR↔EN in place (CA1). This is the seed other MVP features
 * (canvas, gallery, leaderboard, profile) plug into — they reuse the same
 * `useTranslate()` / catalog contract.
 */
export function App(): React.ReactElement {
  const t = useTranslate();
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "3rem auto", padding: "0 1rem" }}>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "1rem" }}>
        <h1 style={{ margin: 0 }}>{t("app.title")}</h1>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <AuthButton />
          <LanguageSwitcher />
        </div>
      </header>
      <p style={{ color: "#555" }}>{t("app.tagline")}</p>

      <nav aria-label={t("nav.canvas")} style={{ display: "flex", gap: "1rem", marginTop: "1.5rem" }}>
        <a href="#canvas">{t("nav.canvas")}</a>
        <a href="#gallery">{t("nav.gallery")}</a>
        <a href="#leaderboard">{t("nav.leaderboard")}</a>
        <a href="#profile">{t("nav.profile")}</a>
      </nav>

      <section style={{ marginTop: "2rem" }}>
        <p style={{ marginTop: "1rem", color: "#777" }}>{t("canvas.cooldown", { seconds: 5 })}</p>
      </section>
    </main>
  );
}
