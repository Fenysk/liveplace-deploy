import type { ReactElement, ReactNode } from "react";
import { toastClass, toastIcon, type ToastKind } from "./variants.js";

/**
 * Toast (handoff §3.1) — success/info/error, with an icon + title so the kind is
 * never signalled by colour alone (AA). `role="status"`/`alert` makes it
 * announced. The host screen owns placement/auto-dismiss; this is the surface.
 */
export interface ToastProps {
  kind?: ToastKind;
  title: string;
  children?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
}

export function Toast({
  kind = "info",
  title,
  children,
  onClose,
  closeLabel = "Fermer",
}: ToastProps): ReactElement {
  return (
    <div className={toastClass(kind)} role={kind === "error" ? "alert" : "status"}>
      <span className="ui-toast__icon" aria-hidden="true">
        {toastIcon(kind)}
      </span>
      <div className="ui-toast__body">
        <span className="ui-toast__title">{title}</span>
        {children && <span className="ui-toast__msg">{children}</span>}
      </div>
      {onClose && (
        <button
          type="button"
          className="ui-toast__close"
          onClick={onClose}
          aria-label={closeLabel}
        >
          ✕
        </button>
      )}
    </div>
  );
}
