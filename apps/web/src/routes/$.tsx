/**
 * OBS catch-all — `/{slug}/obs` browser-source paths (FEN-2100 T5).
 *
 * All multi-segment paths not claimed by a sibling route land here.
 * OBS paths (`/{slug}/obs`) render ObsViewLive; everything else throws
 * notFound() so __root notFoundComponent takes over.
 */
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { isObsPath, parseObsView } from "../features/canvas/obs.js";
import "../features/canvas/canvas.css";

const ObsViewLive = lazy(() =>
  import("../features/canvas/ObsViewLive.js").then((m) => ({
    default: m.ObsViewLive,
  })),
);

export const Route = createFileRoute("/$")({
  beforeLoad: ({ location }) => {
    if (!isObsPath(location.pathname)) throw notFound();
  },
  component: ObsCatchAllComponent,
});

function ObsCatchAllComponent() {
  const { slug } = parseObsView(window.location.pathname, window.location.search);
  return (
    <Suspense>
      <ObsViewLive slug={slug} />
    </Suspense>
  );
}
