/**
 * Batch-selection controller (FEN-113) — the framework-agnostic core of the
 * "sélection multiple → validation" pose model. It holds the user's *staged*
 * batch (cells they intend to paint/erase but have NOT committed yet), enforces
 * the gauge ceiling (k/N), and supports the toggle / recolor / erase gestures.
 *
 * Why a standalone controller (no React, no canvas): the batch state machine —
 * tap-to-add, tap-to-toggle-off, tap-to-recolor, hard cap at the available
 * gauge, lock-but-keep when the canvas becomes un-poseable — is the genuine
 * content of this issue and is the Definition-of-Done unit-tested surface
 * (`selection.test.ts`). The renderer draws the preview overlay from
 * {@link BatchSelection.entries} and the React layer drives the gestures; the
 * actual COMMIT reuses the FROZEN per-`cid` reconciliation already in
 * {@link OptimisticPlacement} (one `place{cid}` per cell, partial refusal
 * handled case-by-case), so this module mints no wire messages itself.
 *
 * Relation to the gauge (D1): the cap N is the number of charges currently
 * available. Adding a NEW cell beyond N is refused locally (hard cap, feedback);
 * recoloring or deselecting an already-staged cell never grows the count, so it
 * is always allowed. The server gauge stays authoritative — if the cap is stale
 * at commit time, the per-`cid` error path rolls the surplus cells back.
 *
 * Staging is independent of the live board, so a delta repainting a staged
 * cell's BASE colour before commit is a no-op here (LWW is resolved server-side
 * at commit); the preview overlay simply sits on top of whatever the base shows.
 */

/** Palette index of the empty/default cell — an erase stages this colour. */
export const EMPTY_COLOR = 0;

/** A single staged cell. `color === EMPTY_COLOR` is an erase. */
export interface SelectionEntry {
  x: number;
  y: number;
  /** Palette index to commit for this cell (EMPTY_COLOR = erase). */
  color: number;
}

/** Outcome of an {@link BatchSelection.apply} gesture (drives UI feedback). */
export type ApplyResult =
  /** Cell newly staged. */
  | { kind: "added"; entry: SelectionEntry }
  /** Already-staged cell repainted with a different colour (count unchanged). */
  | { kind: "recolored"; entry: SelectionEntry }
  /** Already-staged cell tapped again with the same tool → removed (toggle off). */
  | { kind: "removed"; x: number; y: number }
  /** Refused: the staged count is already at the gauge ceiling (hard cap). */
  | { kind: "cap"; cap: number }
  /** Refused: the canvas is locked (frozen / ended / archived / banned). */
  | { kind: "locked" };

const cellKey = (x: number, y: number): string => `${x},${y}`;

/**
 * The staged batch. Insertion-ordered (Map) so the preview and the eventual
 * commit replay cells in the order the user added them.
 */
export class BatchSelection {
  /** Staged cells keyed by "x,y", in insertion order. */
  private readonly cells = new Map<string, SelectionEntry>();
  /** Available gauge charges — the hard ceiling N for NEW cells. */
  private cap: number;
  /** When locked, no new cells are staged and commit is blocked (batch kept). */
  private locked = false;

  constructor(cap = 0) {
    this.cap = Math.max(0, Math.floor(cap));
  }

  /**
   * Apply the current tool to a cell:
   *   - not staged                  → add (refused if at cap or locked),
   *   - staged with the same colour → remove (toggle off),
   *   - staged with another colour  → recolor (no count change).
   * `color` is the tool's palette index, or {@link EMPTY_COLOR} for the eraser.
   */
  apply(x: number, y: number, color: number): ApplyResult {
    const key = cellKey(x, y);
    const existing = this.cells.get(key);

    if (existing) {
      // Re-tapping with the SAME tool toggles the cell off; a different tool
      // recolors it. Neither grows the count, so neither is cap/lock gated
      // (removing can only help; recolor keeps you within an already-valid set).
      if (existing.color === color) {
        this.cells.delete(key);
        return { kind: "removed", x, y };
      }
      existing.color = color;
      return { kind: "recolored", entry: { ...existing } };
    }

    // A brand-new cell. Locked canvas refuses; full batch refuses (hard cap).
    if (this.locked) return { kind: "locked" };
    if (this.cells.size >= this.cap) return { kind: "cap", cap: this.cap };

    const entry: SelectionEntry = { x, y, color };
    this.cells.set(key, entry);
    return { kind: "added", entry: { ...entry } };
  }

  /** Remove a staged cell if present; returns whether anything changed. */
  remove(x: number, y: number): boolean {
    return this.cells.delete(cellKey(x, y));
  }

  /** Empty the batch (Annuler / commit). */
  clear(): void {
    this.cells.clear();
  }

  /** Is this cell currently staged? */
  has(x: number, y: number): boolean {
    return this.cells.has(cellKey(x, y));
  }

  /** Staged colour at a cell, or undefined if not staged. */
  colorAt(x: number, y: number): number | undefined {
    return this.cells.get(cellKey(x, y))?.color;
  }

  /** Staged cells, insertion-ordered, as fresh copies (for the preview overlay). */
  entries(): SelectionEntry[] {
    return [...this.cells.values()].map((e) => ({ ...e }));
  }

  /** Number of staged cells (the k in k/N). */
  get count(): number {
    return this.cells.size;
  }

  /** The gauge ceiling N (available charges). */
  get capacity(): number {
    return this.cap;
  }

  /** True once the batch holds at least one cell (enables Valider). */
  get isEmpty(): boolean {
    return this.cells.size === 0;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  /** True if at least one more NEW cell can be staged right now. */
  get canAddMore(): boolean {
    return !this.locked && this.cells.size < this.cap;
  }

  /**
   * Update the gauge ceiling N (charges recharged, claimed, or spent). Existing
   * staged cells are NEVER trimmed — a shrinking cap just stops NEW adds and the
   * server's per-`cid` gauge check rolls back any surplus at commit (partial
   * refusal). A growing cap (e.g. a claimed tier, Lot D) immediately allows more.
   */
  setCapacity(cap: number): void {
    this.cap = Math.max(0, Math.floor(cap));
  }

  /**
   * Lock / unlock the batch for a blocking canvas state (frozen, ended,
   * archived, banned — Lot E refines the taxonomy). Locking KEEPS the staged
   * cells so the user does not lose work; it only refuses new adds and commit.
   */
  setLocked(locked: boolean): void {
    this.locked = locked;
  }

  /**
   * Atomically read the staged cells for commit AND clear the batch. The caller
   * feeds each entry to {@link OptimisticPlacement.place} (one `place{cid}` per
   * cell) so reconciliation/partial-refusal is handled per `cid`. Returns []
   * (and stays a no-op) when locked or empty.
   */
  take(): SelectionEntry[] {
    if (this.locked || this.cells.size === 0) return [];
    const out = this.entries();
    this.cells.clear();
    return out;
  }
}
