/**
 * Shared paginated public-gallery grid (FEN-1160, D-1 / C-4).
 *
 * Extracted from GalleryPage so the same paginated grid can be embedded on
 * the home page (LiveDiscovery) without re-implementing the data layer.
 * Self-contained: subscribes to `gallery:listPublicCanvases`, manages its own
 * loading skeleton, empty state, and "Load More" button.
 *
 * Rendering contract:
 *  - Caller provides any heading (`<h1>`, `<h2>`, …) — this component renders
 *    only the grid body (skeleton | empty-state | cards + pagination).
 *  - `gallery.css` is side-effect-imported here so callers don't have to.
 */
import { usePaginatedQuery } from "convex/react";
import { makeFunctionReference, type PaginationOptions, type PaginationResult } from "convex/server";
import { useTranslate, useLocale } from "@canvas/i18n/react";
import { Link } from "../../router.js";
import { paths } from "../../routes.js";
import { Button, Skeleton, StateScreen, StateArt } from "../../ui/index.js";
import {
  buildGalleryView,
  type GalleryCardView,
  type GalleryItem,
  type GalleryPage as GalleryEnvelope,
} from "./galleryView.js";
import "./gallery.css";

const PAGE_SIZE = 24;

/** Canvas active within 10 min = live (mirrors N_LIVE_MIN from liveDiscovery). */
const LIVE_THRESHOLD_MS = 10 * 60 * 1000;

const listPublicCanvases = makeFunctionReference<
  "query",
  { paginationOpts: PaginationOptions },
  PaginationResult<GalleryItem>
>("gallery:listPublicCanvases");

/**
 * Paginated gallery grid of public canvases. Handles its own Convex subscription
 * and renders skeleton → cards+load-more → empty-state transitions.
 */
export function PublicGalleryGrid(): React.ReactElement {
  const t = useTranslate();
  const locale = useLocale();

  const { results, status, loadMore } = usePaginatedQuery(
    listPublicCanvases,
    {},
    { initialNumItems: PAGE_SIZE },
  );

  const nowMs = Date.now();
  const sortedResults = [...results].sort((a, b) => {
    const aLive = nowMs - a.lastActivityAt <= LIVE_THRESHOLD_MS;
    const bLive = nowMs - b.lastActivityAt <= LIVE_THRESHOLD_MS;
    if (aLive === bLive) return 0;
    return aLive ? -1 : 1;
  });

  const envelope: GalleryEnvelope | undefined =
    status === "LoadingFirstPage"
      ? undefined
      : { page: sortedResults, isDone: status === "Exhausted", continueCursor: null };

  const view = buildGalleryView(envelope, locale);

  if (view.state === "loading") {
    return (
      <div aria-busy>
        <ul className="gallery__grid">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i}>
              <Skeleton style={{ aspectRatio: "16 / 9" }} />
            </li>
          ))}
        </ul>
        <p className="ui-sr-only">{t("common.loading")}</p>
      </div>
    );
  }

  if (view.isEmpty) {
    return (
      <StateScreen
        id="gallery-empty"
        kicker={t("state.emptyGallery.kicker")}
        title={t("state.emptyGallery.title")}
        subtitle={t("state.emptyGallery.sub")}
        art={<StateArt.emptyGallery />}
        primary={{ label: t("state.emptyGallery.cta1"), href: paths.home() }}
      />
    );
  }

  return (
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
  );
}

/**
 * One discovery card. Maillage (FEN-114): two distinct destinations — the
 * thumbnail+title open the canvas, and the streamer row links to that
 * streamer's public profile (`/u/{login}`). They can't be one anchor (no
 * nested links), so the card is a container with two client-side `Link`s.
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
