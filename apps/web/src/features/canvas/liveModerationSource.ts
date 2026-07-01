/**
 * Live {@link ModerationSource} bridge (FEN-754, §8.2) — wires the pixel-click
 * moderation panel to the existing F8 Convex moderation layer (FEN-52):
 *   - S8.3 `deletePixel` → `moderation.deletePixels({ canvasId, cells:[{x,y}] })`
 *   - S8.4 `deleteGroup` → `moderation.deleteGroupAt({ canvasId, x, y })` (G2)
 *   - S8.5 `banAuthor`   → `moderation.authorAt({ canvasId, x, y })` to resolve
 *     the target, then `moderation.banAndWipe({ canvasId, targetUserId })`.
 *
 * Pure (no React, no Convex import): the actions and the live canvas id are
 * injected, mirroring {@link createLivePixelAuthorSource}. That keeps CanvasView /
 * the panel framework-agnostic and lets node:test drive the mapping. Every method
 * swallows errors to `{ ok: false }` so a transient backend hiccup degrades to a
 * panel toast instead of throwing into the click handler.
 */
import type { ModResult, ModerationSource } from "./moderationSource.js";

/** Shape of the F8 cell-rewriting action result (`deletePixels` / `deleteGroupAt`). */
export interface CellActionResult {
  cellsAffected: number;
  dispatched: boolean;
  detail: string;
}

/** Resolved ban target (`moderation.authorAt`): the visible author, or `null`. */
export interface AuthorAtResult {
  userId: string;
  displayName?: string;
}

export interface LiveModerationSourceDeps {
  /** Live current canvas id, or `null` until the slug resolves. */
  getCanvasId: () => string | null;
  /** Bound `moderation.deletePixels` action. */
  deletePixels: (args: {
    canvasId: string;
    cells: Array<{ x: number; y: number }>;
  }) => Promise<CellActionResult>;
  /** Bound `moderation.deleteGroupAt` action (S8.4 / G2). */
  deleteGroupAt: (args: { canvasId: string; x: number; y: number }) => Promise<CellActionResult>;
  /** Bound `moderation.authorAt` query — resolves the ban target at a cell. */
  authorAt: (args: { canvasId: string; x: number; y: number }) => Promise<AuthorAtResult | null>;
  /** Bound `moderation.banAndWipe` action (S8.5). */
  banAndWipe: (args: { canvasId: string; targetUserId: string }) => Promise<CellActionResult>;
}

const UNAVAILABLE: ModResult = { ok: false, cellsAffected: 0, detail: "unavailable" };

export function createLiveModerationSource(deps: LiveModerationSourceDeps): ModerationSource {
  return {
    async deletePixel(x, y): Promise<ModResult> {
      const canvasId = deps.getCanvasId();
      if (canvasId === null) return UNAVAILABLE;
      try {
        const r = await deps.deletePixels({ canvasId, cells: [{ x, y }] });
        return { ok: r.dispatched, cellsAffected: r.cellsAffected };
      } catch {
        return { ok: false, cellsAffected: 0, detail: "error" };
      }
    },

    async deleteGroup(x, y): Promise<ModResult> {
      const canvasId = deps.getCanvasId();
      if (canvasId === null) return UNAVAILABLE;
      try {
        const r = await deps.deleteGroupAt({ canvasId, x, y });
        return { ok: r.dispatched, cellsAffected: r.cellsAffected };
      } catch {
        return { ok: false, cellsAffected: 0, detail: "error" };
      }
    },

    async banAuthor(x, y): Promise<ModResult> {
      const canvasId = deps.getCanvasId();
      if (canvasId === null) return UNAVAILABLE;
      try {
        const author = await deps.authorAt({ canvasId, x, y });
        if (!author) return { ok: false, cellsAffected: 0, detail: "no_author" };
        const r = await deps.banAndWipe({ canvasId, targetUserId: author.userId });
        return { ok: r.dispatched, cellsAffected: r.cellsAffected };
      } catch {
        return { ok: false, cellsAffected: 0, detail: "error" };
      }
    },
  };
}
