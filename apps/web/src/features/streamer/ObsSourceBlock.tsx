/**
 * Pure OBS URL block — label + unified copy box (FEN-1669). Extracted as a
 * standalone component so Stream B (sheet) and Stream C (route page) can both
 * embed it without duplicating copy logic (FEN-1216 / Stream A contract).
 *
 * No Convex. The caller owns data-fetching; this component only renders what
 * it receives. CSS lives in studio.css (already shared).
 */
import { useState } from "react";
import { useTranslate } from "@canvas/i18n/react";
import { Toast } from "../../ui/index.js";
import { copyObsUrl } from "./obsSourceBlock.js";
import "./studio.css";

function IconCopy(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5" y="1" width="9" height="11" stroke="currentColor" strokeWidth="2"/>
      <rect x="1" y="4" width="9" height="11" fill="var(--ui-surface, white)" stroke="currentColor" strokeWidth="2"/>
    </svg>
  );
}

function IconCheck(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.5 8.5L5.5 12.5L14 4.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="square"/>
    </svg>
  );
}

/**
 * Renders the OBS browser-source URL as a unified neobrutalism box: URL text
 * truncated on the left, copy icon on the right. Clicking anywhere copies the
 * URL and shows a "Copied" visual + SR announcement.
 *
 * Contract frozen by FEN-1216 (Stream A): callers pass only `obsUrl`.
 */
export function ObsSourceBlock({ obsUrl }: { obsUrl: string }): React.ReactElement {
  const t = useTranslate();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function copy(): Promise<void> {
    const result = await copyObsUrl(obsUrl);
    if (result === "copied") {
      setCopied(true);
      setCopyFailed(false);
      window.setTimeout(() => setCopied(false), 2000);
    } else {
      setCopied(false);
      setCopyFailed(true);
    }
  }

  return (
    <>
      <p className="lp-studio__field-label">{t("studio.broadcast.urlLabel")}</p>
      <button
        type="button"
        className={`lp-studio__url-box${copied ? " lp-studio__url-box--copied" : ""}`}
        onClick={() => void copy()}
        aria-label={`${t("studio.broadcast.copy")} : ${obsUrl}`}
        title={obsUrl}
      >
        <span className="lp-studio__url-box-text">{obsUrl}</span>
        <span className="lp-studio__url-box-icon" aria-hidden="true">
          {copied ? <IconCheck /> : <IconCopy />}
        </span>
      </button>
      <span className="ui-sr-only" aria-live="polite" aria-atomic="true">
        {copied ? t("studio.broadcast.copied") : ""}
      </span>
      {copyFailed && (
        <div role="status" aria-live="polite">
          <Toast kind="info" title={t("studio.broadcast.copyManual")} />
        </div>
      )}
    </>
  );
}
