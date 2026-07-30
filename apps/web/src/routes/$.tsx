/**
 * OBS catch-all — `/{slug}/obs` browser-source paths (FEN-2100 T5).
 *
 * All multi-segment paths not claimed by a sibling route land here.
 * OBS paths (`/{slug}/obs`) render ObsViewLive; everything else throws
 * notFound() so __root notFoundComponent takes over.
 */
import { createFileRoute, notFound, useLocation } from "@tanstack/react-router";
import { isObsPath, parseObsView } from "../features/canvas/obs.js";
import { ObsViewLive } from "../features/canvas/ObsViewLive.js";
import "../features/canvas/canvas.css";

export const Route = createFileRoute("/$")({
  beforeLoad: ({ location }) => {
    if (!isObsPath(location.pathname)) throw notFound();
  },
  component: ObsCatchAllComponent,
});

function ObsCatchAllComponent() {
  // Router state (not window.location): reactive on client-side navigation.
  const { pathname, searchStr } = useLocation();
  const { slug } = parseObsView(pathname, searchStr);
  return <ObsViewLive slug={slug} />;
}
