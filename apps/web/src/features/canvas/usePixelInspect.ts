/**
 * Pixel-info inspect state + pixel-click moderation logic (FEN-249 / FEN-754).
 *
 * Extracted from CanvasView.tsx (l.806-909) so the inspect state machine, the
 * author-resolution race guard, and the mod-action callbacks live in an
 * isolated, testable unit.
 *
 * CanvasView retains:
 *   - `drawing` state (drawing mode is a sibling, not a sub-concern of inspect).
 *   - `selectionRef` / `setDrawing` → passed back via the `onStartDraw` callback.
 *   - `showToast` → injected as a parameter so this hook stays toast-type-agnostic.
 */
import { useState, useCallback, useEffect, useRef } from "react";
import type { CanvasRenderer } from "./renderer.js";
import type { PixelAuthorSource, PixelOccupancy } from "./pixelInfo.js";
import type { ModerationSource } from "./moderationSource.js";
import type { CanvasInteraction } from "./authGate.js";

/** Pixel-click moderation actions (FEN-754 §8.2: S8.4 / S8.5 — FEN-1962 removes S8.3). */
export type ModAction = "deleteGroup" | "ban";

export interface UsePixelInspectParams {
  pixelAuthorSourceRef: React.MutableRefObject<PixelAuthorSource>;
  moderationSourceRef: React.MutableRefObject<ModerationSource>;
  requireAccount: (i: CanvasInteraction) => boolean;
  openPanel: () => void;
  rendererRef: React.MutableRefObject<CanvasRenderer | null>;
  showToast: (f: {
    kind: string;
    messageKey: string;
    params?: Record<string, string | number>;
  }) => void;
  /** Whether the viewer is currently in draw mode (gates setInspectedCell). */
  drawing: boolean;
  /**
   * Called by `drawFromInspect` after closing the panel to transfer the
   * inspected cell into draw mode. CanvasView implements this as:
   *   setDrawing(true); hoverRef.current = cell; rendererRef.setOverlay(...)
   */
  onStartDraw: (cell: { x: number; y: number }) => void;
}

export interface UsePixelInspectResult {
  inspect: { x: number; y: number } | null;
  inspectAuthor: PixelOccupancy | null | undefined;
  modArmed: ModAction | null;
  setModArmed: React.Dispatch<React.SetStateAction<ModAction | null>>;
  modPending: boolean;
  closeInspect: () => void;
  openInspect: (x: number, y: number) => void;
  drawFromInspect: () => void;
  runModAction: (action: ModAction) => Promise<void>;
}

export function usePixelInspect({
  pixelAuthorSourceRef,
  moderationSourceRef,
  requireAccount,
  openPanel,
  rendererRef,
  showToast,
  drawing,
  onStartDraw,
}: UsePixelInspectParams): UsePixelInspectResult {
  // Pixel-info panel (FEN-249): the cell currently inspected, null when closed.
  const [inspect, setInspect] = useState<{ x: number; y: number } | null>(null);
  // Resolved occupancy: undefined while in-flight, null when empty/error.
  const [inspectAuthor, setInspectAuthor] = useState<PixelOccupancy | null | undefined>(undefined);
  // Monotonic token so a slow author lookup can't overwrite a newer inspection.
  const inspectReqRef = useRef(0);
  // Pixel-click moderation (FEN-754 §8.2).
  const [modArmed, setModArmed] = useState<ModAction | null>(null);
  const [modPending, setModPending] = useState(false);

  // Close the pixel-info panel (FEN-249). Bumping the request token also voids
  // any in-flight author lookup so its late result can't reopen stale state.
  const closeInspect = useCallback(() => {
    inspectReqRef.current += 1;
    setInspect(null);
  }, []);

  // Open the pixel-info panel for a clicked cell (FEN-249). Read-only: shows
  // coordinates + author without staging. FEN-797: always opens the bottom sheet.
  const openInspect = useCallback(
    (x: number, y: number) => {
      setInspect({ x, y });
      openPanel();
      const color = rendererRef.current?.colorAt(x, y) ?? -1;
      if (color <= 0) {
        inspectReqRef.current += 1;
        setInspectAuthor(null);
        return;
      }
      setInspectAuthor(undefined); // loading
      const req = (inspectReqRef.current += 1);
      Promise.resolve(pixelAuthorSourceRef.current.authorAt(x, y))
        .then((a) => {
          if (inspectReqRef.current === req) setInspectAuthor(a);
        })
        .catch(() => {
          if (inspectReqRef.current === req) setInspectAuthor(null);
        });
    },
    [openPanel, pixelAuthorSourceRef, rendererRef],
  );

  // FEN-390: keep the renderer's marching-ants frame in sync with the inspected
  // cell. Clear when the panel closes or when draw mode starts.
  useEffect(() => {
    rendererRef.current?.setInspectedCell(!drawing && inspect ? inspect : null);
  }, [inspect, drawing, rendererRef]);

  // "Dessiner": leave the info panel and enter draw mode. Account-gated (FEN-115).
  // D-A (spec §3 FEN-797): pre-aim the inspected cell via onStartDraw without
  // staging it — the user explicitly taps cells to stage in draw mode.
  const drawFromInspect = useCallback(() => {
    if (!inspect) return;
    if (!requireAccount("enter-draw")) return;
    const cell = inspect; // capture coordinates before closeInspect nulls inspect
    closeInspect();
    openPanel();
    onStartDraw(cell);
  }, [inspect, requireAccount, closeInspect, openPanel, onStartDraw]);

  // Moderation (FEN-754 §8.2): a newly inspected (or closed) cell disarms any
  // half-confirmed mod action so a confirm never carries over to another pixel.
  useEffect(() => {
    setModArmed(null);
    setModPending(false);
  }, [inspect]);

  // Run an armed pixel-click moderation action on the inspected cell.
  const runModAction = useCallback(
    async (action: ModAction): Promise<void> => {
      if (!inspect) return;
      const { x, y } = inspect;
      setModPending(true);
      const src = moderationSourceRef.current;
      const res =
        action === "deleteGroup" ? await src.deleteGroup(x, y) : await src.banAuthor(x, y);
      setModPending(false);
      setModArmed(null);
      if (res.ok) {
        showToast({
          kind: "success",
          messageKey: action === "deleteGroup" ? "canvas.mod.groupDeleted" : "canvas.mod.banned",
          params: { count: res.cellsAffected },
        });
        closeInspect();
      } else {
        showToast({
          kind: "rejected",
          messageKey:
            res.detail === "no_author" ? "canvas.mod.noAuthor" : "canvas.mod.failed",
        });
      }
    },
    [inspect, showToast, closeInspect, moderationSourceRef],
  );

  return {
    inspect,
    inspectAuthor,
    modArmed,
    setModArmed,
    modPending,
    closeInspect,
    openInspect,
    drawFromInspect,
    runModAction,
  };
}
