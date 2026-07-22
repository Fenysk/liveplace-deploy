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
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      presentation="modal"
      showHandle
      dragDismiss
      titleId={titleId}
      className="lp-studio-panel"
    >
      {children}
    </BottomSheet>
  );
}
