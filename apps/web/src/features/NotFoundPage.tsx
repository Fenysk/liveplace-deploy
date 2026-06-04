/**
 * Dedicated 404 page (FEN-114). Any unknown path resolves here (routes.ts →
 * `notFound`) instead of silently rendering the home shell, so a mistyped/stale
 * URL gets an explicit "this doesn't exist" signal plus a way back — no
 * dead-end. Rendered inside the shared {@link AppShell}, so the persistent nav
 * is already present; this body just states the error and offers the canvas as
 * the obvious next step. All copy is i18n (FR↔EN in place).
 */
import { useTranslate } from "@canvas/i18n/react";
import { Link } from "../router.js";
import { paths } from "../routes.js";

export function NotFoundPage(): React.ReactElement {
  const t = useTranslate();
  return (
    <section aria-labelledby="notfound-title" style={{ textAlign: "center", padding: "3rem 1rem" }}>
      <p style={{ fontSize: 48, fontWeight: 800, margin: 0, color: "#999" }}>404</p>
      <h1 id="notfound-title" style={{ margin: "0.5rem 0" }}>
        {t("notFound.title")}
      </h1>
      <p style={{ color: "#777", maxWidth: 420, margin: "0 auto 1.5rem" }}>{t("notFound.body")}</p>
      <Link
        to={paths.home()}
        style={{
          display: "inline-block",
          padding: "0.5rem 1.25rem",
          borderRadius: 8,
          border: "1px solid #ccc",
          textDecoration: "none",
          color: "inherit",
        }}
      >
        {t("notFound.backToCanvas")}
      </Link>
    </section>
  );
}
