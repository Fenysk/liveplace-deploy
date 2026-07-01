import { useCallback, useEffect, useRef } from "react";

const FOCUSABLE_SEL =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Reusable focus-trap hook for modal dialogs.
 *
 * - Moves focus into `containerRef` when `open` becomes true.
 * - Returns focus to the element that was active at open time (or `triggerEl`
 *   if provided) when `open` becomes false.
 * - Listens for Escape and calls `onClose`.
 * - Returns `handleKeyDown` to wire onto the container for Tab cycling.
 */
export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
  triggerEl?: HTMLElement | null,
): { handleKeyDown: (e: React.KeyboardEvent) => void } {
  const savedFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      savedFocusRef.current =
        triggerEl !== undefined
          ? triggerEl
          : (document.activeElement as HTMLElement | null);
      containerRef.current?.focus();
    } else {
      const target =
        triggerEl !== undefined ? triggerEl : savedFocusRef.current;
      target?.focus();
      savedFocusRef.current = null;
    }
  }, [open, triggerEl, containerRef]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key !== "Tab") return;
      const el = containerRef.current;
      if (!el) return;
      const focusable = Array.from(
        el.querySelectorAll<HTMLElement>(FOCUSABLE_SEL),
      ).filter((n) => n.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [containerRef],
  );

  return { handleKeyDown };
}
