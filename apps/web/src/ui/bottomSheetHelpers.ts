/**
 * Pure logic helpers for BottomSheet (FEN-1330 / FEN-1336 S0).
 *
 * Extracted into a CSS-free module so unit tests can import without triggering
 * the CSS import in BottomSheet.tsx (Node.js does not load CSS modules).
 */

import type { SheetPresentation } from "./BottomSheet.js";

/** Résout le défaut de showHandle selon la présentation. */
export function resolveShowHandle(
  showHandle: boolean | undefined,
  presentation: SheetPresentation,
): boolean {
  if (showHandle !== undefined) return showHandle;
  return presentation === "modal";
}

/** Résout le défaut de dragDismiss (= showHandle résolu). */
export function resolveDragDismiss(
  dragDismiss: boolean | undefined,
  resolvedShowHandle: boolean,
): boolean {
  if (dragDismiss !== undefined) return dragDismiss;
  return resolvedShowHandle;
}

/**
 * Retourne true si le dy dépasse le seuil proportionnel (AC3 — pas de seuil px fixe).
 * dy        : déplacement vertical en px depuis le début du drag.
 * height    : hauteur totale de la sheet en px.
 * threshold : fraction [0, 1]. Défaut: 0.25 (= --dock-snap-ratio de R).
 */
export function shouldDismissOnDrag(
  dy: number,
  height: number,
  threshold = 0.25,
): boolean {
  return dy > threshold * height;
}
