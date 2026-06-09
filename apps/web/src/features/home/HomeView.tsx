/**
 * FEN-433 (AC-2 / AC-3 / C3) — Home page for anonymous visitors.
 *
 * Authenticated users are redirected to their personal canvas from `router.tsx`
 * (the Convex `me` query drives this); anonymous visitors land here and see a
 * lightweight hero with a Twitch sign-in CTA and a link to the gallery.
 *
 * Kept minimal — the fine visual pass is for a later UI lot. The structure
 * (app title, tagline, CTA, gallery link) is the "HomeView léger" from the spec.
 */
import { useTranslate } from "@canvas/i18n/react";
import { AuthButton } from "../../auth/AuthButton.js";
import { Link } from "../../router.js";
import { paths } from "../../routes.js";

export function HomeView(): React.ReactElement {
  const t = useTranslate();
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
        gap: "1.5rem",
        padding: "2rem 1rem",
        textAlign: "center",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ fontSize: "2rem", fontWeight: 700, margin: 0 }}>LivePlace</h1>
      <p style={{ fontSize: "1.1rem", color: "#555", margin: 0 }}>{t("home.tagline")}</p>
      <AuthButton />
      <Link
        to={paths.gallery()}
        style={{ color: "inherit", textDecoration: "underline", fontSize: "0.95rem" }}
      >
        {t("home.discover")}
      </Link>
    </main>
  );
}
