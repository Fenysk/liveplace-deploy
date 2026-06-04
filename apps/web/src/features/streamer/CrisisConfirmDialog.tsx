/**
 * Crisis destructive-action confirm ([FEN-160], spec FEN-157 §2.4 / §3.3 / §4).
 * One small modal the ban / wipe / restore flows reuse: it NAMES the blast radius
 * (count line / large-area warning / overwrite forewarning) before commit, focus
 * moves onto the confirm on open, and Escape (or Annuler) backs out in one gesture
 * (forgiveness — Norman; acceptance §6.4). Copy comes through pure
 * `crisisSelection.ts` {@link CrisisAnnounce} descriptors resolved here via `t`.
 */
import { useEffect, useRef } from "react";
import { useTranslate } from "@canvas/i18n/react";
import type { MessageKey } from "@canvas/i18n";
import type { CrisisAnnounce } from "./crisisSelection.js";

export interface CrisisConfirmDialogProps {
  /** The headline question (e.g. ban.confirm / wipe.confirm / restore.confirm). */
  title: CrisisAnnounce;
  /** Extra lines under the title (blast-radius count, large-area warning, §2.5 reaffirm). */
  lines?: (CrisisAnnounce | null | undefined)[];
  /** Confirm button label key (`studio.crisis.ban` / `.wipe` / `.restore`). */
  confirmLabelKey: MessageKey;
  /** True while the dispatch is in flight — disables confirm (idempotency guard). */
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function CrisisConfirmDialog(props: CrisisConfirmDialogProps): React.ReactElement {
  const t = useTranslate();
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // Move focus onto the confirm on open; Escape always backs out (no-trap).
  useEffect(() => {
    confirmRef.current?.focus();
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") props.onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={backdropStyle}>
      <div role="alertdialog" aria-modal="true" aria-label={t(props.title.key, props.title.params)} style={cardStyle}>
        <p style={titleStyle}>{t(props.title.key, props.title.params)}</p>
        {(props.lines ?? []).filter(Boolean).map((line, i) => (
          <p key={i} style={lineStyle}>
            {t((line as CrisisAnnounce).key, (line as CrisisAnnounce).params)}
          </p>
        ))}
        <div style={actionsStyle}>
          <button type="button" style={cancelStyle} onClick={props.onCancel}>
            {t("studio.crisis.cancel")}
          </button>
          <button
            ref={confirmRef}
            type="button"
            style={confirmStyle}
            disabled={props.pending}
            onClick={props.onConfirm}
          >
            {t(props.confirmLabelKey)}
          </button>
        </div>
      </div>
    </div>
  );
}

const tapFloor: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 44,
};
const backdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  display: "grid",
  placeItems: "center",
  zIndex: 50,
  padding: "1rem",
};
const cardStyle: React.CSSProperties = {
  background: "#fff",
  borderRadius: 14,
  padding: "1.25rem",
  maxWidth: 420,
  width: "100%",
  display: "grid",
  gap: "0.6rem",
  boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
};
const titleStyle: React.CSSProperties = { margin: 0, fontWeight: 700, fontSize: 16 };
const lineStyle: React.CSSProperties = { margin: 0, color: "#555", fontSize: 14 };
const actionsStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  justifyContent: "flex-end",
  marginTop: "0.4rem",
  flexWrap: "wrap",
};
const cancelStyle: React.CSSProperties = {
  ...tapFloor,
  padding: "0.5rem 1.1rem",
  borderRadius: 8,
  border: "1px solid #c7c7d1",
  background: "#fff",
  color: "#333",
  fontWeight: 600,
  cursor: "pointer",
};
const confirmStyle: React.CSSProperties = {
  ...tapFloor,
  padding: "0.5rem 1.1rem",
  borderRadius: 8,
  border: "1px solid #b3261e",
  background: "#b3261e",
  color: "#fff",
  fontWeight: 700,
  cursor: "pointer",
};
