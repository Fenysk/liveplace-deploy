/**
 * Pure decision function for global Escape key handling (S2 — FEN-1731).
 * Priority chain: close inspect panel → cancel draw mode.
 * Cheat-sheet Escape is handled by BottomSheet's useFocusTrap (FEN-1749).
 */

export type EscapeActionResult = "closeInspect" | "cancel" | null;

export interface EscapeActionInput {
  inspect: { x: number; y: number } | null;
  drawing: boolean;
}

export function escapeAction({ inspect, drawing }: EscapeActionInput): EscapeActionResult {
  if (inspect !== null) return "closeInspect";
  if (drawing) return "cancel";
  return null;
}
