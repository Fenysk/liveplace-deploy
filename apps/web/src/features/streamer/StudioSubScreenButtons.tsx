/**
 * FEN-1176 — S4 (Contrat F): navigation button that opens the create
 * sub-screen from inside the StudioPanel.
 *
 * Closes the panel first, then navigates to the create route.
 */
import { useTranslate } from "@canvas/i18n/react";
import { useNavigate } from "@tanstack/react-router";
import { buttonClass } from "../../ui/index.js";

export interface StudioSubScreenButtonsProps {
  /** Called before navigating so the parent panel closes. */
  onClose: () => void;
}

/**
 * Renders the studio create entry-point as a full-width button.
 * Consumed by StudioDashboardBody (S3) inside the panel.
 */
export function StudioSubScreenButtons({
  onClose,
}: StudioSubScreenButtonsProps): React.ReactElement {
  const t = useTranslate();
  const navigate = useNavigate();

  function goCreate(): void {
    onClose();
    void navigate({ to: "/studio/new" });
  }

  return (
    <div className="lp-studio-subscreen-btns">
      <button type="button" className={buttonClass("primary", "md")} onClick={goCreate}>
        + {t("studio.new")}
      </button>
    </div>
  );
}
