import React, { forwardRef } from "react";

export interface PanelHandleProps {
  /** Whether the associated sheet is currently open. */
  open: boolean;
  /** Called when the handle is clicked or keyboard-activated (Enter/Space/Arrows). */
  onToggle: () => void;
  /** Accessible label shown when the panel is open (for keyboard/SR users). */
  labelClose?: string;
  /** Accessible label shown when the panel is closed. */
  labelOpen?: string;
  /** Forwarded from BottomSheet for pointer-capture drag-dismiss. */
  onPointerDown?: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerMove?: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerUp?: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel?: (e: React.PointerEvent<HTMLButtonElement>) => void;
}

/**
 * Shared drag-and-keyboard panel handle (grip de R) — extracted from CanvasView.tsx.
 * FEN-1330/FEN-1336 S0: markup/tokens = R, role=separator, a11y clavier.
 *
 * Consumed by BottomSheet (which owns all drag state). Also re-exported from
 * ui/index.ts so CanvasView.tsx can import it directly once S3 is done.
 */
export const PanelHandle = forwardRef<HTMLButtonElement, PanelHandleProps>(
  function PanelHandle(
    {
      open,
      onToggle,
      labelClose = "Fermer le panneau",
      labelOpen = "Ouvrir le panneau",
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        role="separator"
        aria-label={open ? labelClose : labelOpen}
        aria-expanded={open}
        className="lp-panel-handle"
        onClick={onToggle}
        onKeyDown={(e) => {
          if (
            e.key === "Enter" ||
            e.key === " " ||
            e.key === "ArrowDown" ||
            e.key === "ArrowUp"
          ) {
            e.preventDefault();
            onToggle();
          }
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <span aria-hidden="true" className="lp-panel-handle-grip" />
      </button>
    );
  },
);
