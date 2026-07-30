/**
 * Crisis "Actions récentes" undo list ([FEN-160], spec FEN-157 §4 Flow C). The
 * presentational shell over the pure {@link buildUndoList} projection: it renders
 * the reversible removals (`ban_wipe`/`delete`) newest-first, each with an
 * "Annuler cet effacement" affordance that asks the host to `restore` after the
 * overwrite forewarning. Convex-free — the host (DashboardPage) owns
 * `listAuditLog`/`restore` and supplies rows + the loading/error flags.
 *
 * a11y: a real list, keyboard-navigable, each restore announced once by the host
 * live-region (single announce per beat). ≥44px restore controls (Lot G tapFloor).
 * Relative time ("il y a 2 min") is locale-formatted here (like the dashboard's
 * archive dates), not a hard-coded string.
 */
import { useLocale, useTranslate } from "@canvas/i18n/react";
import { buildUndoList, type AuditRow } from "./crisisSelection.js";

export interface CrisisHistoryProps {
  /** Raw `moderation.listAuditLog` rows (host-fetched); `undefined` = still loading. */
  rows: readonly AuditRow[] | undefined;
  /** True when the audit query errored (`role=alert` retry copy). */
  isError?: boolean;
  /** Ids restored this session — their row reads "Restauré", action disabled (§4 idempotent). */
  restoredIds?: ReadonlySet<string>;
  /** The row whose `restore` is in flight (disables it — idempotency guard). */
  pendingId?: string | null;
  /** Ask the host to restore this audit action (after its confirm) → `moderation.restore`. */
  onRestore: (id: string) => void;
}

/** Locale relative time for an epoch-ms timestamp ("il y a 2 min" / "2 min ago"). */
function relativeTime(locale: string, fromMs: number, nowMs: number): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const diffSec = Math.round((fromMs - nowMs) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) return rtf.format(Math.round(diffSec), "second");
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
  return rtf.format(Math.round(diffSec / 86400), "day");
}

export function CrisisHistory(props: CrisisHistoryProps): React.ReactElement {
  const t = useTranslate();
  const locale = useLocale();
  const anonLabel = t("studio.crisis.ban.anonAuthor");
  const now = Date.now();

  const ready = props.rows !== undefined;
  const undo = ready ? buildUndoList(props.rows!, props.restoredIds ?? new Set(), anonLabel) : [];

  return (
    <section className="lp-crisis-history" aria-label={t("studio.crisis.history.title")} style={wrapStyle}>
      <h3 style={titleStyle}>{t("studio.crisis.history.title")}</h3>

      {props.isError ? (
        <p role="alert" style={errorStyle}>
          {t("studio.crisis.history.error")}
        </p>
      ) : !ready ? (
        // Skeleton rows while the audit log loads (spec §4 loading state).
        <ul style={listStyle} aria-hidden>
          {[0, 1].map((i) => (
            <li key={i} style={{ ...rowStyle, ...skeletonStyle }} />
          ))}
        </ul>
      ) : undo.length === 0 ? (
        <p style={emptyStyle}>{t("studio.crisis.history.empty")}</p>
      ) : (
        <ul style={listStyle}>
          {undo.map((row) => (
            <li key={row.id} style={rowStyle}>
              <span style={rowLabelStyle}>
                <span>{t(row.label.key, row.label.params)}</span>
                <span style={mutedStyle}>{relativeTime(locale, row.createdAt, now)}</span>
              </span>
              {row.restored ? (
                <span style={restoredBadgeStyle}>{t("studio.crisis.history.restored")}</span>
              ) : (
                <button
                  type="button"
                  className="lp-btn"
                  style={restoreBtnStyle}
                  disabled={props.pendingId === row.id}
                  onClick={() => props.onRestore(row.id)}
                >
                  {t("studio.crisis.restore")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// --- Inline styles (delegated visual pass; usable defaults only) -------------
const tapFloor: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 44,
};
const wrapStyle: React.CSSProperties = { display: "grid", gap: "0.5rem", marginTop: "0.75rem" };
const titleStyle: React.CSSProperties = { margin: 0, fontSize: 15 };
const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
};
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  padding: "0.5rem 0.7rem",
  border: "1px solid #ececf1",
  borderRadius: 9,
  background: "#fcfcfd",
};
const skeletonStyle: React.CSSProperties = {
  height: 44,
  background: "linear-gradient(90deg,#f1f1f4,#e8e8ee,#f1f1f4)",
  border: "1px solid #ececf1",
};
const rowLabelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 };
const mutedStyle: React.CSSProperties = { color: "#999", fontSize: 12 };
const emptyStyle: React.CSSProperties = { color: "#777", fontSize: 14, margin: 0 };
const errorStyle: React.CSSProperties = { color: "#a11", fontSize: 14, margin: 0 };
const restoreBtnStyle: React.CSSProperties = {
  ...tapFloor,
  minWidth: 44,
  padding: "0.35rem 0.9rem",
  borderRadius: 7,
  border: "1px solid #d4d4dc",
  background: "#fafafb",
  color: "#444",
  fontSize: 13,
  cursor: "pointer",
};
const restoredBadgeStyle: React.CSSProperties = {
  ...tapFloor,
  padding: "0 0.6rem",
  color: "#0a7d33",
  fontSize: 13,
  fontWeight: 600,
};
