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
 * `t(...)` (FR↔EN).
 */
import { useRef, useState } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useTranslate } from "@canvas/i18n/react";
import { Link } from "../../router.js";
import { paths } from "../../routes.js";
import { BROADCAST_STEP_KEYS, buildObsUrl } from "./studioView.js";

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
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);

  const obsUrl = buildObsUrl(currentOrigin(), slug);

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

  if (canvas === undefined) {
    return (
      <section style={pageStyle} aria-busy>
        <p style={mutedStyle}>{t("common.loading")}</p>
      </section>
    );
  }

  if (canvas === null) {
    return (
      <section style={pageStyle}>
        <h1 style={titleStyle}>{t("studio.broadcast.title")}</h1>
        <p style={mutedStyle}>{t("studio.broadcast.notFound")}</p>
        <Link to={paths.studio()} style={linkStyle}>
          {t("studio.broadcast.back")}
        </Link>
      </section>
    );
  }

  return (
    <section style={pageStyle} aria-label={t("studio.broadcast.title")}>
      <h1 style={titleStyle}>{t("studio.broadcast.title")}</h1>
      <p style={subtitleStyle}>{t("studio.broadcast.subtitle")}</p>

      {/* The URL + one-tap copy — the single most important thing on the screen. */}
      <label htmlFor="obs-url" style={labelStyle}>
        {t("studio.broadcast.urlLabel")}
      </label>
      <div style={urlRowStyle}>
        <input
          id="obs-url"
          ref={urlRef}
          type="text"
          readOnly
          value={obsUrl}
          style={urlInputStyle}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button type="button" onClick={() => void copy()} style={copyBtnStyle}>
          {copied ? t("studio.broadcast.copied") : t("studio.broadcast.copy")}
        </button>
      </div>
      {copyFailed && (
        <p role="status" aria-live="polite" style={copyHintStyle}>
          {t("studio.broadcast.copyManual")}
        </p>
      )}

      {/* Three numbered steps. */}
      <ol style={stepsStyle}>
        {BROADCAST_STEP_KEYS.map((key) => (
          <li key={key} style={stepStyle}>
            {t(key)}
          </li>
        ))}
      </ol>

      {/* Self-check (WF-7 checklist). */}
      <p style={checkStyle}>✓ {t("studio.broadcast.checklist")}</p>

      <p>
        <a href={obsUrl} target="_blank" rel="noreferrer" style={linkStyle}>
          {t("studio.broadcast.preview")} ↗
        </a>
      </p>

      <details style={detailsStyle}>
        <summary style={summaryStyle}>{t("studio.broadcast.advanced")}</summary>
        <p style={mutedStyle}>{t("studio.broadcast.advancedBody")}</p>
      </details>

      <Link to={paths.studio()} style={linkStyle}>
        {t("studio.broadcast.back")}
      </Link>
    </section>
  );
}

// --- Inline styles (delegated visual pass) -----------------------------------
const pageStyle: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  maxWidth: 600,
  margin: "2.5rem auto",
  padding: "0 1rem",
};
const titleStyle: React.CSSProperties = { margin: "0 0 0.35rem" };
const subtitleStyle: React.CSSProperties = { color: "#666", margin: "0 0 1.75rem" };
const labelStyle: React.CSSProperties = { display: "block", fontWeight: 600, marginBottom: "0.4rem" };
const mutedStyle: React.CSSProperties = { color: "#777" };
const urlRowStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  marginBottom: "1.5rem",
};
const copyHintStyle: React.CSSProperties = {
  color: "#8a5a00",
  background: "#fff6e5",
  border: "1px solid #f0d9a8",
  borderRadius: 8,
  padding: "0.5rem 0.75rem",
  margin: "-1rem 0 1.5rem",
  fontSize: 14,
};
const urlInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "0.6rem 0.75rem",
  fontSize: 15,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  borderRadius: 8,
  border: "1px solid #c7c7d1",
  background: "#f7f7fa",
};
const copyBtnStyle: React.CSSProperties = {
  padding: "0.6rem 1.2rem",
  borderRadius: 8,
  border: "1px solid #6441a5",
  background: "#6441a5",
  color: "#fff",
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};
const stepsStyle: React.CSSProperties = {
  margin: "0 0 1.25rem",
  paddingLeft: "1.4rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
  lineHeight: 1.4,
};
const stepStyle: React.CSSProperties = { paddingLeft: "0.25rem" };
const checkStyle: React.CSSProperties = {
  color: "#0a7d33",
  fontWeight: 600,
  margin: "0 0 1.5rem",
};
const detailsStyle: React.CSSProperties = {
  border: "1px solid #ececf1",
  borderRadius: 10,
  padding: "0.5rem 0.85rem",
  margin: "0 0 1.5rem",
};
const summaryStyle: React.CSSProperties = { cursor: "pointer", fontWeight: 600, padding: "0.35rem 0" };
const linkStyle: React.CSSProperties = { color: "#6441a5", textDecoration: "none" };
