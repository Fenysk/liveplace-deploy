/**
 * Live {@link PixelAuthorSource} bridge (FEN-297 / FEN-755) — wires the
 * pixel-info panel to the viewer-facing Convex query `canvases:pixelAuthor`.
 * The query now returns avatar + placement timestamp alongside the login, so the
 * panel can display the full §4.2 occupancy encadré without extra round-trips.
 *
 * Pure (no React, no Convex import): the query and the live canvas id are
 * injected, mirroring {@link createLiveTierSource}. That keeps CanvasView/the
 * panel framework-agnostic and lets node:test drive the mapping directly — the
 * React hook in CanvasViewLive is the only untested shell.
 *
 * Contract (FEN-755):
 *   - `pixelAuthor({ canvasId, x, y }) → { author, avatarUrl, ts }`;
 *   - `ts === null` signals an empty / erased cell → no occupancy to show;
 *   - `ts !== null, author === null` → anonymous placement;
 *   - `ts !== null, author !== null` → known placer with optional avatar.
 * A query failure (or no canvas resolved yet) degrades to `null` so a transient
 * backend hiccup behaves like the inert source — the panel never throws.
 */
import type { Id } from "@canvas/convex/dataModel";
import type { PixelOccupancy, PixelAuthorSource } from "./pixelInfo.js";

/** Result shape of the viewer-facing `canvases:pixelAuthor` query (FEN-755). */
export interface PixelAuthorResult {
  /** Public Twitch login of the top-of-stack placer, or `null` (none/anon). */
  author: string | null;
  /** Twitch profile picture URL, or `null` (anonymous / missing profile). */
  avatarUrl: string | null;
  /** Epoch ms of the placement; `null` when the cell is empty / erased. */
  ts: number | null;
}

/** Bound one-shot Convex query (`canvases:pixelAuthor`). */
export type PixelAuthorQueryFn = (args: {
  canvasId: Id<"canvases">;
  x: number;
  y: number;
}) => Promise<PixelAuthorResult>;

export interface LivePixelAuthorSourceDeps {
  /** Live current canvas id, or `null` until the slug resolves (anonymous OK). */
  getCanvasId: () => Id<"canvases"> | null;
  /** Bound Convex one-shot query for `canvases:pixelAuthor`. */
  query: PixelAuthorQueryFn;
}

/**
 * Builds a {@link PixelAuthorSource} backed by the live `canvases:pixelAuthor`
 * query (FEN-755). Returns `null` when no canvas is resolved yet or the cell is
 * empty (`ts === null`). Returns a {@link PixelOccupancy} for any painted cell —
 * `login` may be `null` for anonymous placements. Swallows query errors to `null`
 * so a transient backend hiccup degrades to the inert behaviour instead of
 * throwing into the click handler.
 */
export function createLivePixelAuthorSource(
  deps: LivePixelAuthorSourceDeps,
): PixelAuthorSource {
  return {
    async authorAt(x: number, y: number): Promise<PixelOccupancy | null> {
      const canvasId = deps.getCanvasId();
      if (canvasId === null) return null;
      try {
        const res = await deps.query({ canvasId, x, y });
        // ts === null signals an empty / erased cell → no occupancy to show.
        if (res.ts === null) return null;
        return { login: res.author, avatarUrl: res.avatarUrl, ts: res.ts };
      } catch {
        return null;
      }
    },
  };
}
