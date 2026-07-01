/**
 * Pure helpers for the bottom-sheet handle visibility (FEN-1209 / FEN-1249 / FEN-1270).
 * Extracted so the logic can be unit-tested without rendering CanvasView.
 */

/**
 * Returns whether the panel handle should be mounted and `data-has-handle`
 * should be `"true"`.
 *
 * FEN-1270: handle is shown ONLY when an interactive mode is active (inspect or
 * drawing). In the default idle state the sheet stays visible at gauge-only
 * "peek" height with no handle and no drag-dismiss. The `panelOpen` parameter
 * was removed: the gauge is always visible so there is no "show the handle so
 * the user can tap to close" scenario anymore.
 *
 * `canModerate` is intentionally NOT a parameter: it is a permission that is
 * always `true` for owners/moderators, not a display-mode signal. Including it
 * was the root cause of FEN-1249 (handle always visible for the owner).
 */
export function computeShowHandle(
  inspect: { x: number; y: number } | null,
  drawing: boolean,
): boolean {
  return !!inspect || drawing;
}
