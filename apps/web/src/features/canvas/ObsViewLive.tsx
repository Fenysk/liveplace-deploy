/**
 * Convex-aware wrapper for ObsView (FEN-1432).
 *
 * Validates that the canvas slug exists via Convex before opening the WS
 * connection. Without this guard ObsView always connects to `/ws` (the
 * gateway's single endpoint, which serves the default canvas regardless of
 * slug), so any unknown slug silently showed another streamer's canvas.
 *
 * Null slug = bare `/obs` default canvas — no validation needed.
 *
 * FEN-1467: when the canvas is not found (slug unknown or canvas not yet
 * created), renders a discreet centred message on a transparent background
 * instead of a blank source.
 */
import { useEffect } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useTranslate } from "@canvas/i18n/react";
import { ObsView } from "./ObsView.js";

/** Same query reference as in CanvasViewLive — public, no auth required. */
const getCanvasBySlugRef = makeFunctionReference<
  "query",
  { slug: string },
  { _id: string } | null
>("canvases:getCanvasBySlug");

export interface ObsViewLiveProps {
  /** Canvas slug to validate before connecting. `null` / omitted = default canvas (bare /obs). */
  slug?: string | null;
}

export function ObsViewLive({ slug = null }: ObsViewLiveProps = {}): React.ReactElement {
  if (!slug) {
    // Bare /obs route — default canvas, no Convex validation needed.
    return <ObsView />;
  }
  return <ObsViewLiveSlug slug={slug} />;
}

/**
 * Validates the slug via Convex before mounting ObsView.
 *
 * While loading → transparent placeholder (no WS connection).
 * Canvas not found (unknown slug or not yet created) → discreet centred
 * message on transparent background (FEN-1467: both cases covered).
 * Canvas found → renders ObsView normally.
 */
function ObsViewLiveSlug({ slug }: { slug: string }): React.ReactElement {
  const t = useTranslate();
  const canvas = useQuery(getCanvasBySlugRef, { slug });

  // Apply transparent page background for OBS compositing when the canvas is
  // absent (loading or not found). ObsView handles this itself when the canvas
  // exists; here we cover the unavailable states so OBS compositing is correct
  // from the first frame.
  useEffect(() => {
    if (canvas !== undefined && canvas !== null) return;
    const root = document.documentElement;
    root.classList.add("lp-obs-root");
    return () => root.classList.remove("lp-obs-root");
  }, [canvas]);

  // Still loading — transparent placeholder; no WS connection opened yet.
  if (canvas === undefined) {
    return <div className="lp-obs" />;
  }

  // Canvas not found (unknown slug or streamer hasn't created it yet):
  // show a discreet centred message on a transparent background (FEN-1467).
  if (canvas === null) {
    return (
      <div className="lp-obs lp-obs--unavailable">
        <p className="lp-obs-unavailable-msg">{t("obs.canvas.unavailable")}</p>
      </div>
    );
  }

  return <ObsView slug={slug} />;
}
