import React, { useCallback, useRef, useState } from "react";
import "./bottomSheet.css";
import { PanelHandle } from "./PanelHandle.js";
import { useFocusTrap } from "./useFocusTrap.js";
import {
  resolveShowHandle,
  resolveDragDismiss,
  shouldDismissOnDrag,
} from "./bottomSheetHelpers.js";

export type SheetPresentation = "modal" | "modeless";

export interface BottomSheetProps {
  /** Monté/visible. false → démonté (modal) ou hors-vue translateY (modeless). */
  open: boolean;
  /** Demande de fermeture (Escape, backdrop, drag-dismiss, clic poignée). */
  onClose: () => void;
  /**
   * "modal"    → backdrop + useFocusTrap + Escape + role=dialog/aria-modal (S, A).
   * "modeless" → aucun backdrop, aucun trap, non bloquant (R, G).
   * Défaut: "modeless".
   */
  presentation?: SheetPresentation;
  /**
   * Monte la poignée grip.
   * Défaut: true en modal, false en modeless.
   */
  showHandle?: boolean;
  /** Active le drag-to-dismiss proportionnel. Défaut: = showHandle résolu. */
  dragDismiss?: boolean;
  /** Fraction de hauteur au-delà de laquelle on ferme. Défaut: 0.25. */
  dismissThreshold?: number;
  /** a11y: id du titre (aria-labelledby). Prend le dessus sur ariaLabel. */
  titleId?: string;
  /** a11y: label direct quand titleId n'est pas fourni. */
  ariaLabel?: string;
  /** Classe additionnelle sur le conteneur (style de contenu propre à la feature). */
  className?: string;
  /**
   * Élément déclencheur : reçoit le focus quand le sheet se ferme (AC8).
   * Non fourni → focus restauré sur document.activeElement au moment de l'ouverture.
   */
  triggerEl?: HTMLElement | null;
  /**
   * data-attributes additionnels exposés au CSS de la feature.
   * Clés sans préfixe "data-" : ex. { pose: "on" } → data-pose="on".
   */
  dataset?: Record<string, string>;
  /**
   * Contenu optionnel affiché à gauche de la poignée dans le header de la sheet.
   * Sur mobile (colonne) : rendu sous la poignée grip.
   * Sur desktop (ligne) : rendu à gauche du bouton ×.
   * N'a d'effet que si showHandle est résolu à true.
   */
  headerLeft?: React.ReactNode;
  children: React.ReactNode;
}

// Re-export helpers so consumers can import them without touching the CSS module.
export { resolveShowHandle, resolveDragDismiss, shouldDismissOnDrag } from "./bottomSheetHelpers.js";

export function BottomSheet({
  open,
  onClose,
  presentation = "modeless",
  showHandle,
  dragDismiss,
  dismissThreshold = 0.25,
  titleId,
  ariaLabel,
  className,
  triggerEl,
  dataset,
  headerLeft,
  children,
}: BottomSheetProps): React.ReactElement | null {
  const isModal = presentation === "modal";

  const resolvedShowHandle = resolveShowHandle(showHandle, presentation);
  const resolvedDragDismiss = resolveDragDismiss(dragDismiss, resolvedShowHandle);

  // Ref pour useFocusTrap (modal) et la mesure de hauteur (drag-dismiss).
  const sheetRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);

  // Drag state : startY en ref (pas de re-render), dy en state (translateY live).
  const dragStartYRef = useRef<number | null>(null);
  const [dragDy, setDragDy] = useState<number | null>(null);

  // Focus trap actif seulement en modal et quand ouvert.
  const { handleKeyDown } = useFocusTrap(
    sheetRef,
    isModal && open,
    onClose,
    triggerEl,
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (!resolvedDragDismiss) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragStartYRef.current = e.clientY;
    },
    [resolvedDragDismiss],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (dragStartYRef.current === null) return;
      const dy = e.clientY - dragStartYRef.current;
      setDragDy(Math.max(0, dy));
    },
    [],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (dragStartYRef.current === null) return;
      const dy = e.clientY - dragStartYRef.current;
      dragStartYRef.current = null;
      setDragDy(null);
      const height = sheetRef.current?.getBoundingClientRect().height ?? 200;
      if (shouldDismissOnDrag(dy, height, dismissThreshold)) onClose();
    },
    [dismissThreshold, onClose],
  );

  const handlePointerCancel = useCallback(() => {
    dragStartYRef.current = null;
    setDragDy(null);
  }, []);

  // Modal: démonté quand fermé (exit animation TBD si besoin en S1/S2).
  if (isModal && !open) return null;

  // data-attributes additionnels.
  const extraData: Record<string, string> = {};
  if (dataset) {
    for (const [k, v] of Object.entries(dataset)) {
      extraData[`data-${k}`] = v;
    }
  }

  return (
    <>
      {isModal && (
        <div
          className="lp-sheet__backdrop"
          aria-hidden="true"
          onClick={onClose}
        />
      )}
      <div
        ref={sheetRef}
        role={isModal ? "dialog" : undefined}
        aria-modal={isModal ? true : undefined}
        aria-labelledby={titleId}
        aria-label={titleId ? undefined : ariaLabel}
        data-open={open ? "true" : "false"}
        data-presentation={presentation}
        data-has-handle={resolvedShowHandle ? "true" : "false"}
        className={["lp-sheet", className].filter(Boolean).join(" ")}
        style={dragDy !== null ? ({ "--lp-sheet-drag-dy": `${dragDy}px` } as React.CSSProperties) : undefined}
        onKeyDown={isModal ? handleKeyDown : undefined}
        tabIndex={isModal ? -1 : undefined}
        {...extraData}
      >
        {resolvedShowHandle && (
          headerLeft != null ? (
            <div className="lp-sheet__header">
              <PanelHandle
                ref={handleRef}
                open={open}
                onToggle={onClose}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
              />
              <div className="lp-sheet__header-left">{headerLeft}</div>
            </div>
          ) : (
            <PanelHandle
              ref={handleRef}
              open={open}
              onToggle={onClose}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
            />
          )
        )}
        {children}
      </div>
    </>
  );
}
