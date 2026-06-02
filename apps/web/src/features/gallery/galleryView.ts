/**
 * Presentation view-model for the public gallery page (F12, FEN-23).
 *
 * Pure and React-free so it unit-tests without a DOM and keeps all display logic
 * (states, number formatting, thumbnail fallback, i18n key selection) out of the
 * JSX. The component (`GalleryPage.tsx`) calls `buildGalleryView` with the Convex
 * `gallery:listPublicCanvases` page result and renders the returned descriptor.
 * i18n keys are RETURNED, not resolved here, so this stays locale-agnostic — see
 * docs/contracts/gallery-read.md.
 *
 * The shape below mirrors the `GalleryItem` the query returns (contract); it is
 * re-declared locally to avoid coupling the web build to the Convex package.
 */

/** One card as returned by the `gallery:listPublicCanvases` query. */
export interface GalleryItem {
  slug: string;
  title: string;
  streamer: { login: string; displayName: string; avatarUrl: string | null };
  thumbnailUrl: string | null;
  viewerCount: number;
  lastActivityAt: number;
}

/** A card ready to render: numbers formatted, thumbnail state resolved. */
export interface GalleryCardView {
  /** Click-through target: route to `/c/{slug}` to open the canvas (CA2). */
  slug: string;
  title: string;
  streamerDisplayName: string;
  streamerLogin: string;
  avatarUrl: string | null;
  /** Resolved preview URL, or null → the component shows a placeholder tile. */
  thumbnailUrl: string | null;
  /** True when no pre-rendered thumbnail exists yet (render a placeholder). */
  hasThumbnail: boolean;
  /** Locale-formatted viewer count + its i18n label key. */
  viewers: string;
  viewersKey: "gallery.viewers";
}

export type GalleryView =
  | { state: "loading" }
  | {
      state: "ready";
      /** True when there are no public canvases (show empty-state copy). */
      isEmpty: boolean;
      emptyKey: "gallery.empty";
      titleKey: "gallery.title";
      cards: GalleryCardView[];
      /** Forwarded from the query envelope so the page can drive "load more". */
      isDone: boolean;
      continueCursor: string | null;
    };

/** The Convex pagination envelope returned by `listPublicCanvases`. */
export interface GalleryPage {
  page: GalleryItem[];
  isDone: boolean;
  continueCursor: string | null;
}

/**
 * Build the view descriptor from a Convex paginated query result.
 * - `undefined` → query still loading (Convex `useQuery`/`usePaginatedQuery`).
 * - GalleryPage → ready (possibly empty).
 */
export function buildGalleryView(
  result: GalleryPage | null | undefined,
  locale = "en",
): GalleryView {
  if (result === undefined || result === null) return { state: "loading" };

  const nf = new Intl.NumberFormat(locale);

  return {
    state: "ready",
    isEmpty: result.page.length === 0,
    emptyKey: "gallery.empty",
    titleKey: "gallery.title",
    isDone: result.isDone,
    continueCursor: result.continueCursor,
    cards: result.page.map((item) => ({
      slug: item.slug,
      title: item.title,
      streamerDisplayName: item.streamer.displayName,
      streamerLogin: item.streamer.login,
      avatarUrl: item.streamer.avatarUrl,
      thumbnailUrl: item.thumbnailUrl,
      hasThumbnail: item.thumbnailUrl !== null,
      viewers: nf.format(item.viewerCount),
      viewersKey: "gallery.viewers",
    })),
  };
}
