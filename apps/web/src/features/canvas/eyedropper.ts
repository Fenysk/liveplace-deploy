/**
 * Pure helper for the eyedropper one-shot pick (S3 — FEN-1732).
 * Returns the palette index if the cell has a painted pixel (> 0), null otherwise.
 */
export function eyedropperPick(
  cell: { x: number; y: number } | null,
  colorAt: (x: number, y: number) => number,
): number | null {
  if (!cell) return null;
  const c = colorAt(cell.x, cell.y);
  return c > 0 ? c : null;
}

/**
 * Coupling logic for eyedropper↔draw toggle (FEN-2038).
 * Extracted as a pure function for unit-testability.
 *
 *  OFF → ON : activate eyedropper; enter draw mode if not already drawing;
 *             ensure palette panel is visible.
 *  ON  → OFF: deactivate eyedropper only — never touches drawing mode (A2).
 */
export function applyEyedropperToggle(
  isOn: boolean,
  drawing: boolean,
  actions: {
    setEyedropperMode: (v: boolean) => void;
    enterDrawMode: () => void;
    openPanel: () => void;
  },
): void {
  if (isOn) {
    actions.setEyedropperMode(false);
  } else {
    actions.setEyedropperMode(true);
    if (!drawing) actions.enterDrawMode();
    actions.openPanel();
  }
}
