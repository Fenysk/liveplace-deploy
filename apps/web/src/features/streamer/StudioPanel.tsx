import { useTranslate } from "@canvas/i18n/react";
import { BottomSheet } from "../../ui/BottomSheet.js";
import "./studioPanel.css";

export interface StudioPanelProps {
  open: boolean;
  onClose: () => void;
  /** ID of the heading element that labels this dialog (aria-labelledby). */
  titleId?: string;
  children: React.ReactNode;
}

export function StudioPanel({
  open,
  onClose,
  titleId,
  children,
}: StudioPanelProps): React.ReactElement | null {
  const t = useTranslate();
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      presentation="modal"
      desktop="drawer"
      showHandle
      dragDismiss
      titleId={titleId}
      className="lp-studio-panel"
    >
      <button
        type="button"
        className="lp-studio-panel__close"
        aria-label={t("studio.panel.close")}
        onClick={onClose}
      >
        ×
      </button>
      {children}
    </BottomSheet>
  );
}
