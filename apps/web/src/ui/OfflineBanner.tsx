/**
 * Non-blocking offline reconnection banner (G9, FEN-622, AC6).
 *
 * Sits fixed at the top of the viewport, ON TOP of the live canvas, without
 * blocking pointer events on the canvas below. Uses `role="status"` +
 * `aria-live="polite"` so the transition is announced once, quietly.
 *
 * Two states:
 *   - default: amber dot + spinner, "Reconnecting…" — auto-retry in progress.
 *   - failed (`failed=true`): after N retries, "Connection unstable" +
 *     "Reload" button so the user has an explicit escape hatch.
 *
 * The outer wrapper is `pointer-events: none` so the canvas stays interactive.
 * Only the Reload button re-enables pointer events.
 */
import type { ReactElement } from "react";

export interface OfflineBannerProps {
  /** True after N reconnection attempts — shows stable-failure copy + Reload. */
  failed?: boolean;
  /** Label for the "Reconnecting…" state. */
  titleReconnecting: string;
  /** Label for the "Connection unstable" state. */
  titleFailed: string;
  /** Reload button label. */
  labelReload: string;
}

export function OfflineBanner({
  failed = false,
  titleReconnecting,
  titleFailed,
  labelReload,
}: OfflineBannerProps): ReactElement {
  return (
    <div className="ui-offline-banner-wrap" aria-live="polite" role="status">
      <div className={`ui-offline-banner${failed ? " ui-offline-banner--failed" : ""}`}>
        <span className="ui-offline-banner__dot" aria-hidden="true" />
        <span className="ui-offline-banner__label">
          {failed ? titleFailed : titleReconnecting}
        </span>
        {failed && (
          <button
            type="button"
            className="ui-offline-banner__reload"
            onClick={() => window.location.reload()}
          >
            {labelReload}
          </button>
        )}
      </div>
    </div>
  );
}
