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
import { usePaginatedQuery, useQuery } from "convex/react";
import { type PaginationOptions, type PaginationResult } from "convex/server";
import { api } from "@canvas/convex/api";
import { useTranslate, useLocale } from "@canvas/i18n/react";
import { Link } from "@tanstack/react-router";
import { Button, Skeleton, StateScreen, StateArt } from "../../ui/index.js";
import { useProfileSheet } from "../profile/profileSheetStore.js";
import {
  buildGalleryView,
  type GalleryCardView,
  type GalleryItem,
  type GalleryPage as GalleryEnvelope,
} from "./galleryView.js";
import { CanvasPreview, PixelGridPreview } from "./CanvasPreview.js";
import "./gallery.css";

const PAGE_SIZE = 24;

const LIVE_THRESHOLD_MS = 10 * 60 * 1000;

const listPublicCanvases = api.gallery.listPublicCanvases;
const pixelGridForCanvas = api.gallery.pixelGridForCanvas;

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
              <Skeleton style={{ aspectRatio: "1 / 1" }} />
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
        primary={{ label: t("state.emptyGallery.cta1"), href: "/" }}
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
              statusLabel={t(card.twitchLive ? "gallery.status.live" : "gallery.status.offline")}
              onCanvasLabel={t("gallery.onCanvas", { count: card.viewers })}
              streamerLabel={t("gallery.viewStreamer", { name: card.streamerDisplayName })}
              emptyCanvasLabel={t("gallery.emptyCanvas")}
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
  statusLabel,
  onCanvasLabel,
  streamerLabel,
  emptyCanvasLabel,
}: {
  card: GalleryCardView;
  statusLabel: string;
  onCanvasLabel: string;
  streamerLabel: string;
  emptyCanvasLabel: string;
}): React.ReactElement {
  const { openProfile } = useProfileSheet();
  // B5: lazy-load pixel grid on demand (not during the list query).
  const pixelGridData = useQuery(pixelGridForCanvas, { slug: card.slug });
  const pixelGrid = pixelGridData?.pixelGrid ?? null;
  const width = pixelGridData?.width ?? card.width;
  const height = pixelGridData?.height ?? card.height;
  return (
    <div className="gallery__card">
      <Link
        to="/$pseudo"
        params={{ pseudo: card.slug }}
        className="gallery__cardLink"
        aria-label={`${card.title} — ${statusLabel} — ${onCanvasLabel}`}
      >
        <div className="gallery__thumb">
          {pixelGrid && width > 0 && height > 0 ? (
            pixelGrid.some((v) => v !== 0) ? (
              <PixelGridPreview pixelGrid={pixelGrid} width={width} height={height} />
            ) : (
              <div
                className="gallery__thumbEmpty"
                style={{ '--canvas-w': width, '--canvas-h': height } as React.CSSProperties}
              >
                <span className="gallery__thumbEmptyLabel" aria-hidden>{emptyCanvasLabel}</span>
              </div>
            )
          ) : card.hasThumbnail && card.thumbnailUrl ? (
            <img src={card.thumbnailUrl} alt="" loading="lazy" className="gallery__thumbImg" />
          ) : card.latestSnapshotUrl ? (
            <CanvasPreview snapshotUrl={card.latestSnapshotUrl} />
          ) : (
            <div className="gallery__thumbPlaceholder" aria-hidden />
          )}
          <div className="gallery__viewers">
            <span
              className="gallery__statusDot"
              aria-hidden
              data-live={card.twitchLive ? "true" : undefined}
            />
            <span className="gallery__statusLabel">{statusLabel}</span>
            <span className="gallery__badgeSep" aria-hidden>·</span>
            <svg
              className="gallery__viewerIcon"
              aria-hidden
              focusable="false"
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="currentColor"
            >
              <circle cx="5" cy="3.5" r="2" />
              <path d="M0.5 9.5C0.5 7.29 2.52 5.5 5 5.5s4.5 1.79 4.5 4" />
            </svg>
            <span>{card.viewers}</span>
          </div>
        </div>
        <strong className="gallery__cardTitle">{card.title}</strong>
      </Link>

      <button
        type="button"
        className="gallery__streamer"
        aria-label={streamerLabel}
        onClick={() => openProfile(card.streamerLogin)}
      >
        {card.avatarUrl ? (
          <img src={card.avatarUrl} alt="" className="gallery__avatar" />
        ) : (
          <span className="gallery__avatarPlaceholder" aria-hidden />
        )}
        <span className="gallery__streamerName">{card.streamerDisplayName}</span>
      </button>
    </div>
  );
}
