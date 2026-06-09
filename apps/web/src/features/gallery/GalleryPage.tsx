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
// Arcade direction (FEN-272, Lot D · handoff §7): reuse the Foundation primitives
// + tokens (the barrel import also pulls in the global Arcade stylesheet). No
// hardcoded values — token-only styling lives in `gallery.css`.
import { Button, EmptyState, Skeleton } from "../../ui/index.js";
import { buttonClass } from "../../ui/variants.js";
import "./gallery.css";
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
      <main className="gallery" aria-label={t("nav.gallery")} aria-busy>
        <h1 className="gallery__title">{t("nav.gallery")}</h1>
        {/* Loading skeleton (planche §4) instead of a bare "Loading…" line. */}
        <ul className="gallery__grid">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i}>
              <Skeleton style={{ aspectRatio: "16 / 9" }} />
            </li>
          ))}
        </ul>
        <p className="ui-sr-only">{t("common.loading")}</p>
      </main>
    );
  }

  return (
    <main className="gallery" aria-label={t("nav.gallery")}>
      <h1 className="gallery__title">{t(view.titleKey)}</h1>

      {view.isEmpty ? (
        // Empty state keeps the funnel moving (FEN-125): the persistent nav already
        // prevents a dead-end, but a forward CTA to the live canvas is more inviting.
        <EmptyState
          title={t(view.emptyKey)}
          action={
            <Link to={paths.canvas()} className={buttonClass("primary", "md")}>
              {t("gallery.emptyCta")}
            </Link>
          }
        />
      ) : (
        <>
          <ul className="gallery__grid">
            {view.cards.map((card) => (
              <li key={card.slug}>
                <GalleryCard
                  card={card}
                  viewersLabel={t(card.viewersKey, { count: card.viewers })}
                  streamerLabel={t("gallery.viewStreamer", { name: card.streamerDisplayName })}
                />
              </li>
            ))}
          </ul>

          {status === "CanLoadMore" && (
            <Button
              variant="secondary"
              size="md"
              className="gallery__more"
              onClick={() => loadMore(PAGE_SIZE)}
            >
              {t("common.loadMore")}
            </Button>
          )}
          {status === "LoadingMore" && <p className="gallery__muted">{t("common.loading")}</p>}
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
    <div className="gallery__card">
      <Link
        to={paths.canvas(card.slug)}
        className="gallery__cardLink"
        aria-label={`${card.title} — ${viewersLabel}`}
      >
        <div className="gallery__thumb">
          {card.hasThumbnail && card.thumbnailUrl ? (
            <img src={card.thumbnailUrl} alt="" loading="lazy" className="gallery__thumbImg" />
          ) : (
            // Placeholder tile — worker hasn't pre-rendered a preview yet (G-Perf3).
            <div className="gallery__thumbPlaceholder" aria-hidden />
          )}
          <span className="gallery__viewers">👁 {viewersLabel}</span>
        </div>
        <strong className="gallery__cardTitle">{card.title}</strong>
      </Link>

      <Link
        to={paths.profile(card.streamerLogin)}
        className="gallery__streamer"
        aria-label={streamerLabel}
      >
        {card.avatarUrl ? (
          <img src={card.avatarUrl} alt="" className="gallery__avatar" />
        ) : (
          <span className="gallery__avatarPlaceholder" aria-hidden />
        )}
        <span className="gallery__streamerName">{card.streamerDisplayName}</span>
      </Link>
    </div>
  );
}
