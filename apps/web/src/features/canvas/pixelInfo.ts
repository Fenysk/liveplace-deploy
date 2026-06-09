/**
 * Pixel-info view-model (FEN-249) — the framework-agnostic core of the refonte
 * "clic → infos → Dessiner → Confirmer" pose flow (board request FEN-248).
 *
 * Why a standalone module (no React, no canvas): the genuine content of the
 * issue is the *derivation* — given a clicked cell's coordinates, its palette
 * colour, and the (possibly still-resolving, possibly absent) attribution, decide
 * which author state the info panel shows. The four states map directly to the
 * acceptance criteria:
 *   - a never-posed (empty) cell shows coordinates + "no author", NOT an error;
 *   - a painted cell shows its placer once the attribution resolves;
 *   - while the lookup is in flight the panel says "loading";
 *   - if the lookup resolves to nothing (anonymous / not yet wired backend) it
 *     says "unavailable" rather than fabricating a pseudo.
 * This pure reducer is the Definition-of-Done unit-tested surface
 * ({@link derivePixelInfo}, `pixelInfo.test.ts`). The React layer maps the
 * returned {@link PixelAuthorState} to i18n keys and renders the panel; clicking
 * never stages a cell (that only starts after "Dessiner").
 *
 * Backend seam: per-coordinate attribution ("who placed this pixel") is NOT on
 * the FROZEN WS protocol (snapshot/delta carry colour only) and the one Convex
 * query that resolves it (`moderation.authorAt`) is moderator-gated. A
 * viewer-facing query is a backend dependency (flagged on FEN-249). Until it
 * lands we inject {@link inertPixelAuthorSource}, which resolves to `null` so the
 * panel honestly shows "author unavailable" — no client-side guessing.
 */

/**
 * Palette index of the empty/default cell (idx 0 = white/empty in the FROZEN
 * `@canvas/protocol` PALETTE). Kept local to this pure module so it carries no
 * runtime import (type-stripping cannot resolve a sibling `.js` value import);
 * it intentionally mirrors `selection.EMPTY_COLOR`.
 */
const EMPTY_COLOR = 0;

/** The last (top-of-stack) placer of a cell, as the panel needs to show it. */
export interface PixelAuthor {
  /** Display login / pseudo of the placer. */
  login: string;
}

/**
 * Resolves the author of the top pixel at a cell. Returns `null` when the cell
 * has no attributable author (empty, anonymous, or — until the backend hook
 * lands — simply not exposed to viewers yet). Async because the real
 * implementation will be a Convex query; the inert default resolves immediately.
 */
export interface PixelAuthorSource {
  authorAt(x: number, y: number): Promise<PixelAuthor | null>;
}

/**
 * Inert source used until the viewer-facing backend attribution query lands
 * (FEN-249 backend dependency, owned by Dev Backend). Always resolves to `null`
 * → the panel shows "author unavailable" rather than fabricating data.
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
 *   - `unknown` — the lookup resolved to nothing (anonymous / backend not wired).
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
}

/**
 * Derive the info-panel view-model for a clicked cell.
 *
 * @param color Palette index at the cell: {@link EMPTY_COLOR} (0) = empty,
 *   a positive index = a painted pixel, a negative value = canvas not loaded.
 * @param author The resolved author, `null` when there is none, or `undefined`
 *   while the lookup is still in flight.
 */
export function derivePixelInfo(input: {
  x: number;
  y: number;
  color: number;
  author: PixelAuthor | null | undefined;
}): PixelInfoVM {
  const { x, y, color, author } = input;

  // Canvas/cell not loaded yet: we cannot tell empty from painted, so defer.
  if (color < 0) {
    return { x, y, isEmpty: false, authorState: "loading", authorLogin: null };
  }

  const isEmpty = color === EMPTY_COLOR;
  if (isEmpty) {
    // Never posed → coordinates + "no author"; never an error path.
    return { x, y, isEmpty: true, authorState: "empty", authorLogin: null };
  }

  if (author === undefined) {
    return { x, y, isEmpty: false, authorState: "loading", authorLogin: null };
  }
  if (author === null) {
    return { x, y, isEmpty: false, authorState: "unknown", authorLogin: null };
  }
  return { x, y, isEmpty: false, authorState: "known", authorLogin: author.login };
}
