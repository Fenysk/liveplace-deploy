/**
 * Public gallery projection — the read-model behind the discovery page (F12,
 * FEN-23). See the contract: docs/contracts/gallery-read.md.
 *
 * Pure and framework-free (no Convex imports) so it can be unit-tested without a
 * Convex runtime and reused by the query layer and any future SSR path.
 *
 * It is also a **CA2-style security boundary**: it receives a canvas row plus
 * the owner's public profile row and returns ONLY an explicit allow-list of
 * public fields. `ownerId` (the Better Auth user id), palette ids, event windows
 * and internal counters are never surfaced — the projection is allow-list, not
 * deny-list, so adding a private column to the source row later can never leak.
 *
 * The gallery NEVER computes a thumbnail on the fly (G-Perf3). The preview image
 * is rendered off the hot path by the persistence worker (FEN-17/FEN-29) and the
 * canvas row only carries a pointer to the latest blob; this read-model just
 * passes through the resolved URL (or `null` while none exists yet).
 */

/**
 * The subset of a `canvases` row the gallery reads. The index signature tolerates
 * the many other (private/internal) columns without surfacing them.
 */
export interface GalleryCanvasRow {
  _id: string;
  slug: string; // URL identifier — the click-through key (CA2)
  title: string;
  ownerId: string; // Better Auth user id — used to join the profile; NEVER surfaced
  isPublic: boolean;
  status: "active" | "archived";
  /** Epoch ms of the most recent placement (worker-maintained); falls back to createdAt. */
  lastActivityAt?: number;
  createdAt: number;
  /** Current live viewer count, periodically flushed by the worker/gateway (off hot path). */
  viewerCount?: number;
  [key: string]: unknown;
}

/** App-owned public identity mirror (`profiles` table), joined on `ownerId`. */
export interface GalleryStreamerRow {
  login: string;
  displayName: string;
  avatarUrl?: string | null;
  [key: string]: unknown;
}

/** Public, render-ready gallery card. No internal ids or private fields. */
export interface GalleryItem {
  /** Click-through target: the public canvas at `/c/{slug}` (CA2). */
  slug: string;
  title: string;
  streamer: {
    login: string;
    displayName: string;
    avatarUrl: string | null;
  };
  /** Pre-generated preview image URL, or `null` if none has been rendered yet (G-Perf3). */
  thumbnailUrl: string | null;
  /** Non-negative integer count of current live viewers. */
  viewerCount: number;
  /** Epoch ms used for the activity sort; the most recent placement or createdAt. */
  lastActivityAt: number;
}

/** A canvas is listable in the public gallery iff it is public AND active (CA1). */
export function isListablePublicCanvas(c: {
  isPublic: boolean;
  status: "active" | "archived";
}): boolean {
  return c.isPublic === true && c.status === "active";
}

/** The effective activity timestamp for sorting/display: latest placement, else createdAt. */
export function activityTimestamp(c: {
  lastActivityAt?: number;
  createdAt: number;
}): number {
  return typeof c.lastActivityAt === "number" ? c.lastActivityAt : c.createdAt;
}

/** Clamp an arbitrary viewer value to a non-negative integer (defaults to 0). */
function safeViewerCount(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Allow-list projection of a canvas (+ its streamer profile and a resolved
 * thumbnail URL) to the public gallery card. (CA2)
 *
 * `streamer` may be `null` when the owner's profile has not been synced yet (or
 * was deleted): the card still lists, falling back to the canvas slug for the
 * streamer name rather than dropping a live public canvas from discovery.
 */
export function toGalleryItem(
  canvas: GalleryCanvasRow,
  streamer: GalleryStreamerRow | null,
  thumbnailUrl: string | null,
): GalleryItem {
  return {
    slug: canvas.slug,
    title: canvas.title,
    streamer: {
      login: streamer?.login ?? canvas.slug,
      displayName: streamer?.displayName ?? canvas.slug,
      avatarUrl: streamer?.avatarUrl ?? null,
    },
    thumbnailUrl: thumbnailUrl ?? null,
    viewerCount: safeViewerCount(canvas.viewerCount),
    lastActivityAt: activityTimestamp(canvas),
  };
}

/**
 * Order two gallery items by activity, most-active first (CA: "tri par activité").
 * Ties break by live viewer count (desc) then slug (asc) for a stable order.
 *
 * The Convex query paginates on the `by_public_activity` index so the page is
 * already activity-ordered; this comparator is the same rule, exposed for tests
 * and any in-memory re-sort (e.g. SSR or a merged multi-source list).
 */
export function compareByActivity(a: GalleryItem, b: GalleryItem): number {
  return (
    b.lastActivityAt - a.lastActivityAt ||
    b.viewerCount - a.viewerCount ||
    (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker write path — discovery-field merge (F12 / FEN-33, ADR-0001).
//
// The persistence worker maintains the discovery fields ON the canvas row, off
// the hot path. This pure merge is the heart of the `canvas:setGalleryFields`
// mutation; keeping it framework-free lets the monotonic/idempotent rules be
// unit-tested without a Convex runtime.
// ─────────────────────────────────────────────────────────────────────────────

/** A worker discovery-field write. Every field is independently optional. */
export interface GalleryFieldsUpdate {
  /** Epoch ms of the newest drained placement this flush. */
  lastActivityAt?: number;
  /** Latest presence snapshot (a level, not a counter). */
  viewerCount?: number;
  /** Blob ref of a freshly rendered preview; paired with `thumbnailVersion`. */
  thumbnailStorageId?: string;
  /** Canvas version the preview depicts; pairs with `thumbnailStorageId`. */
  thumbnailVersion?: number;
}

/** The discovery state already on the row, against which the update is merged. */
export interface GalleryFieldsState {
  lastActivityAt?: number;
  viewerCount?: number;
  thumbnailStorageId?: string;
  thumbnailVersion?: number;
}

/** Resolved patch: only changed fields, plus any blob the caller must free. */
export interface GalleryFieldsPatch {
  lastActivityAt?: number;
  viewerCount?: number;
  thumbnailStorageId?: string;
  thumbnailVersion?: number;
  /** A superseded thumbnail blob id the caller should delete from storage. */
  freeStorageId?: string;
}

/**
 * Compute the monotonic, idempotent patch for a worker discovery-field write.
 *
 * - `lastActivityAt` only ever advances, so an out-of-order or redelivered flush
 *   can never regress the gallery's activity sort.
 * - `thumbnailVersion` only advances; the blob ref swaps ONLY when the version
 *   advances (G-Perf3 keeps exactly one preview), and the superseded blob id is
 *   returned as `freeStorageId` so the caller can free it.
 * - `viewerCount` is a latest-wins presence level, clamped to a non-negative
 *   integer; a non-finite value is ignored.
 *
 * Returns ONLY the fields that actually change — an idempotent re-send of the
 * same or older values yields an empty patch (no write).
 */
export function planGalleryFieldsPatch(
  state: GalleryFieldsState,
  update: GalleryFieldsUpdate,
): GalleryFieldsPatch {
  const patch: GalleryFieldsPatch = {};

  if (typeof update.lastActivityAt === "number" && Number.isFinite(update.lastActivityAt)) {
    if (state.lastActivityAt === undefined || update.lastActivityAt > state.lastActivityAt) {
      patch.lastActivityAt = update.lastActivityAt;
    }
  }

  if (update.viewerCount !== undefined) {
    const v = Math.max(0, Math.floor(update.viewerCount));
    if (Number.isFinite(v) && v !== state.viewerCount) patch.viewerCount = v;
  }

  // Thumbnail blob + version move together and only forward.
  if (
    typeof update.thumbnailVersion === "number" &&
    Number.isFinite(update.thumbnailVersion) &&
    update.thumbnailStorageId !== undefined &&
    (state.thumbnailVersion === undefined || update.thumbnailVersion > state.thumbnailVersion)
  ) {
    patch.thumbnailVersion = update.thumbnailVersion;
    patch.thumbnailStorageId = update.thumbnailStorageId;
    if (state.thumbnailStorageId && state.thumbnailStorageId !== update.thumbnailStorageId) {
      patch.freeStorageId = state.thumbnailStorageId;
    }
  }

  return patch;
}
