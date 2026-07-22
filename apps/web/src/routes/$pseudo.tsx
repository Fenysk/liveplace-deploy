/**
 * Canvas hero route — `/$pseudo` (FEN-2097 T2).
 *
 * beforeLoad validates the segment (Twitch format, not reserved) and throws
 * notFound() so TanStack can render the nearest notFoundComponent.
 *
 * resolveRenderMode + useObsLateDetect run synchronously in the component body
 * (R2 — never in an async loader, preserves anti-flash contract FEN-1417/1427/1432).
 */
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { useTranslate } from "@canvas/i18n/react";
import { isPseudoSegment, normalizePseudo } from "../routes.js";
import { resolveRenderMode } from "../features/canvas/renderMode.js";
import { useObsLateDetect } from "../features/canvas/useObsLateDetect.js";
import "../features/canvas/canvas.css";

const CanvasViewLive = lazy(() =>
  import("../features/canvas/CanvasViewLive.js").then((m) => ({
    default: m.CanvasViewLive,
  })),
);
const ObsViewLive = lazy(() =>
  import("../features/canvas/ObsViewLive.js").then((m) => ({
    default: m.ObsViewLive,
  })),
);

export const Route = createFileRoute("/$pseudo")({
  beforeLoad: ({ params }) => {
    const normalized = normalizePseudo(params.pseudo);
    if (!isPseudoSegment(normalized)) throw notFound();
  },
  component: PseudoRouteComponent,
});

function PseudoRouteComponent() {
  const { pseudo } = Route.useParams();
  const slug = normalizePseudo(pseudo);
  const t = useTranslate();

  // R2: resolveRenderMode synchronous in component body, never in a loader.
  const search = window.location.search;
  const mode = resolveRenderMode({
    pathname: window.location.pathname,
    search,
    userAgent: navigator.userAgent,
    hasObsStudio: typeof window.obsstudio !== "undefined",
  });
  const obsParam = new URLSearchParams(search).get("obs");
  const forceNormal = obsParam === "0" || obsParam === "false";

  // Late-OBS detection probe: hooks must be unconditional, probe is harmless when
  // mode is already "obs" (stops within 500 ms, ~30 rAF ticks).
  const obsLate = useObsLateDetect();

  const renderObs = mode === "obs" || (!forceNormal && obsLate);

  return (
    <Suspense fallback={<p className="route-loading">{t("common.loading")}</p>}>
      {renderObs ? (
        <ObsViewLive slug={slug} />
      ) : (
        <CanvasViewLive slug={slug} />
      )}
    </Suspense>
  );
}
