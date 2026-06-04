/**
 * Public gallery page — canvas discovery (F12, FEN-34).
 *
 * Presentational only: every display decision (loading/empty/ready, viewer-count
 * formatting, thumbnail fallback, i18n key selection) lives in the pure,
 * unit-tested `buildGalleryView` (galleryView.ts, FEN-23). This component just
 * subscribes to the Convex `gallery:listPublicCanvases` paginated query, adapts
 * its envelope to the view-model, and renders the descriptor. Strings go through
 * `t(...)` so the page flips FR↔EN in place (parity already shipped in
 * `@canvas/i18n`: gallery.title / gallery.viewers / gallery.empty).
 *
 * - CA1 — lists public, active canvases with a thumbnail (or placeholder) + live
 *   viewer count, most-active first.
 * - CA2 — each card is a link to `/c/{slug}`; clicking opens that canvas.
 * - G-Perf3 — thumbnails are NEVER computed here. When the worker has not
 *   pre-rendered one yet (`hasThumbnail === false`) we draw a CSS placeholder
 *   tile; we never synthesize an image.
 *
 * See docs/contracts/gallery-read.md.
 *
 * The query is referenced BY NAME via `makeFunctionReference` rather than the
 * generated `@canvas/convex/api`, so the web build stays decoupled from any
 * committed `convex codegen` output — the same web↔Convex calling convention the
 * leaderboard panel established (FEN-32). The Convex client is provided app-wide
 * by `ConvexAuthProvider` (main.tsx). Mounted in the app shell under `#gallery`.
 */
import { usePaginatedQuery } from "convex/react";
import { makeFunctionReference, type PaginationOptions, type PaginationResult } from "convex/server";
import { useTranslate, useLocale } from "@canvas/i18n/react";
import { Link } from "../../router.js";
import { paths } from "../../routes.js";
import {
  buildGalleryView,
  type GalleryCardView,
  type GalleryItem,
  type GalleryPage as GalleryEnvelope,
} from "./galleryView.js";

/** How many cards to fetch per page (CA1 feed; "load more" pulls the next page). */
const PAGE_SIZE = 24;

/**
 * `gallery:listPublicCanvases` referenced by name (`module:function`). Arg and
 * return types mirror the gallery-read contract so `results` stays typed as
 * `GalleryItem[]` without pulling in the generated api.
 */
const listPublicCanvases = makeFunctionReference<
  "query",
  { paginationOpts: PaginationOptions },
  PaginationResult<GalleryItem>
>("gallery:listPublicCanvases");

export function GalleryPage(): React.ReactElement {
  const t = useTranslate();
  const locale = useLocale();

  // usePaginatedQuery injects `paginationOpts`; the query only declares that arg,
  // so we pass `{}`. It accumulates `results` across pages and exposes a status
  // we map back onto the view-model's single-page envelope shape.
  const { results, status, loadMore } = usePaginatedQuery(
    listPublicCanvases,
    {},
    { initialNumItems: PAGE_SIZE },
  );

  const envelope: GalleryEnvelope | undefined =
    status === "LoadingFirstPage"
      ? undefined
      : { page: results, isDone: status === "Exhausted", continueCursor: null };

  const view = buildGalleryView(envelope, locale);

  if (view.state === "loading") {
    return (
      <main style={pageStyle} aria-label={t("nav.gallery")} aria-busy>
        <h1 style={titleStyle}>{t("nav.gallery")}</h1>
        <p style={mutedStyle}>{t("common.loading")}</p>
      </main>
    );
  }

  return (
    <main style={pageStyle} aria-label={t("nav.gallery")}>
      <h1 style={titleStyle}>{t(view.titleKey)}</h1>

      {view.isEmpty ? (
        <p style={mutedStyle}>{t(view.emptyKey)}</p>
      ) : (
        <>
          <ul style={gridStyle}>
            {view.cards.map((card) => (
              <li key={card.slug} style={{ listStyle: "none" }}>
                <GalleryCard
                  card={card}
                  viewersLabel={t(card.viewersKey, { count: card.viewers })}
                  streamerLabel={t("gallery.viewStreamer", { name: card.streamerDisplayName })}
                />
              </li>
            ))}
          </ul>

          {status === "CanLoadMore" && (
            <button type="button" style={loadMoreStyle} onClick={() => loadMore(PAGE_SIZE)}>
              {t("common.loadMore")}
            </button>
          )}
          {status === "LoadingMore" && <p style={mutedStyle}>{t("common.loading")}</p>}
        </>
      )}
    </main>
  );
}

/**
 * One discovery card. Maillage (FEN-114): two distinct destinations — the
 * thumbnail+title open the canvas (CA2 → `/c/{slug}`), and the streamer row
 * links to that streamer's public profile (`/u/{login}`). They can't be one
 * anchor (no nested links), so the card is a container with two client-side
 * `Link`s, each natively keyboard-focusable and announced as a link.
 */
function GalleryCard({
  card,
  viewersLabel,
  streamerLabel,
}: {
  card: GalleryCardView;
  viewersLabel: string;
  streamerLabel: string;
}): React.ReactElement {
  return (
    <div style={cardStyle}>
      <Link
        to={paths.canvas(card.slug)}
        style={cardLinkStyle}
        aria-label={`${card.title} — ${viewersLabel}`}
      >
        <div style={thumbWrapStyle}>
          {card.hasThumbnail && card.thumbnailUrl ? (
            <img src={card.thumbnailUrl} alt="" loading="lazy" style={thumbImgStyle} />
          ) : (
            // Placeholder tile — worker hasn't pre-rendered a preview yet (G-Perf3).
            <div style={thumbPlaceholderStyle} aria-hidden />
          )}
          <span style={viewersBadgeStyle}>👁 {viewersLabel}</span>
        </div>
        <strong style={{ ...cardTitleStyle, padding: "0.75rem 0.75rem 0" }}>{card.title}</strong>
      </Link>

      <Link
        to={paths.profile(card.streamerLogin)}
        style={streamerRowStyle}
        aria-label={streamerLabel}
      >
        {card.avatarUrl ? (
          <img src={card.avatarUrl} alt="" style={avatarStyle} />
        ) : (
          <span style={avatarPlaceholderStyle} aria-hidden />
        )}
        <span style={streamerNameStyle}>{card.streamerDisplayName}</span>
      </Link>
    </div>
  );
}

// --- Inline styles -----------------------------------------------------------
// Inline like the app shell (App.tsx) so the page renders usably without relying
// on a global stylesheet the web shell doesn't ship yet. A Designer pass (Phase
// 3) can lift these into CSS later.

const pageStyle: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  maxWidth: 960,
  margin: "3rem auto",
  padding: "0 1rem",
};
const titleStyle: React.CSSProperties = { margin: "0 0 1.5rem" };
const mutedStyle: React.CSSProperties = { color: "#777" };
const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
  gap: "1rem",
  padding: 0,
  margin: 0,
};
const cardStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  border: "1px solid #e3e3e3",
  borderRadius: 10,
  overflow: "hidden",
  background: "#fff",
};
const cardLinkStyle: React.CSSProperties = {
  display: "block",
  textDecoration: "none",
  color: "inherit",
};
const thumbWrapStyle: React.CSSProperties = {
  position: "relative",
  aspectRatio: "16 / 9",
  background: "#f3f3f5",
};
const thumbImgStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
};
const thumbPlaceholderStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  background: "repeating-linear-gradient(45deg, #ececf1, #ececf1 10px, #f5f5f8 10px, #f5f5f8 20px)",
};
const viewersBadgeStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 8,
  left: 8,
  padding: "2px 8px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 600,
  color: "#fff",
  background: "rgba(0, 0, 0, 0.65)",
};
const cardTitleStyle: React.CSSProperties = {
  display: "block",
  fontSize: 15,
  lineHeight: 1.3,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const streamerRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "0.5rem 0.75rem 0.75rem",
  textDecoration: "none",
  color: "inherit",
};
const avatarStyle: React.CSSProperties = { width: 22, height: 22, borderRadius: "50%", objectFit: "cover" };
const avatarPlaceholderStyle: React.CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: "50%",
  background: "#d8d8de",
};
const streamerNameStyle: React.CSSProperties = { fontSize: 13, color: "#555" };
const loadMoreStyle: React.CSSProperties = {
  marginTop: "1.5rem",
  padding: "0.5rem 1.25rem",
  borderRadius: 8,
  border: "1px solid #ccc",
  background: "#fff",
  cursor: "pointer",
};
