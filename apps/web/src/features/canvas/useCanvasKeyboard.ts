/**
 * Global keyboard shortcuts for the canvas viewer (G8 — FEN-616 / FEN-1888).
 *
 * Extracted from CanvasView.tsx (l.994–1086) so the keyboard wiring lives in an
 * isolated, testable unit.
 *
 * Responsibilities:
 *   - Creates and owns `spacePaintingRef` (continuous paint flag).
 *   - Binds document keydown / keyup and window blur to:
 *       Esc   → eyedropper exit → inspect close → draw cancel
 *       Space → continuous paint arm / release
 *       E     → eraser toggle
 *       I     → eyedropper toggle
 *       G     → grid toggle
 *   - Space preventDefault fires BEFORE the form-field guard so it works regardless
 *     of which element has focus (FEN-1888 / FEN-2014). Space also calls enterDrawMode
 *     when not yet in draw mode (FEN-1901 / FEN-2014).
 *   - I / E / G shortcuts work from any non-typing element, including buttons (FEN-2014).
 */
import { useRef, useEffect } from "react";
import type { CanvasRenderer } from "./renderer.js";
import { applySpaceKeyDown, releaseSpacePaint } from "./spaceHoldPaint.js";
import { escapeAction } from "./escapeAction.js";

interface UseCanvasKeyboardInput {
  eyedropperModeRef: React.MutableRefObject<boolean>;
  drawingRef: React.MutableRefObject<boolean>;
  hoverRef: React.MutableRefObject<{ x: number; y: number } | null>;
  rendererRef: React.MutableRefObject<CanvasRenderer | null>;
  inspect: { x: number; y: number } | null;
  closeInspect: () => void;
  cancel: () => void;
  stageCell: (x: number, y: number, opts?: { onlyAdd?: boolean }) => void;
  setErasing: React.Dispatch<React.SetStateAction<boolean>>;
  setEyedropperMode: React.Dispatch<React.SetStateAction<boolean>>;
  /** FEN-1901: enter draw mode when Space is pressed outside draw mode. */
  enterDrawMode: () => void;
  /** FEN-2038: coupled eyedropper↔draw toggle (I key and renderer hook). */
  toggleEyedropper: () => void;
}

export function useCanvasKeyboard({
  eyedropperModeRef,
  drawingRef,
  hoverRef,
  rendererRef,
  inspect,
  closeInspect,
  cancel,
  stageCell,
  setErasing,
  setEyedropperMode,
  enterDrawMode,
  toggleEyedropper,
}: UseCanvasKeyboardInput): { spacePaintingRef: React.MutableRefObject<boolean> } {
  // G8 (FEN-616): Space held = continuous paint. When true, onHover auto-stages
  // the cell under the cursor as long as gauge has capacity. Stored in a ref so
  // the bound-once onHover callback always reads the live value.
  const spacePaintingRef = useRef(false);

  // G8 (FEN-616): global keyboard shortcuts — E/I/G tool switches, Space for
  // continuous paint, Esc to close cheat-sheet, ? to toggle it.
  // Safety guard: skip when a text input has focus (AC5).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Skip OS-level combos (Ctrl/Cmd+anything).
      if (e.ctrlKey || e.metaKey) return;

      // Esc: priority chain — eyedropper mode → inspect panel → draw mode.
      // Checked BEFORE the form-field/button guard: Escape must close panels even
      // when a button inside the panel (e.g. .lp-panel-handle) holds focus (FEN-1767).
      // Cheat-sheet Escape is handled by BottomSheet's useFocusTrap (FEN-1749).
      // Gate/menu handlers call e.preventDefault() so skip when already handled.
      if (e.key === "Escape" && !e.defaultPrevented) {
        // FEN-1887: exit eyedropper mode first (highest priority before inspect/draw).
        if (eyedropperModeRef.current) {
          e.preventDefault();
          setEyedropperMode(false);
          return;
        }
        const action = escapeAction({ inspect, drawing: drawingRef.current });
        if (action === "closeInspect") {
          e.preventDefault();
          closeInspect();
        } else if (action === "cancel") {
          e.preventDefault();
          cancel();
        }
        return;
      }

      // AC1 (FEN-1780): prevent Space default BEFORE the button-focus guard below.
      // When a button inside the HUD sheet has focus, Space would otherwise activate
      // it on keyup (browser fires click) and close the sheet. Calling preventDefault
      // here — in the bubble phase — is enough to suppress that click.
      // FEN-1888: also arm continuous paint here. The renderer's onSpaceHold fires only
      // when the canvas element has focus; after entering draw mode via a button click the
      // focus lands on the panel handle, so Space never reached onSpaceHold. Arming
      // before any early-return means it works regardless of which element has focus.
      // FEN-1901: outside draw mode, Space enters draw mode (gauge-only or info-pixel).
      if (e.code === "Space") {
        e.preventDefault();
        if (!e.repeat && !drawingRef.current) {
          enterDrawMode();
          // Pre-arm continuous paint so that once draw mode activates (after the
          // async state update), the very next onHover call starts painting.
          // applyHoverSpacePaint guards on drawingRef.current, so no cell is
          // staged until draw mode is actually live. (FEN-2014)
          spacePaintingRef.current = true;
        } else {
          applySpaceKeyDown(e.repeat, { spacePaintingRef, drawingRef, hoverRef, stageCell });
        }
      }

      // Never intercept when typing in a form field or editable region.
      // NOTE: BUTTON is intentionally excluded from this guard — shortcuts (I, E, G)
      // must fire even when a button (e.g. PanelHandle) has focus. Space is already
      // handled above and prevented, so the button-activation risk is gone. (FEN-2014)
      const active = document.activeElement as HTMLElement | null;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable)
      ) return;
      if (e.defaultPrevented) return;

      switch (e.code) {
        case "KeyE":
          // Eraser toggle (when canvas NOT focused — renderer handles canvas-focus case).
          if (!e.repeat) { setErasing((prev) => !prev); }
          break;
        case "KeyI":
          if (!e.repeat) toggleEyedropper();
          break;
        case "KeyG":
          if (!e.repeat) { rendererRef.current?.toggleGrid(); }
          break;
        default:
          break;
      }
    };

    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === "Space") releaseSpacePaint({ spacePaintingRef });
    };

    // Reset drag-paint if the window loses focus while Space is held.
    const onWindowBlur = (): void => { releaseSpacePaint({ spacePaintingRef }); };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [inspect, closeInspect, cancel, stageCell, enterDrawMode, toggleEyedropper]);

  return { spacePaintingRef };
}
