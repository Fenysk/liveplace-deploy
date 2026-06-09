/**
 * Pure moderation rules (F8 / FEN-52) — the "brain" that decides *which cells
 * and colours* a moderation action writes. No Convex/Redis I/O so it is
 * unit-testable under `node --test` with native TS type-stripping (see
 * ./moderation.test.ts); transactional wrappers live in ../moderation.ts.
 *
 * Ratified model — docs/contracts/moderation.md (FE sign-off 2026-06-02). There
 * is NO dedicated per-cell event log: "what was underneath" is derived from the
 * existing `placements` append-log (FEN-47) via its `by_canvas_cell` index. Each
 * helper folds that log into removal plans the caller turns into a single
 * `bulkDelta` for the hot-path engine (`moderate.lua`, FEN-19); colour `0`
 * erases.
 *
 *  - F8.1 ban+wipe  → every cell whose CURRENT top pixel is the banned author's,
 *                     rewritten to the most recent placement NOT authored by them
 *                     (skipping a run of their own stacked pixels), 0 if none.
 *  - F8.2 delete    → the targeted cells, rewritten to the immediately previous
 *                     placement underneath the current top.
 *  - F8.3 restore   → re-applies the removed colour; driven by the stored
 *                     `pixelModeration` rows (a DB lookup), not from history here.
 *
 * A forced Redis→Convex flush must run before a mass action (issue scope §7) so
 * the log reflects pre-action state and the stack is accurate.
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

/** A targeted cell coordinate for delete. */
export interface CellRef {
  x: number;
  y: number;
}

/**
 * A planned removal of one cell's top pixel: what is being taken down and the
 * colour now shown underneath. Maps 1:1 onto a `pixelModeration` row plus one
 * `{x,y,color: underneathColor}` cell in the dispatched bulkDelta.
 */
export interface RemovalPlan {
  x: number;
  y: number;
  removedUserId?: string;
  removedColor: number;
  removedVersion: number;
  underneathColor: number;
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

/**
 * F8.1 — ban + wipe. For every cell whose CURRENT top pixel was placed by
 * `targetUserId`, plan a removal revealing the most recent placement underneath
 * that the banned user did NOT author (a banned user may have stacked several of
 * their own pixels; all of them come down). Background 0 if nothing else is
 * there. Cells the user no longer tops, or whose top is already erased, are
 * skipped. Output is sorted row-major (y, x) for deterministic batches.
 */
export function planWipe(
  placements: ReadonlyArray<PlacementRow>,
  targetUserId: string,
): RemovalPlan[] {
  const plans: RemovalPlan[] = [];
  for (const stack of groupByCell(placements).values()) {
    const top = stack[stack.length - 1];
    if (!top) continue; // groupByCell only yields non-empty stacks; satisfies noUncheckedIndexedAccess
    if (top.userId !== targetUserId) continue;
    if (top.color === 0) continue;
    // Walk down past any run of the banned user's own pixels to what shows next.
    let underneath = 0;
    for (let i = stack.length - 2; i >= 0; i--) {
      const below = stack[i];
      if (below && below.userId !== targetUserId) {
        underneath = below.color;
        break;
      }
    }
    plans.push({
      x: top.x,
      y: top.y,
      removedUserId: top.userId,
      removedColor: top.color,
      removedVersion: top.version,
      underneathColor: underneath,
    });
  }
  return sortPlans(plans);
}

/**
 * F8.2 — delete a single cell or a group. Each targeted cell with a live top
 * pixel is planned for removal, revealing the immediately previous placement
 * underneath (0 if none). Cells with no placement, or an already-erased top, are
 * skipped (nothing to delete). Duplicate targets are de-duplicated.
 */
export function planDelete(
  placements: ReadonlyArray<PlacementRow>,
  targets: ReadonlyArray<CellRef>,
): RemovalPlan[] {
  const groups = groupByCell(placements);
  const seen = new Set<string>();
  const plans: RemovalPlan[] = [];
  for (const t of targets) {
    const key = cellKey(t.x, t.y);
    if (seen.has(key)) continue;
    seen.add(key);
    const stack = groups.get(key);
    if (!stack || stack.length === 0) continue;
    const top = stack[stack.length - 1];
    if (!top) continue; // length checked above; satisfies noUncheckedIndexedAccess
    if (top.color === 0) continue;
    const below = stack[stack.length - 2];
    plans.push({
      x: top.x,
      y: top.y,
      removedUserId: top.userId,
      removedColor: top.color,
      removedVersion: top.version,
      underneathColor: below ? below.color : 0,
    });
  }
  return sortPlans(plans);
}

/** Map removal plans onto the bulkDelta cells (write the underneath colour). */
export function removalCells(plans: ReadonlyArray<RemovalPlan>): ModerationCell[] {
  return plans.map((p) => ({ x: p.x, y: p.y, color: p.underneathColor }));
}

/**
 * Crisis ban surface (FEN-159 / FEN-157 §2): resolve a *ban target* from the
 * top-of-stack placement at a cell. Returns the visible author, or `null` when
 * there is no ban target there — empty cell, an erased top (`color === 0`, shows
 * nothing), or an anonymous top (no `userId`, nobody to ban). This deliberately
 * mirrors `planWipe`'s skip rules (erased / non-author tops are skipped), so the
 * cell `authorAt` reports is exactly a cell the ensuing wipe would act on; we
 * never hand a mod a target whose pixel isn't actually showing. The caller feeds
 * the single indexed top row (highest `version` via `by_canvas_cell`).
 */
export function authorOfTop(
  top: PlacementRow | null | undefined,
): { userId: string; color: number; version: number } | null {
  if (!top || top.color === 0 || top.userId === undefined) return null;
  return { userId: top.userId, color: top.color, version: top.version };
}

/** Deterministic ordering: row-major (y, then x). */
export function sortPlans<T extends { x: number; y: number }>(plans: T[]): T[] {
  return plans.sort((a, b) => (a.y - b.y) || (a.x - b.x));
}
