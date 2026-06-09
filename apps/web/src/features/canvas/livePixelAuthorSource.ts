/**
 * Live {@link PixelAuthorSource} bridge (FEN-297) — wires the pixel-info panel's
 * "placed by" line to the viewer-facing Convex query `canvases:pixelAuthor`
 * (exposed by Dev Backend in FEN-296). Until that query landed the panel ran on
 * {@link inertPixelAuthorSource} (always `null` → "author unavailable"); this is
 * the one-line-of-real-data wire-up the FEN-249 QA flagged.
 *
 * Pure (no React, no Convex import): the query and the live canvas id are
 * injected, mirroring {@link createLiveTierSource}. That keeps CanvasView/the
 * panel framework-agnostic and lets node:test drive the mapping directly — the
 * React hook in CanvasViewLive is the only untested shell.
 *
 * Contract honoured from FEN-296:
 *   - `pixelAuthor({ canvasId, x, y }) → { author: string | null }`;
 *   - `author` is the PUBLIC Twitch login of the current top-of-stack pixel, or
 *     `null` when the cell was never posed / erased / anonymous / no profile.
 * The panel maps a resolved login → `canvas.pixelInfo.authorKnown` and `null` →
 * `authorUnknown` ("Placed anonymously", FEN-332), so we map a falsy login to `null`.
 * A query failure (or no canvas resolved yet) degrades to `null` exactly like the
 * inert source — the panel never shows an error for attribution.
 */
import type { PixelAuthor, PixelAuthorSource } from "./pixelInfo.js";

/** Result shape of the viewer-facing `canvases:pixelAuthor` query (FEN-296). */
export interface PixelAuthorResult {
  /** Public Twitch login of the top-of-stack placer, or `null` (none/anon). */
  author: string | null;
}

/** Bound one-shot Convex query (`canvases:pixelAuthor`). */
export type PixelAuthorQueryFn = (args: {
  canvasId: string;
  x: number;
  y: number;
}) => Promise<PixelAuthorResult>;

export interface LivePixelAuthorSourceDeps {
  /** Live current canvas id, or `null` until the slug resolves (anonymous OK). */
  getCanvasId: () => string | null;
  /** Bound Convex one-shot query for `canvases:pixelAuthor`. */
  query: PixelAuthorQueryFn;
}

/**
 * Builds a {@link PixelAuthorSource} backed by the live `canvases:pixelAuthor`
 * query. Returns `null` (panel → "author unavailable") when no canvas is resolved
 * yet or the backend reports no public author; swallows query errors to `null` so
 * a transient backend hiccup degrades to the inert behaviour instead of throwing
 * into the click handler.
 */
export function createLivePixelAuthorSource(
  deps: LivePixelAuthorSourceDeps,
): PixelAuthorSource {
  return {
    async authorAt(x: number, y: number): Promise<PixelAuthor | null> {
      const canvasId = deps.getCanvasId();
      if (canvasId === null) return null;
      try {
        const res = await deps.query({ canvasId, x, y });
        return res.author ? { login: res.author } : null;
      } catch {
        return null;
      }
    },
  };
}
