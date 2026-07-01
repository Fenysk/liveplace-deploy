/**
 * Pixel-click moderation source (FEN-754, §8.2 gap G1) — the framework-agnostic
 * seam the {@link CanvasView} pixel-info panel calls to run the three inline mod
 * actions on the clicked cell, mirroring {@link PixelAuthorSource} /
 * {@link TierSource}: CanvasView stays Convex-free and unit-testable, the live
 * Convex wiring lives in {@link createLiveModerationSource} (CanvasViewLive).
 *
 * The three actions (all reserved to canvas owner / moderators server-side, and
 * gated in the UI by the separate `canModerate` flag):
 *   - S8.3 `deletePixel` — remove the clicked pixel from the canvas (the DB trace
 *     is kept; reveals what was underneath).
 *   - S8.4 `deleteGroup` — remove the whole simultaneous batch the clicked pixel's
 *     author posted in that burst (resolved server-side from the clicked
 *     coordinate — NOT a free marquee; gap G2).
 *   - S8.5 `banAuthor` — permanently blacklist the clicked pixel's author on this
 *     canvas and wipe their pixels.
 *
 * Every method resolves to a {@link ModResult} and never throws: a backend error
 * or an unresolved canvas degrades to `{ ok: false }` so the panel can show a
 * toast instead of crashing the click handler.
 */

/** Outcome of one moderation action. */
export interface ModResult {
  /** True when the backend accepted and dispatched the action. */
  ok: boolean;
  /** Cells the action removed (0 for a ban that wiped nothing, or a no-op). */
  cellsAffected: number;
  /**
   * Machine reason when the action did nothing useful: `"no_author"` (ban/group
   * target had no resolvable author), `"unavailable"` (no canvas / signed out),
   * or `"error"` (backend threw). Undefined on success.
   */
  detail?: "no_author" | "unavailable" | "error";
}

export interface ModerationSource {
  /** S8.3 — delete the single clicked pixel (keeps the DB trace). */
  deletePixel(x: number, y: number): Promise<ModResult>;
  /** S8.4 — erase the whole simultaneous batch the clicked pixel belongs to. */
  deleteGroup(x: number, y: number): Promise<ModResult>;
  /** S8.5 — ban the clicked pixel's author on this canvas (+ wipe their pixels). */
  banAuthor(x: number, y: number): Promise<ModResult>;
}

/**
 * Inert source used while CanvasView is mounted without a live Convex wiring
 * (default prop, anonymous viewers, tests). Every action is a no-op reporting
 * `unavailable` — but the panel never SHOWS these actions unless `canModerate`
 * is true, so this is only a safety floor.
 */
export const inertModerationSource: ModerationSource = {
  deletePixel: () => Promise.resolve({ ok: false, cellsAffected: 0, detail: "unavailable" }),
  deleteGroup: () => Promise.resolve({ ok: false, cellsAffected: 0, detail: "unavailable" }),
  banAuthor: () => Promise.resolve({ ok: false, cellsAffected: 0, detail: "unavailable" }),
};
