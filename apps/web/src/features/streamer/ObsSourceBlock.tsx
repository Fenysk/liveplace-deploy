/**
 * Pure OBS URL block — label + read-only URL input + one-tap Copy + failure
 * toast. Extracted as a standalone component so Stream B (sheet) and Stream C
 * (route page) can both embed it without duplicating copy logic (FEN-1216 /
 * Stream A contract).
 *
 * No Convex. The caller owns data-fetching; this component only renders what
 * it receives. CSS lives in studio.css (already shared).
 */
import { useRef, useState } from "react";
import { useTranslate } from "@canvas/i18n/react";
import { Button, Toast } from "../../ui/index.js";
import { copyObsUrl } from "./obsSourceBlock.js";
import "./studio.css";

/**
 * Renders the OBS browser-source URL with a one-tap Copy button and a
 * failure toast. Pure presentation — no Convex, no routing.
 *
 * Contract frozen by FEN-1216 (Stream A): callers pass only `obsUrl`.
 */
export function ObsSourceBlock({ obsUrl }: { obsUrl: string }): React.ReactElement {
  const t = useTranslate();
  const urlRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function copy(): Promise<void> {
    const result = await copyObsUrl(obsUrl, {
      selectInput: () => urlRef.current?.select(),
    });
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
      <label htmlFor="obs-url" className="lp-studio__field-label">
        {t("studio.broadcast.urlLabel")}
      </label>
      <div className="lp-studio__url-row">
        <input
          id="obs-url"
          ref={urlRef}
          type="text"
          readOnly
          value={obsUrl}
          className="lp-studio__url-input"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button onClick={() => void copy()}>
          {copied ? t("studio.broadcast.copied") : t("studio.broadcast.copy")}
        </Button>
      </div>
      {copyFailed && (
        <div role="status" aria-live="polite">
          <Toast kind="info" title={t("studio.broadcast.copyManual")} />
        </div>
      )}
    </>
  );
}
