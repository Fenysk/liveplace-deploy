/**
 * Pixel-info view-model (FEN-249 / FEN-755) — the framework-agnostic core of
 * the refonte "clic → infos → Dessiner → Confirmer" pose flow (FEN-248).
 *
 * FEN-755 extends the occupancy model to carry the full §4.2 encadré data:
 * avatar URL, placement timestamp, and colour index (for the swatch) alongside
 * the existing placer login. The four author states are unchanged; "known" now
 * also implies avatarUrl/ts are available.
 *
 * This pure reducer is the Definition-of-Done unit-tested surface
 * ({@link derivePixelInfo}, `pixelInfo.test.ts`). The React layer maps the
 * returned {@link PixelAuthorState} to i18n keys and renders the panel; clicking
 * never stages a cell (that only starts after "Dessiner").
 */

/**
 * Palette index of the empty/default cell (idx 0 = white/empty in the FROZEN
 * `@canvas/protocol` PALETTE). Kept local to this pure module so it carries no
 * runtime import (type-stripping cannot resolve a sibling `.js` value import);
 * it intentionally mirrors `selection.EMPTY_COLOR`.
 */
const EMPTY_COLOR = 0;

/**
 * Occupancy data for a painted (non-empty) cell — the richer attribution shape
 * returned by the `canvases:pixelAuthor` query (FEN-755). Carries all three
 * display fields in one object so the panel can render avatar + login +
 * date/time in a single render without further async work.
 *
 * `login` is `null` for anonymous placements — the cell IS painted but the
 * placer had no account (pre-auth canvas). `avatarUrl` is `null` when the
 * profile has no Twitch picture. `ts` is always non-null for an occupied cell
 * (the placement log always carries a write timestamp).
 */
export interface PixelOccupancy {
  /** Public Twitch login, or `null` for an anonymous placement. */
  login: string | null;
  /** Twitch profile picture URL, or `null` (anonymous / missing profile). */
  avatarUrl: string | null;
  /** Epoch ms when this cell was last placed. Always non-null for an occupied cell. */
  ts: number | null;
}

/**
 * Resolves occupancy data for the top pixel at a cell. Returns `null` when the
 * cell is empty, erased, or the canvas is not loaded yet. Returns a
 * {@link PixelOccupancy} for any painted cell — even when the placer is
 * anonymous (`login: null`), so the panel can still show the placement date.
 */
export interface PixelAuthorSource {
  authorAt(x: number, y: number): Promise<PixelOccupancy | null>;
}

/**
 * Inert source used until the viewer-facing backend attribution query lands
 * (FEN-249 backend dependency). Always resolves to `null` → the panel shows
 * "author unavailable" rather than fabricating data.
 */
export const inertPixelAuthorSource: PixelAuthorSource = {
  authorAt: () => Promise.resolve(null),
};

/**
 * How the panel should render the "placed by" line:
 *   - `empty`   — the cell was never posed (colour = {@link EMPTY_COLOR}); show
 *                 coordinates + "no author" (acceptance: not an error).
 *   - `loading` — the canvas/cell is still resolving (colour < 0) or the author
 *                 lookup is in flight (`author === undefined`).
 *   - `known`   — a placer resolved; {@link PixelInfoVM.authorLogin} is set.
 *   - `unknown` — anonymous placement or lookup resolved to nothing.
 */
export type PixelAuthorState = "empty" | "loading" | "known" | "unknown";

export interface PixelInfoVM {
  x: number;
  y: number;
  /** True when the cell has never been posed (its colour is the empty index). */
  isEmpty: boolean;
  authorState: PixelAuthorState;
  /** Placer login when `authorState === "known"`, else `null`. */
  authorLogin: string | null;
  /** Twitch avatar URL when `authorState === "known"`, else `null`. */
  avatarUrl: string | null;
  /** Epoch ms of the placement; non-null when `authorState === "known" | "unknown"`. */
  ts: number | null;
  /** Palette colour index of the cell (for the colour swatch). */
  color: number;
}

/**
 * Derive the info-panel view-model for a clicked cell.
 *
 * @param color Palette index at the cell: {@link EMPTY_COLOR} (0) = empty,
 *   a positive index = a painted pixel, a negative value = canvas not loaded.
 * @param author The resolved {@link PixelOccupancy}, `null` when the cell is
 *   empty/unloaded/error, or `undefined` while the lookup is still in flight.
 */
export function derivePixelInfo(input: {
  x: number;
  y: number;
  color: number;
  author: PixelOccupancy | null | undefined;
}): PixelInfoVM {
  const { x, y, color, author } = input;

  // Canvas/cell not loaded yet: we cannot tell empty from painted, so defer.
  if (color < 0) {
    return { x, y, isEmpty: false, authorState: "loading", authorLogin: null, avatarUrl: null, ts: null, color };
  }

  const isEmpty = color === EMPTY_COLOR;
  if (isEmpty) {
    // Never posed → coordinates + "no author"; never an error path.
    return { x, y, isEmpty: true, authorState: "empty", authorLogin: null, avatarUrl: null, ts: null, color };
  }

  if (author === undefined) {
    return { x, y, isEmpty: false, authorState: "loading", authorLogin: null, avatarUrl: null, ts: null, color };
  }
  if (author === null) {
    return { x, y, isEmpty: false, authorState: "unknown", authorLogin: null, avatarUrl: null, ts: null, color };
  }
  // PixelOccupancy: login===null means anonymous placement.
  const authorState = author.login !== null ? "known" : "unknown";
  return {
    x, y, isEmpty: false,
    authorState,
    authorLogin: author.login,
    avatarUrl: author.avatarUrl,
    ts: author.ts,
    color,
  };
}
