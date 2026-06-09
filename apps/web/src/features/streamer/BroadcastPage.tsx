/**
 * Diffuser — get a canvas into OBS in under 2 minutes (FEN-120 / WF-7, flow S2,
 * F10). A first-class, self-contained screen (NOT buried in config): the
 * read-only browser-source URL with one-tap Copy, the three numbered OBS steps,
 * and a self-check ("you should see your canvas appear"). Advanced framing
 * (background/grid/zoom/crop — all parsed by features/canvas/obs.ts) is folded
 * away as secondary.
 *
 * The OBS URL is built by the pure `buildObsUrl` (studioView.ts, unit-tested)
 * from the live origin + slug, so it matches whatever host the app is served
 * from. `getCanvasBySlug` (referenced by name) confirms the canvas exists, so a
 * stale link shows a clean not-found rather than a dead OBS source. Strings via
 * `t(...)` (FR↔EN). The look is the Arcade design system (FEN-268): shared Button
 * / Toast, tokens only — no hard-coded value or local component (FEN-271, Lot C).
 */
import { useRef, useState } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useTranslate } from "@canvas/i18n/react";
import { Link } from "../../router.js";
import { paths } from "../../routes.js";
import { Button, Toast } from "../../ui/index.js";
import { BROADCAST_STEP_KEYS, buildObsUrl } from "./studioView.js";
import "./studio.css";

interface CanvasDoc {
  slug: string;
  title: string;
}
const getCanvasBySlug = makeFunctionReference<"query", { slug: string }, CanvasDoc | null>(
  "canvases:getCanvasBySlug",
);

/** Origin the app is served from; OBS needs an absolute URL. */
function currentOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "";
}

export function BroadcastPage({ slug }: { slug: string }): React.ReactElement {
  const t = useTranslate();
  const canvas = useQuery(getCanvasBySlug, { slug });

  const obsUrl = buildObsUrl(currentOrigin(), slug);

  if (canvas === undefined) {
    return (
      <section className="lp-studio lp-studio--narrow" aria-busy>
        <p className="lp-studio__muted">{t("common.loading")}</p>
      </section>
    );
  }

  if (canvas === null) {
    return (
      <section className="lp-studio lp-studio--narrow">
        <h1 className="lp-studio__title">{t("studio.broadcast.title")}</h1>
        <p className="lp-studio__muted">{t("studio.broadcast.notFound")}</p>
        <Link to={paths.studio()} className="lp-studio__link">
          {t("studio.broadcast.back")}
        </Link>
      </section>
    );
  }

  return <BroadcastView obsUrl={obsUrl} />;
}

/**
 * Presentation only — the Diffuser screen body for a known OBS URL. Split out of
 * the data wrapper so it can be rendered with a mock URL on the QA states board
 * (FEN-276) without a Convex session, the same view/data split as the dashboard.
 */
export function BroadcastView({ obsUrl }: { obsUrl: string }): React.ReactElement {
  const t = useTranslate();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(obsUrl);
      setCopied(true);
      setCopyFailed(false);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context / permission). Don't fail silently
      // (S4 / FEN-143): pre-select the field so a manual Ctrl/⌘+C is one keypress
      // away, and surface a visible + announced "copy by hand" hint. The < 2-min
      // goal hinges on the streamer KNOWING the copy didn't take.
      urlRef.current?.select();
      setCopied(false);
      setCopyFailed(true);
    }
  }

  return (
    <section className="lp-studio lp-studio--narrow" aria-label={t("studio.broadcast.title")}>
      <h1 className="lp-studio__title">{t("studio.broadcast.title")}</h1>
      <p className="lp-studio__subtitle">{t("studio.broadcast.subtitle")}</p>

      {/* The URL + one-tap copy — the single most important thing on the screen. */}
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

      {/* Three numbered steps. */}
      <ol className="lp-studio__steps">
        {BROADCAST_STEP_KEYS.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ol>

      {/* Self-check (WF-7 checklist). */}
      <p className="lp-studio__check">
        <span aria-hidden>✓</span> {t("studio.broadcast.checklist")}
      </p>

      <p>
        <a
          href={obsUrl}
          target="_blank"
          rel="noreferrer"
          className="lp-studio__link"
        >
          {t("studio.broadcast.preview")} ↗
        </a>
      </p>

      <details className="lp-studio__details">
        <summary className="lp-studio__summary">{t("studio.broadcast.advanced")}</summary>
        <p className="lp-studio__muted">{t("studio.broadcast.advancedBody")}</p>
      </details>

      <Link to={paths.studio()} className="lp-studio__link">
        {t("studio.broadcast.back")}
      </Link>
    </section>
  );
}
