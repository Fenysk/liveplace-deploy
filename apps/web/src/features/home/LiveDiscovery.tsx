/**
 * LiveDiscovery — home live-discovery page (G6 / FEN-611).
 *
 * FEN-1423: the live rail is removed; the gallery grid is the sole content
 * section and shows active (live) canvases first (sorted in PublicGalleryGrid).
 */
import { useTranslate } from "@canvas/i18n/react";
import { Wordmark } from "../../ui/index.js";
import { AuthButton } from "../../auth/AuthButton.js";
import { Link } from "@tanstack/react-router";
import { PublicGalleryGrid } from "../gallery/PublicGalleryGrid.js";
import "./home.css";

export function LiveDiscovery(): React.ReactElement {
  const t = useTranslate();

  return (
    <div className="home-discovery">
      {/* Sticky topbar */}
      <header className="home-topbar" role="banner">
        <div className="home-topbar__brand">
          <Link to="/" aria-label="LivePlace">
            <Wordmark size="sm" />
          </Link>
        </div>
        <nav className="home-topbar__actions" aria-label={t("nav.primary")}>
          <AuthButton />
        </nav>
      </header>

      {/* Hero */}
      <section className="home-hero" aria-labelledby="home-hero-title">
        <span className="home-hero__kicker" aria-hidden="true">✦ LivePlace</span>
        <h1 className="home-hero__title" id="home-hero-title">
          {t("app.tagline")}
        </h1>
        <p className="home-hero__subtitle">{t("home.tagline")}</p>
      </section>

      {/* Gallery — active canvases first */}
      <main className="home-content" id="main-content">
        <section aria-label={t("home.discovery.allRail")}>
          <div className="home-rail__header">
            <h2 className="home-rail__title">{t("home.discovery.allRail")}</h2>
          </div>
          <PublicGalleryGrid />
        </section>
      </main>
    </div>
  );
}
