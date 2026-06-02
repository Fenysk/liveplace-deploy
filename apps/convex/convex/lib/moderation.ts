/**
 * Pure moderation rules (F8 / FEN-52) — the "brain" that decides *which cells
 * and colours* a moderation action writes to the canvas. No Convex/Redis I/O
 * here so it is unit-testable under `node --test` with native TS type-stripping
 * (see ./moderation.test.ts); the thin transactional wrappers live in
 * ../moderation.ts.
 *
 * The hot-path engine (`moderate.lua`, FEN-19) is dumb on purpose: Convex hands
 * it a flat list of `{x,y,color}` cells and it overwrites them atomically in one
 * `bulkDelta`. Colour `0` erases. So every helper below reduces the durable
 * placement history (`placements`, the FEN-47 append-log drained from Redis)
 * into that flat cell list:
 *
 *  - F8.1 ban+wipe   → every cell whose CURRENT top pixel is the banned author's,
 *                      rewritten to the colour that was underneath it.
 *  - F8.2 delete     → the targeted cells, rewritten to the colour underneath.
 *  - F8.3 restore    → the targeted cells, rebuilt from the durable log (undo an
 *                      erroneous moderation by re-asserting what history says is
 *                      there).
 *
 * "What was underneath" is reconstructed from the append-log: placements at a
 * cell form a version-ordered stack; the top is what shows live, the entry below
 * it is what a delete reveals. This is why a forced Redis→Convex flush must run
 * before a mass action (issue scope §7) — the log has to reflect pre-action
 * state for the stack to be accurate.
 */

/** One drained placement from the durable `placements` log (FEN-47). */
export interface PlacementRow {
  x: number;
  y: number;
  /** Palette index written; 0 = eraser. */
  color: number;
  /** Canvas-monotonic global write sequence. */
  version: number;
  /** Better Auth user id; absent for anonymous placements. */
  userId?: string;
}

/** A cell the moderation action overwrites — matches `ModerationCell` in redis-scripts. */
export interface ModerationCell {
  x: number;
  y: number;
  color: number;
}

/** A targeted cell coordinate for delete/restore. */
export interface CellRef {
  x: number;
  y: number;
}

const cellKey = (x: number, y: number): string => `${x},${y}`;

/**
 * Group placements by cell, each group sorted ascending by `version` so the last
 * element is the live top-of-stack. Input order is not assumed.
 */
export function groupByCell(placements: ReadonlyArray<PlacementRow>): Map<string, PlacementRow[]> {
  const groups = new Map<string, PlacementRow[]>();
  for (const p of placements) {
    const key = cellKey(p.x, p.y);
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  for (const g of groups.values()) g.sort((a, b) => a.version - b.version);
  return groups;
}

/** Colour revealed when the top pixel of a (version-sorted) stack is removed. */
function underColor(stack: ReadonlyArray<PlacementRow>): number {
  // stack[len-1] is the top being removed; the entry below it is what shows.
  return stack.length >= 2 ? stack[stack.length - 2].color : 0;
}

/**
 * F8.1 — ban + wipe. Every cell whose CURRENT top pixel was placed by
 * `targetUserId` is rewritten to the colour underneath (0 if nothing was there).
 * Cells the user painted but were later painted over by someone else are left
 * untouched — they no longer show the banned author's work. Already-erased tops
 * (colour 0) are skipped: there is nothing to wipe.
 *
 * Output is sorted by (y, x) for deterministic batches and tests.
 */
export function computeWipeCells(
  placements: ReadonlyArray<PlacementRow>,
  targetUserId: string,
): ModerationCell[] {
  const cells: ModerationCell[] = [];
  for (const stack of groupByCell(placements).values()) {
    const top = stack[stack.length - 1];
    if (top.userId !== targetUserId) continue;
    if (top.color === 0) continue;
    cells.push({ x: top.x, y: top.y, color: underColor(stack) });
  }
  return sortCells(cells);
}

/**
 * F8.2 — delete a single cell or a group. Each targeted cell is rewritten to the
 * colour underneath its current top (revealing what was there before). A cell
 * with no recorded placement, or whose top is already empty, resolves to 0
 * (erase / no-op). Duplicate targets are de-duplicated.
 */
export function computeDeleteCells(
  placements: ReadonlyArray<PlacementRow>,
  targets: ReadonlyArray<CellRef>,
): ModerationCell[] {
  const groups = groupByCell(placements);
  const seen = new Set<string>();
  const cells: ModerationCell[] = [];
  for (const t of targets) {
    const key = cellKey(t.x, t.y);
    if (seen.has(key)) continue;
    seen.add(key);
    const stack = groups.get(key);
    cells.push({ x: t.x, y: t.y, color: stack ? underColor(stack) : 0 });
  }
  return sortCells(cells);
}

/**
 * F8.3 — restore. Rebuild the targeted cells from the durable placement log:
 * each cell is rewritten to the colour of its current top-of-stack in history
 * (0 if the log has nothing there). This undoes an erroneous wipe/delete by
 * re-asserting what the durable record says is on the canvas, independent of the
 * live (possibly moderated) Redis bitmap. Duplicate targets are de-duplicated.
 */
export function computeRestoreCells(
  placements: ReadonlyArray<PlacementRow>,
  targets: ReadonlyArray<CellRef>,
): ModerationCell[] {
  const groups = groupByCell(placements);
  const seen = new Set<string>();
  const cells: ModerationCell[] = [];
  for (const t of targets) {
    const key = cellKey(t.x, t.y);
    if (seen.has(key)) continue;
    seen.add(key);
    const stack = groups.get(key);
    const top = stack && stack.length > 0 ? stack[stack.length - 1].color : 0;
    cells.push({ x: t.x, y: t.y, color: top });
  }
  return sortCells(cells);
}

/** Deterministic ordering: row-major (y, then x). */
export function sortCells(cells: ModerationCell[]): ModerationCell[] {
  return cells.sort((a, b) => (a.y - b.y) || (a.x - b.x));
}
